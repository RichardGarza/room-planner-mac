import { useEffect, useMemo, useRef, useState } from 'react'
import { MAX_WALLS, MIN_WALLS, roomPolygon, type Polygon } from '../geometry'
import { normalizeOutline, outlineFromWalls, wallsFromOutline, type WallSpec } from '../outline'
import { useStore } from '../store'
import { CM_PER_IN, formatLength, useUnits } from '../units'
import { LengthInput } from './LengthInput'
import './walls.css'

/*
 * Edit walls: draw the room's shape on a grid, then type in the real wall lengths and corner
 * angles. One wall is worked out so the walls always meet (see outlineFromWalls).
 */

type Tab = 'draw' | 'measure'

/** Corner presets, as the angle inside the room. */
const PRESETS: { angle: number; label: string }[] = [
  { angle: 90, label: '90° corner' },
  { angle: 135, label: '45° angled wall (135°)' },
  { angle: 270, label: 'Inside corner (270°)' },
  { angle: 225, label: 'Inside 45° (225°)' },
]

const snap5 = (a: number) => Math.round(a / 5) * 5
/** A wall length as the person would measure it: to the half inch, or the centimetre. */
const snapLength = (cm: number, unit: 'cm' | 'in') => (unit === 'in' ? (Math.round((cm / CM_PER_IN) * 2) / 2) * CM_PER_IN : Math.round(cm))

/** Lengths to the tape, angles to 5°, and the last wall worked out so it closes. */
function tidy(spec: WallSpec, unit: 'cm' | 'in'): WallSpec {
  return { ...spec, lengths: spec.lengths.map((l) => snapLength(l, unit)), angles: spec.angles.map(snap5) }
}

export function WallEditor({ onClose }: { onClose: () => void }) {
  const room = useStore((s) => s.room)
  const setOutline = useStore((s) => s.setOutline)
  const unit = useUnits((s) => s.unit)
  const [tab, setTab] = useState<Tab>(room.outline ? 'measure' : 'draw')
  const [spec, setSpec] = useState<WallSpec>(() => wallsFromOutline(roomPolygon(room)))
  const [close, setClose] = useState(() => spec.lengths.length - 1)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const result = useMemo(() => outlineFromWalls(spec, close), [spec, close])

  const useDrawing = (pts: Polygon) => {
    const out = normalizeOutline(pts)
    if ('error' in out) return out.error
    const next = tidy(wallsFromOutline(out.points), unit)
    setSpec(next)
    setClose(next.lengths.length - 1)
    setTab('measure')
    return null
  }

  const setCount = (m: number) => {
    setSpec((s) => resize(s, m, close))
    setClose((c) => Math.min(c, m - 1))
  }

  const save = () => {
    if ('error' in result) return
    const out = normalizeOutline(result.points)
    if ('error' in out) return
    setOutline(out.points)
    onClose()
  }

  return (
    <div className="walls-overlay" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }} role="presentation">
      <div className="walls-dialog" role="dialog" aria-modal="true" aria-label="Edit walls">
        <div className="walls-head">
          <h3>Edit walls</h3>
          <div className="walls-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'draw'} className={tab === 'draw' ? 'on' : ''} onClick={() => setTab('draw')}>1 · Draw the shape</button>
            <button role="tab" aria-selected={tab === 'measure'} className={tab === 'measure' ? 'on' : ''} onClick={() => setTab('measure')}>2 · Lengths and angles</button>
          </div>
          <button className="icon" onClick={onClose} aria-label="Close" title="Close (Esc)">✕</button>
        </div>
        {tab === 'draw'
          ? <DrawTab current={roomPolygon(room)} unit={unit} onDone={useDrawing} />
          : (
            <div className="walls-body">
              <MeasureTab spec={spec} setSpec={setSpec} close={close} setClose={setClose} setCount={setCount} result={result} unit={unit} />
              <Preview result={result} unit={unit} />
            </div>
          )}
        <div className="walls-foot">
          <p className="muted small">
            {tab === 'draw'
              ? 'Click on the grid to place each corner; click the first corner again to close the shape. Rough is fine: you type the real lengths next.'
              : 'Doors, windows and closets stay on their wall. The room keeps its furniture; anything a new wall cuts through shows up in the checks.'}
          </p>
          <div className="walls-actions">
            <button className="chip" onClick={onClose}>Cancel</button>
            <button className="chip solid" onClick={save} disabled={tab !== 'measure' || 'error' in result}>Save walls</button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** More walls: split the longest ones in two (a straight 180° corner, ready to be changed). Fewer: drop the last. */
