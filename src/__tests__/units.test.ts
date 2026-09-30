import { describe, expect, it } from 'vitest'
import { feetInchesText, formatLength, formatRoomDims, formatRoomSize, formatSize, inchesText, parseLength, toUnitNumber } from '../units'

const cm = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100)

describe('parseLength', () => {
  it('reads bare numbers in the current unit', () => {
    expect(cm(parseLength('150', 'cm'))).toBe(150)
    expect(cm(parseLength('150', 'in'))).toBe(381)
    expect(cm(parseLength(' 12.5 ', 'in'))).toBe(31.75)
  })
  it('reads inches with any spelling', () => {
    for (const t of ['150 in', '150in', '150"', '150 inches', '150 inch', '150″']) expect(cm(parseLength(t, 'cm'))).toBe(381)
    expect(cm(parseLength('6 1/2"', 'cm'))).toBe(16.51)
    expect(cm(parseLength('1/2 in', 'cm'))).toBe(1.27)
  })
  it('reads feet and feet-inches', () => {
    expect(cm(parseLength("12'", 'cm'))).toBe(365.76)
    expect(cm(parseLength('12 ft', 'cm'))).toBe(365.76)
    expect(cm(parseLength('12 feet', 'cm'))).toBe(365.76)
    expect(cm(parseLength('12\' 6"', 'cm'))).toBe(381)
    expect(cm(parseLength("12'6", 'cm'))).toBe(381)
    expect(cm(parseLength('12 ft 6 in', 'cm'))).toBe(381)
    expect(cm(parseLength('12ft6in', 'cm'))).toBe(381)
    expect(cm(parseLength('12′ 6½″'.replace('½', ' 1/2'), 'cm'))).toBe(382.27)
    expect(cm(parseLength('3 ft 2 1/2 in', 'cm'))).toBe(97.79)
  })
  it('reads metric', () => {
    expect(cm(parseLength('150 cm', 'in'))).toBe(150)
    expect(cm(parseLength('1.5 m', 'in'))).toBe(150)
    expect(cm(parseLength('1,5 m', 'in'))).toBe(150)
    expect(cm(parseLength('1500 mm', 'in'))).toBe(150)
  })
  it('rejects nonsense', () => {
    expect(parseLength('', 'cm')).toBeNull()
    expect(parseLength('abc', 'cm')).toBeNull()
    expect(parseLength('12 x 6', 'cm')).toBeNull()
    expect(parseLength('1/0 in', 'cm')).toBeNull()
  })
})

describe('formatting', () => {
  it('shows inches to the nearest half', () => {
    expect(inchesText(54)).toBe('54')
    expect(inchesText(53.5)).toBe('53½')
    expect(inchesText(0.5)).toBe('½')
    expect(inchesText(53.9)).toBe('54')
    expect(inchesText(41 / 2.54)).toBe('16')
  })
  it('shows feet and inches for long lengths', () => {
    expect(feetInchesText(141)).toBe('11′ 9″')
    expect(feetInchesText(24)).toBe('24″')
    expect(feetInchesText(36)).toBe('3′')
    expect(feetInchesText(143.8)).toBe('12′')
  })
  it('formats lengths and sizes in either unit', () => {
    expect(formatLength(137, { unit: 'cm' })).toBe('137 cm')
    expect(formatLength(137, { unit: 'in' })).toBe('54 in')
    expect(formatLength(358, { unit: 'in', feet: true })).toBe('11′ 9″')
    expect(formatSize(137, 76, 89, { unit: 'in' })).toBe('54 × 30 × 35 in')
    expect(formatSize(137, 76, undefined, { unit: 'cm' })).toBe('137 × 76 cm')
    expect(formatRoomSize(358, 295, { unit: 'in' })).toBe('11′ 9″ × 9′ 8″')
    expect(formatRoomSize(358, 295, { unit: 'cm' })).toBe('358 × 295 cm')
  })
  it('converts to a typeable number', () => {
    expect(toUnitNumber(381, 'in')).toBe(150)
    expect(toUnitNumber(137, 'in')).toBe(54)
    expect(toUnitNumber(16.51, 'in')).toBe(6.5)
    expect(toUnitNumber(137.4, 'cm')).toBe(137)
  })
  it('drops the unit or the spaces for compact labels', () => {
    expect(formatSize(137, 76, 89, { unit: 'in', bare: true })).toBe('54 × 30 × 35')
    expect(formatSize(137, 76, 89, { unit: 'in', bare: true, compact: true })).toBe('54×30×35')
    expect(formatSize(70, 130, 90, { unit: 'cm', bare: true, compact: true })).toBe('70×130×90')
  })
  it('shows a room with its height', () => {
    expect(formatRoomDims(358, 295, 244, { unit: 'cm' })).toBe('358 × 295 × 244 cm')
    expect(formatRoomDims(358, 295, 244, { unit: 'in' })).toBe('11′ 9″ × 9′ 8″ × 8′')
    expect(formatRoomDims(270, 370, 260, { unit: 'in' })).toBe('8′ 10½″ × 12′ 1½″ × 8′ 6½″')
  })
})

