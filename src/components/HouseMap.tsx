import { useEffect, useMemo, useRef, useState } from 'react'
import { polygonBounds } from '../geometry'
import { floorsOverlap, houseBounds, roomAt, roomOnPlan, snapPlacement, type HouseDoc, type HouseRoom } from '../house'
import { useHouses } from '../houses'
import { useLibrary } from '../library'
import type { Room } from '../types'
import { formatRoomSize, useUnits } from '../units'
import { RoomDrawing } from './PlanThumb'
import './house.css'

/*
 * The house map: every room of the house at its place, with its furniture. Scroll to zoom, drag to
 * move around, click a room to open it in the planner (the planner's back button comes back here).
 *
 * "Arrange rooms" switches to arranging: drag a room to move it (its walls snap to the walls of the
 * rooms around it, a wall's thickness apart), click one to select it, turn it with R or the button,
 * add rooms from the library, take one out. Every change is saved at once.
 */

const MARGIN = 120

interface View { x: number; y: number; w: number; h: number }

type Press =
  | { kind: 'pan'; px: number; py: number; view: View; moved: boolean }
  | { kind: 'room'; px: number; py: number; start: HouseRoom; grab: [number, number]; moved: boolean }

export function HouseMap() {
  const houseId = useHouses((s) => s.currentId)
  const house = useHouses((s) => s.houses.find((h) => h.id === s.currentId))
  const rooms = useHouses((s) => s.rooms)
  const status = useHouses((s) => s.status)
  const error = useHouses((s) => s.error)
  const { open: openHouse, close: closeHouse, moveRoom, turnRoom, addRoom, removeRoom } = useHouses.getState()
  const openRoom = useLibrary((s) => s.open)
  const library = useLibrary((s) => s.rooms)
  const unit = useUnits((s) => s.unit)
  const svg = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** the room being dragged, where it would land (snapped) */
  const [dragging, setDragging] = useState<{ place: HouseRoom; snapped: { x: boolean; y: boolean } } | null>(null)

  // (re)load the rooms each time the map shows: they may have changed in the planner
  useEffect(() => { if (houseId) void openHouse(houseId) }, [houseId, openHouse])

  const roomMap = useMemo(() => new Map(Object.entries(rooms).map(([id, d]) => [id, d.room] as [string, Room])), [rooms])
  // the house as drawn: with the room being dragged where it would land
  const shown: HouseDoc | undefined = useMemo(() => {
    if (!house || !dragging) return house
    return { ...house, rooms: house.rooms.map((p) => (p.roomId === dragging.place.roomId ? dragging.place : p)) }
  }, [house, dragging])

  const fit = (): View => {
    const b = house ? houseBounds(house, roomMap) : null
    if (!b) return { x: 0, y: 0, w: 1000, h: 700 }
    return { x: b.x0 - MARGIN, y: b.y0 - MARGIN, w: b.x1 - b.x0 + MARGIN * 2, h: b.y1 - b.y0 + MARGIN * 2 }
  }
  const [view, setView] = useState<View | null>(null)
  const v = view ?? fit()
  // another house, or its rooms loaded: fit them (not while arranging, or the map would jump with every move)
  const fitKey = `${houseId}|${Object.keys(rooms).sort().join()}`
  useEffect(() => { setView(null) }, [fitKey])

  const scale = () => { const r = svg.current!.getBoundingClientRect(); return Math.max(v.w / r.width, v.h / r.height) }
  /** A point on the screen, on the house plan (the viewBox is centred in the element, "meet"). */
  const toPlan = (cx: number, cy: number): [number, number] => {
    const r = svg.current!.getBoundingClientRect()
    const k = scale()
    return [v.x + (cx - r.left - (r.width - v.w / k) / 2) * k, v.y + (cy - r.top - (r.height - v.h / k) / 2) * k]
  }

  // Pressing: on a room while arranging, that room is picked up; anywhere else the view moves.
  // Let go without moving: a click (open the room, or select it while arranging). The map holds the
  // pointer while it is down, so the rooms themselves never see the click.
  const press = useRef<Press | null>(null)
  const onDown = (e: React.PointerEvent) => {
    if (!house) return
    const at = toPlan(e.clientX, e.clientY)
    const hit = arranging ? roomAt(house, roomMap, at) : null
    press.current = hit
      ? { kind: 'room', px: e.clientX, py: e.clientY, start: hit, grab: at, moved: false }
      : { kind: 'pan', px: e.clientX, py: e.clientY, view: v, moved: false }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const p = press.current
    if (!p || !house) return
    if (Math.abs(e.clientX - p.px) + Math.abs(e.clientY - p.py) > 4) p.moved = true
    if (!p.moved) return
    if (p.kind === 'pan') {
      const k = scale()
      setView({ ...p.view, x: p.view.x - (e.clientX - p.px) * k, y: p.view.y - (e.clientY - p.py) * k })
    } else {
      const at = toPlan(e.clientX, e.clientY)
      const moved: HouseRoom = { ...p.start, x: p.start.x + at[0] - p.grab[0], y: p.start.y + at[1] - p.grab[1] }
      setDragging(e.altKey ? { place: moved, snapped: { x: false, y: false } } : snapPlacement(house, roomMap, moved))
    }
  }
  const onUp = (e: React.PointerEvent) => {
    const p = press.current
    press.current = null
    if (!p || !house) return
    if (p.kind === 'room' && p.moved && dragging) {
      void moveRoom(dragging.place.roomId, dragging.place.x, dragging.place.y)
      setSelected(dragging.place.roomId)
      setDragging(null)
      return
    }
    setDragging(null)
    if (p.moved) return
    const hit = roomAt(house, roomMap, toPlan(e.clientX, e.clientY))
    if (arranging) setSelected(hit?.roomId ?? null)
    else if (hit) void openRoom(hit.roomId)
  }

  // scroll to zoom about the pointer
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setView((cur) => {
        const c = cur ?? fit()
        const r = el.getBoundingClientRect()
        const k = Math.max(c.w / r.width, c.h / r.height)
        const px = c.x + (e.clientX - r.left - (r.width - c.w / k) / 2) * k
        const py = c.y + (e.clientY - r.top - (r.height - c.h / k) / 2) * k
        const f = Math.min(4, Math.max(0.25, Math.exp(e.deltaY * 0.0015)))
        const w = Math.max(150, c.w * f), h = (w / c.w) * c.h
        return { x: px - (px - c.x) * (w / c.w), y: py - (py - c.y) * (w / c.w), w, h }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  // R turns the selected room, Esc lets go of it (taking a room out is a button only: a stray key should not)
  useEffect(() => {
    if (!arranging) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (!selected) return
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); void turnRoom(selected) }
      if (e.key === 'Escape') setSelected(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [arranging, selected, turnRoom])

  if (!house || !shown) return null
  const missing = house.rooms.filter((p) => !rooms[p.roomId])
  const loading = status === 'loading' && !Object.keys(rooms).length
  const outlines = new Map(shown.rooms.filter((p) => rooms[p.roomId]).map((p) => [p.roomId, roomOnPlan(rooms[p.roomId].room, p)]))
  const overlapping = new Set<string>()
  const ids = [...outlines.keys()]
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (floorsOverlap(outlines.get(ids[i])!, outlines.get(ids[j])!)) { overlapping.add(ids[i]); overlapping.add(ids[j]) }
  }
  const addable = library.filter((r) => !house.rooms.some((p) => p.roomId === r.id))
  const selectedName = selected ? rooms[selected]?.name : null

  return (
    <div className={arranging ? 'house arranging' : 'house'}>
      <header className="house-head">
        <button className="back" onClick={closeHouse} title="Back to your rooms">‹ Rooms</button>
        <div className="house-title">
          <h1>{house.name}</h1>
          <span className="muted small">
            {arranging
              ? 'Drag a room to move it: its walls snap to the rooms around it (hold ⌥ to place it freely). Click a room to select it, R turns it.'
              : `${house.rooms.length} room${house.rooms.length === 1 ? '' : 's'} · click a room to open it · scroll to zoom, drag to move around`}
          </span>
        </div>
        <button className="chip ghost" onClick={() => setView(null)} title="Show the whole house">Fit</button>
        <button className={arranging ? 'chip solid' : 'chip'} aria-pressed={arranging} onClick={() => { setArranging(!arranging); setSelected(null) }}>
          {arranging ? 'Done arranging' : 'Arrange rooms'}
        </button>
      </header>
      {arranging && (
        <div className="house-tools" role="toolbar" aria-label="Arrange rooms">
          {selectedName ? (
            <>
              <strong>{selectedName}</strong>
              <button className="chip" onClick={() => void turnRoom(selected!)} title="A quarter turn clockwise (R)">↻ Turn 90°</button>
              <button className="chip ghost" onClick={() => { void removeRoom(selected!); setSelected(null) }} title="Take it out of the house; the room itself stays in your rooms">Take out of the house</button>
            </>
          ) : <span className="muted small">Select a room to turn it or take it out.</span>}
          <span className="house-tools-gap" />
          {addable.length > 0 && (
            <label className="house-add">
              Add a room
              <select value="" onChange={(e) => { if (e.target.value) void addRoom(e.target.value) }}>
                <option value="">Choose…</option>
                {addable.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </label>
          )}
        </div>
      )}
      {error && <div className="lib-error" role="alert"><span>{error}</span></div>}
      {missing.length > 0 && !loading && (
        <p className="house-note muted small">{missing.length} room{missing.length === 1 ? '' : 's'} of this house {missing.length === 1 ? 'is' : 'are'} not in your rooms folder any more.</p>
      )}
      {overlapping.size > 0 && <p className="house-note warn small">Rooms drawn in red overlap: drag them apart.</p>}
      <svg
        ref={svg}
        className="house-map"
        viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        role="img"
        aria-label={`Map of ${house.name}`}
      >
        {loading && <text x={v.x + v.w / 2} y={v.y + v.h / 2} className="house-loading" textAnchor="middle">Loading the rooms…</text>}
        {shown.rooms.map((p) => {
          const doc = rooms[p.roomId]
          if (!doc) return null
          const cls = ['house-room', hover === p.roomId && 'hover', selected === p.roomId && 'selected', dragging?.place.roomId === p.roomId && 'dragging', overlapping.has(p.roomId) && 'overlap'].filter(Boolean).join(' ')
          return (
            <g key={p.roomId} className={cls}
              onPointerEnter={() => setHover(p.roomId)} onPointerLeave={() => setHover(null)}
              role="button" tabIndex={0} aria-label={arranging ? `Select ${doc.name}` : `Open ${doc.name}`}
              onKeyDown={(e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return
                e.preventDefault()
                if (arranging) setSelected(p.roomId)
                else void openRoom(p.roomId)
              }}>
              <g transform={`translate(${p.x} ${p.y}) rotate(${p.rot})`}>
                <RoomDrawing room={doc.room} items={doc.items} />
              </g>
              {/* the hover, selection and click target: the room's floor */}
              <polygon className="house-hit" points={outlines.get(p.roomId)!.map((q) => q.join(',')).join(' ')} />
            </g>
          )
        })}
        {/* names on top, the right way up whatever the room's turn */}
        {shown.rooms.map((p) => {
          const doc = rooms[p.roomId]
          if (!doc) return null
          const b = polygonBounds(outlines.get(p.roomId)!)
          const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2
          const size = Math.max(14, Math.min(30, (b.x1 - b.x0) / 12))
          return (
            <g key={`label-${p.roomId}`} className="house-label" pointerEvents="none">
              <text x={cx} y={cy} fontSize={size} textAnchor="middle">{doc.name}</text>
              <text x={cx} y={cy + size * 1.1} fontSize={size * 0.6} textAnchor="middle" className="house-size">{formatRoomSize(doc.room.w, doc.room.d, { unit })}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