function resize(s: WallSpec, m: number, close: number): WallSpec {
  let { lengths, angles, headings } = s
  lengths = [...lengths]; angles = [...angles]; headings = [...headings]
  while (lengths.length < m) {
    let i = 0
    lengths.forEach((l, k) => { if (k !== close && l > lengths[i]) i = k })
    const half = lengths[i] / 2
    lengths.splice(i, 1, half, half)
    angles.splice(i, 0, 180)
    headings.splice(i + 1, 0, headings[i])
  }
  while (lengths.length > m) {
    lengths.pop(); angles.pop(); headings.pop()
  }
  return { lengths, angles, headings }
}

/* ---------------------------------- draw ---------------------------------- */

const CANVAS_W = 640, CANVAS_H = 420

function DrawTab({ current, unit, onDone }: { current: Polygon; unit: 'cm' | 'in'; onDone: (pts: Polygon) => string | null }) {
  // one square is a foot, or 25 cm; the grid covers about 9 × 6 m
  const cell = unit === 'in' ? 12 * CM_PER_IN : 25
  const cols = Math.round(900 / cell), rows = Math.round(620 / cell)
  const px = Math.min(CANVAS_W / cols, CANVAS_H / rows)
  const [pts, setPts] = useState<[number, number][]>([])
  const [hover, setHover] = useState<[number, number] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const svg = useRef<SVGSVGElement>(null)

  const toGrid = (e: React.PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect()
    const x = ((e.clientX - r.left) / r.width) * (cols * px)
    const y = ((e.clientY - r.top) / r.height) * (rows * px)
    return [Math.max(0, Math.min(cols, Math.round(x / px))), Math.max(0, Math.min(rows, Math.round(y / px)))]
  }
  const same = (a: [number, number], b: [number, number]) => a[0] === b[0] && a[1] === b[1]
  const finish = (list: [number, number][]) => {
    if (list.length < MIN_WALLS) return setError('Place at least three corners.')
    const err = onDone(list.map(([gx, gy]) => [gx * cell, gy * cell]))
    setError(err)
  }
  const click = (e: React.PointerEvent) => {
    const g = toGrid(e)
    if (pts.length >= MIN_WALLS && same(g, pts[0])) return finish(pts)
    if (pts.length && same(g, pts[pts.length - 1])) return
    if (pts.length >= MAX_WALLS) return setError(`A room can have at most ${MAX_WALLS} walls: click the first corner to close it.`)
    setError(null)
    setPts([...pts, g])
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Backspace' && !(e.target instanceof HTMLInputElement)) { e.preventDefault(); setPts((p) => p.slice(0, -1)) }
      if (e.key === 'Enter') finish(pts)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // the current room, faintly, from the top-left of the grid
  const ghost = current.map(([x, y]) => `${(x / cell) * px + px},${(y / cell) * px + px}`).join(' ')
  const P = ([gx, gy]: [number, number]) => `${gx * px},${gy * px}`
  const seg = (a: [number, number], b: [number, number]) => formatLength(Math.hypot(b[0] - a[0], b[1] - a[1]) * cell, { unit, feet: true })

  return (
    <div className="walls-draw">
      <svg ref={svg} className="walls-grid" viewBox={`0 0 ${cols * px} ${rows * px}`} onPointerMove={(e) => setHover(toGrid(e))} onPointerLeave={() => setHover(null)} onPointerDown={click}>
        {Array.from({ length: cols + 1 }, (_, i) => <line key={`v${i}`} x1={i * px} y1={0} x2={i * px} y2={rows * px} className={i % 5 === 0 ? 'major' : ''} />)}
        {Array.from({ length: rows + 1 }, (_, j) => <line key={`h${j}`} x1={0} y1={j * px} x2={cols * px} y2={j * px} className={j % 5 === 0 ? 'major' : ''} />)}
        <polygon points={ghost} className="ghost" />
        {pts.length > 1 && <polyline points={pts.map(P).join(' ')} className="drawn" />}
        {pts.length > 0 && hover && !same(hover, pts[pts.length - 1]) && (
          <line x1={pts[pts.length - 1][0] * px} y1={pts[pts.length - 1][1] * px} x2={hover[0] * px} y2={hover[1] * px} className="rubber" />
        )}
        {pts.slice(1).map((p, i) => {
          const a = pts[i]
          return <text key={`l${i}`} x={((a[0] + p[0]) / 2) * px} y={((a[1] + p[1]) / 2) * px - 5} className="len">{seg(a, p)}</text>
        })}
        {pts.map((p, i) => <circle key={i} cx={p[0] * px} cy={p[1] * px} r={i === 0 && pts.length >= MIN_WALLS ? 7 : 4} className={i === 0 ? 'first' : 'corner'} />)}
        {hover && <circle cx={hover[0] * px} cy={hover[1] * px} r={3} className="hover" />}
      </svg>
      <div className="walls-draw-side">
        <p className="small"><b>{pts.length}</b> corner{pts.length === 1 ? '' : 's'} placed. One square is {unit === 'in' ? '1 ft' : '25 cm'}; the faint outline is the room as it is now.</p>
        <div className="row">
          <button className="chip ghost" onClick={() => setPts((p) => p.slice(0, -1))} disabled={!pts.length}>Undo corner</button>
          <button className="chip ghost" onClick={() => { setPts([]); setError(null) }} disabled={!pts.length}>Clear</button>
        </div>
        <button className="chip solid" onClick={() => finish(pts)} disabled={pts.length < MIN_WALLS}>Close the shape</button>
        {error && <p className="walls-error" role="alert">{error}</p>}
        <p className="muted small">Tip: squares make 90° corners; going one square across for every square down makes a 45° wall.</p>
      </div>
    </div>
  )
}

/* -------------------------------- measure -------------------------------- */

function MeasureTab({ spec, setSpec, close, setClose, setCount, result, unit }: {
  spec: WallSpec
  setSpec: (f: (s: WallSpec) => WallSpec) => void
  close: number
  setClose: (c: number) => void
  setCount: (m: number) => void
  result: ReturnType<typeof outlineFromWalls>
  unit: 'cm' | 'in'
}) {
  const n = spec.lengths.length
  const setLength = (i: number, cm: number) => setSpec((s) => ({ ...s, lengths: s.lengths.map((l, k) => (k === i ? cm : l)) }))
  const setAngle = (i: number, a: number) => setSpec((s) => ({ ...s, angles: s.angles.map((x, k) => (k === i ? a : x)) }))
  const auto = 'error' in result ? null : result.closing
  return (
    <div className="walls-measure">
      <div className="walls-count">
        <label>Number of walls
          <select value={n} onChange={(e) => setCount(Number(e.target.value))}>
            {Array.from({ length: MAX_WALLS - MIN_WALLS + 1 }, (_, i) => i + MIN_WALLS).map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label>Worked out for you
          <select value={close} onChange={(e) => setClose(Number(e.target.value))}>
            {spec.lengths.map((_, i) => <option key={i} value={i}>Wall {i + 1}</option>)}
          </select>
        </label>
      </div>
      <ol className="walls-list">
        {spec.lengths.map((len, i) => {
          const isAuto = i === close
          // the corner at the end of wall i: worked out when it touches the closing wall
          const cornerAuto = i === close || (i + 1) % n === close
          const autoAngle = auto ? (i === close ? auto.angleAfter : auto.angleBefore) : null
          return (
            <li key={i}>
              <div className={`wall-row${isAuto ? ' auto' : ''}`}>
                <span className="wall-num">{i + 1}</span>
                <span className="wall-name">Wall {i + 1}</span>
                {isAuto
                  ? <span className="wall-auto" title="Worked out so the walls meet">{auto ? formatLength(auto.length, { unit, feet: true }) : '—'} <em>auto</em></span>
                  : <LengthInput value={len} min={5} max={3000} onCommit={(cm) => setLength(i, cm)} />}
              </div>
              <div className={`corner-row${cornerAuto ? ' auto' : ''}`}>
                <span className="corner-label">corner {i + 1}–{((i + 1) % n) + 1}</span>
                {cornerAuto
                  ? <span className="wall-auto">{autoAngle !== null ? `${Math.round(autoAngle * 10) / 10}°` : '—'} <em>auto</em></span>
                  : <AngleField value={spec.angles[i]} onChange={(a) => setAngle(i, a)} />}
              </div>
            </li>
          )
        })}
      </ol>
      {'error' in result && <p className="walls-error" role="alert">{result.error}</p>}
    </div>
  )
}

/** A corner: one of the presets, or any angle in 5° steps. */
function AngleField({ value, onChange }: { value: number; onChange: (a: number) => void }) {
  const preset = PRESETS.find((p) => Math.abs(p.angle - value) < 0.01)
  const [custom, setCustom] = useState(!preset)
  const [text, setText] = useState(String(Math.round(value)))
  useEffect(() => { setText(String(Math.round(value))) }, [value])
  const commit = () => {
    const v = Number(text)
    if (!Number.isFinite(v)) return setText(String(Math.round(value)))
    const a = Math.max(5, Math.min(355, snap5(v)))
    setText(String(a))
    onChange(a)
  }
  return (
    <span className="angle-field">
      <select value={custom || !preset ? 'custom' : String(preset.angle)} onChange={(e) => {
        if (e.target.value === 'custom') { setCustom(true); return }
        setCustom(false)
        onChange(Number(e.target.value))
      }}>
        {PRESETS.map((p) => <option key={p.angle} value={p.angle}>{p.label}</option>)}
        <option value="custom">Custom angle</option>
      </select>
      {(custom || !preset) && (
        <input className="angle-num" type="number" step={5} min={5} max={355} value={text}
          onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') commit() }} aria-label="Angle in degrees" />
      )}
    </span>
  )
}

/* -------------------------------- preview -------------------------------- */

function Preview({ result, unit }: { result: ReturnType<typeof outlineFromWalls>; unit: 'cm' | 'in' }) {
  if ('error' in result) {
    return <div className="walls-preview empty"><p className="muted small">The shape shows up here once the walls meet.</p></div>
  }
  const pts = result.points
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const minX = Math.min(...xs), minY = Math.min(...ys)
  const W = Math.max(...xs) - minX || 1, H = Math.max(...ys) - minY || 1
  const pad = 40, size = 380
  const k = (size - pad * 2) / Math.max(W, H)
  const at = ([x, y]: [number, number]): [number, number] => [pad + (x - minX) * k, pad + (y - minY) * k]
  const n = pts.length
  const angles = wallsFromOutline(pts).angles
  return (
    <div className="walls-preview">
      <svg viewBox={`0 0 ${size} ${size}`}>
        <polygon points={pts.map((p) => at(p).join(',')).join(' ')} className="shape" />
        {pts.map((p, i) => {
          const q = pts[(i + 1) % n]
          const [ax, ay] = at(p), [bx, by] = at(q)
          const mx = (ax + bx) / 2, my = (ay + by) / 2
          // label just inside the wall
          const len = Math.hypot(bx - ax, by - ay) || 1
          const nx = -(by - ay) / len, ny = (bx - ax) / len
          const auto = i === result.closing.wall
          return (
            <g key={i}>
              <line x1={ax} y1={ay} x2={bx} y2={by} className={auto ? 'wall auto' : 'wall'} />
              <text x={mx + nx * 16} y={my + ny * 16} className="num">{i + 1}</text>
              <text x={mx + nx * 16} y={my + ny * 16 + 10} className="len">{formatLength(Math.hypot(q[0] - p[0], q[1] - p[1]), { unit, feet: true })}</text>
            </g>
          )
        })}
        {angles.map((a, i) => {
          // the corner at the end of wall i; square ones get a dot, the rest their angle
          const [x, y] = at(pts[(i + 1) % n])
          return Math.abs(a - 90) > 0.5
            ? <text key={`a${i}`} x={x} y={y - 6} className="ang">{Math.round(a)}°</text>
            : <circle key={`a${i}`} cx={x} cy={y} r={2} className="dot" />
        })}
      </svg>
      <p className="muted small">{n} walls · dashed: worked out</p>
    </div>
  )
}
