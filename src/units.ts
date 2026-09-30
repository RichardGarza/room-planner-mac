import { create } from 'zustand'

/** The unit lengths are shown and typed in. Data is always centimetres. */
export type Unit = 'cm' | 'in'

const KEY = 'room-planner.unit'
export const CM_PER_IN = 2.54

function loadUnit(): Unit {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'cm' || saved === 'in') return saved
    const locale = typeof navigator !== 'undefined' ? navigator.language : ''
    return /^en-(US|LR|MM)/i.test(locale) ? 'in' : 'cm'
  } catch {
    return 'cm'
  }
}

interface UnitsState {
  unit: Unit
  setUnit: (u: Unit) => void
  toggle: () => void
}

export const useUnits = create<UnitsState>((set, get) => ({
  unit: loadUnit(),
  setUnit: (unit) => {
    try { localStorage.setItem(KEY, unit) } catch { /* ignore */ }
    set({ unit })
  },
  toggle: () => get().setUnit(get().unit === 'cm' ? 'in' : 'cm'),
}))

/** Current unit outside React (checks, plan labels). */
export const currentUnit = () => useUnits.getState().unit

/**
 * Inches as "53½" — whole numbers stay whole, halves shown as a fraction.
 * Half-inch precision matches the app's 1 cm storage: a value typed as 16 in,
 * stored as 41 cm, comes back as 16, not 16¼.
 */
export function inchesText(inches: number): string {
  const q = Math.round(inches * 2) / 2
  const whole = Math.floor(q)
  const frac = q - whole
  if (frac === 0) return `${whole}`
  return whole === 0 ? '½' : `${whole}½`
}

/** "11′ 9″" for lengths of 3 ft and more, plain inches below that. */
export function feetInchesText(inches: number): string {
  const q = Math.round(inches * 2) / 2
  if (q < 36) return `${inchesText(q)}″`
  let ft = Math.floor(q / 12)
  let rest = q - ft * 12
  if (rest >= 11.75) { ft += 1; rest = 0 }
  return rest === 0 ? `${ft}′` : `${ft}′ ${inchesText(rest)}″`
}

export interface FormatOptions {
  unit?: Unit
  /** use feet-and-inches for long distances (room sizes, wall distances) */
  feet?: boolean
  /** omit the unit suffix (for compact labels where the unit is implied) */
  bare?: boolean
}

/** Format a length stored in cm for display. */
export function formatLength(cm: number, opts: FormatOptions = {}): string {
  const unit = opts.unit ?? currentUnit()
  if (unit === 'cm') {
    const v = Math.round(cm)
    return opts.bare ? `${v}` : `${v} cm`
  }
  const inches = cm / CM_PER_IN
  if (opts.feet) return feetInchesText(inches)
  const t = inchesText(inches)
  return opts.bare ? t : `${t} in`
}

/** "54 × 30 × 35 in" / "137 × 76 × 89 cm" (height optional; `bare` drops the unit, `compact` drops the spaces: "54×30×35"). */
export function formatSize(w: number, d: number, h?: number, opts: FormatOptions & { compact?: boolean } = {}): string {
  const unit = opts.unit ?? currentUnit()
  const parts = [w, d, ...(h === undefined ? [] : [h])].map((v) => formatLength(v, { unit, bare: true }))
  const joined = parts.join(opts.compact ? '×' : ' × ')
  return opts.bare ? joined : `${joined} ${unit}`
}

/** Room size for titles: "11′ 9″ × 9′ 8″" or "358 × 295 cm". */
export function formatRoomSize(w: number, d: number, opts: FormatOptions = {}): string {
  const unit = opts.unit ?? currentUnit()
  if (unit === 'cm') return `${Math.round(w)} × ${Math.round(d)} cm`
  return `${formatLength(w, { unit, feet: true })} × ${formatLength(d, { unit, feet: true })}`
}

/** Room size with its height: "11′ 9″ × 9′ 8″ × 8′" or "358 × 295 × 244 cm". */
export function formatRoomDims(w: number, d: number, h: number, opts: FormatOptions = {}): string {
  const unit = opts.unit ?? currentUnit()
  if (unit === 'cm') return formatSize(w, d, h, { unit })
  return `${formatRoomSize(w, d, { unit })} × ${formatLength(h, { unit, feet: true })}`
}