describe('parseSize', () => {
  it('reads width × depth, with or without a height, in any unit', async () => {
    const { parseSize } = await import('../units')
    const r = (s: string, u: 'in' | 'cm' = 'in') => { const v = parseSize(s, u); return v && Object.fromEntries(Object.entries(v).map(([k, n]) => [k, Math.round(n)])) }
    expect(r('41 x 39')).toEqual({ w: 104, d: 99 })
    expect(r('41×39×40')).toEqual({ w: 104, d: 99, h: 102 })
    expect(r('41 by 39')).toEqual({ w: 104, d: 99 })
    expect(r(`3' 5" x 3' 3"`)).toEqual({ w: 104, d: 99 })
    expect(r('104 x 99 cm')).toEqual({ w: 104, d: 99 })
    expect(r('104 x 99', 'cm')).toEqual({ w: 104, d: 99 })
    expect(r('41x39')).toEqual({ w: 104, d: 99 })
    expect(r('41 X 39 * 40')).toEqual({ w: 104, d: 99, h: 102 })
    expect(r(`3'x3'`)).toEqual({ w: 91, d: 91 })
    // a decimal comma is a decimal, not a separator
    expect(r('1,5 x 2 m', 'cm')).toEqual({ w: 150, d: 200 })
    expect(r('41')).toBeNull()
    expect(r('41 x')).toBeNull()
    expect(r('wide x deep')).toBeNull()
    expect(r('0 x 39')).toBeNull()
  })
})

describe('parseSize reads back what the app shows', () => {
  it('every size the plan label or the edit box shows, in inches and in cm', async () => {
    const { parseSize, formatSize, toUnitNumber } = await import('../units')
    for (const unit of ['in', 'cm'] as const) {
      for (let v = 5; v <= 600; v++) {
        const w = v, d = 605 - v, h = (v % 200) + 1
        // the label's text (half inches as ½)
        const label = parseSize(formatSize(w, d, h, { unit, bare: true }), unit)
        expect(label, `${unit} label ${w}×${d}×${h}`).not.toBeNull()
        for (const [a, b] of [[label!.w, w], [label!.d, d], [label!.h!, h]]) expect(Math.abs(a - b)).toBeLessThanOrEqual(unit === 'in' ? 1.3 : 0.5)
        // the edit box's text (41.5)
        const box = parseSize([w, d, h].map((x) => String(toUnitNumber(x, unit))).join(' × '), unit)
        expect(box, `${unit} box ${w}×${d}×${h}`).not.toBeNull()
      }
    }
  })

  it('carries a unit written on the last part to the bare numbers before it', async () => {
    const { parseSize } = await import('../units')
    const r = (s: string, u: 'in' | 'cm') => { const v = parseSize(s, u); return v && Object.values(v).map(Math.round) }
    expect(r("3 x 4'", 'in')).toEqual([91, 122])
    expect(r('3 x 4 foot', 'cm')).toEqual([91, 122])
    expect(r('2 x 1.5 metres', 'cm')).toEqual([200, 150])
    expect(r('2 x 1 meter', 'in')).toEqual([200, 100])
    expect(r('41 x 39″', 'cm')).toEqual([104, 99])
    expect(r('6 1/2 x 12 in', 'cm')).toEqual([17, 30])
    expect(r('41½ x 39 in', 'cm')).toEqual([105, 99])
    expect(r('40inx30in', 'cm')).toEqual([102, 76])
    expect(r('100cmx50cm', 'in')).toEqual([100, 50])
    expect(r('41by39', 'in')).toEqual([104, 99])
  })
})