/** Convert cm to the number a user would type in the given unit (inches to the nearest half). */
export function toUnitNumber(cm: number, unit: Unit = currentUnit()): number {
  if (unit === 'cm') return Math.round(cm)
  return Math.round((cm / CM_PER_IN) * 2) / 2
}

/**
 * Parse what a person typed into a length in cm. Accepts a bare number (in `unit`),
 * inches (150 in, 150", 150 inches, 6 1/2", 6.5in), feet (12', 12 ft, 12 feet),
 * feet and inches (12' 6", 12'6, 12 ft 6 in, 12ft6 1/2in), and metric (150 cm, 1.5 m, 1500 mm).
 * Returns null when it cannot be read.
 */
export function parseLength(input: string, unit: Unit = currentUnit()): number | null {
  let s = input.trim().toLowerCase()
  if (!s) return null
  s = s.replace(/[′’]/g, "'").replace(/[″”]/g, '"').replace(/,/g, '.').replace(/\s+/g, ' ')

  const num = String.raw`(\d+(?:\.\d+)?(?:\s+\d+\/\d+)?|\d+\/\d+|\.\d+)`
  const value = (t: string) => {
    const parts = t.trim().split(' ')
    let total = 0
    for (const p of parts) {
      if (p.includes('/')) {
        const [a, b] = p.split('/').map(Number)
        if (!b) return NaN
        total += a / b
      } else total += Number(p)
    }
    return total
  }

  // feet and inches: 12' 6", 12 ft 6 in, 12'6, 12ft 6 1/2 in
  let m = s.match(new RegExp(String.raw`^${num}\s*(?:'|ft|feet|foot)\s*(?:${num}\s*(?:"|in|inch|inches)?)?$`))
  if (m) {
    const ft = value(m[1])
    const inches = m[2] ? value(m[2]) : 0
    if (Number.isNaN(ft) || Number.isNaN(inches)) return null
    return (ft * 12 + inches) * CM_PER_IN
  }
  // inches only
  m = s.match(new RegExp(String.raw`^${num}\s*(?:"|in|inch|inches)$`))
  if (m) {
    const v = value(m[1])
    return Number.isNaN(v) ? null : v * CM_PER_IN
  }
  // metric
  m = s.match(new RegExp(String.raw`^${num}\s*(mm|cm|m|meter|meters|metre|metres)$`))
  if (m) {
    const v = value(m[1])
    if (Number.isNaN(v)) return null
    const u = m[2]
    return u === 'mm' ? v / 10 : u === 'cm' ? v : v * 100
  }
  // bare number in the current unit
  m = s.match(new RegExp(String.raw`^${num}$`))
  if (m) {
    const v = value(m[1])
    if (Number.isNaN(v)) return null
    return unit === 'in' ? v * CM_PER_IN : v
  }
  return null
}

/**
 * Parse a size typed as "width × depth" or "width × depth × height": the parts separated by ×, x, *
 * or "by", each read like parseLength (so 41 x 39, 3' 5" × 3' 3" and 104 x 99 cm all work;
 * a unit written on the last part only applies to all of them). Null when it cannot be read.
 */
export function parseSize(input: string, unit: Unit = currentUnit()): { w: number; d: number; h?: number } | null {
  // every separator becomes an "x" (no length unit has an x in it, so splitting on x is safe);
  // no lookbehind here: older WebKit (macOS 12) cannot parse it and the whole app would fail to load
  const parts = input.trim().toLowerCase().replace(/[×*]/g, 'x').replace(/\bby\b/g, 'x').split('x').map((p) => p.trim()).filter(Boolean)
  if (parts.length < 2 || parts.length > 3) return null
  // "104 x 99 cm": the last part's unit counts for the bare numbers before it
  const trailing = parts[parts.length - 1].match(/(mm|cm|m|in|inch|inches|ft|feet|")$/)?.[1]
  const read = (p: string) => {
    const bare = /^\d+([.,]\d+)?$/.test(p)
    return parseLength(bare && trailing ? `${p} ${trailing}` : p, unit)
  }
  const [w, d, h] = parts.map(read)
  if (w === null || d === null || w <= 0 || d <= 0) return null
  if (parts.length === 3 && (h === null || h === undefined || h <= 0)) return null
  return parts.length === 3 ? { w, d, h: h! } : { w, d }
}
