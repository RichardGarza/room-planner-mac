import { useEffect, useMemo, useRef, useState } from 'react'
import { polygonBounds } from '../geometry'
import { houseBounds, roomAt, roomOnPlan, type HouseRoom } from '../house'
import { useHouses } from '../houses'
import { useLibrary } from '../library'
import type { Room } from '../types'
import { formatRoomSize, useUnits } from '../units'
import { RoomDrawing } from './PlanThumb'
import './house.css'

/*
 * The house map: every room of the house at its place, with its furniture. Scroll to zoom, drag to
 * move around, click a room to open it in the planner ("‹ House" in the planner comes back here).
 */

const MARGIN = 120

interface View { x: number; y: number; w: number; h: number }

export function HouseMap() {
  const houseId = useHouses((s) => s.currentId)
  const house = useHouses((s) => s.houses.find((h) => h.id === s.currentId))
  const rooms = useHouses((s) => s.rooms)
  const status = useHouses((s) => s.status)
  const error = useHouses((s) => s.error)
  const openHouse = useHouses((s) => s.open)
  const closeHouse = useHouses((s) => s.close)
  const openRoom = useLibrary((s) => s.open)
  const unit = useUnits((s) => s.unit)
  const svg = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<string | null>(null)

  // (re)load the rooms each time the map shows: they may have changed in the planner
  useEffect(() => { if (houseId) void openHouse(houseId) }, [houseId, openHouse])

  const roomMap = useMemo(() => new Map(Object.entries(rooms).map(([id, d]) => [id, d.room] as [string, Room])), [rooms])
  const fit = useMemo((): View => {
    const b = house ? houseBounds(house, roomMap) : null
    if (!b) return { x: 0, y: 0, w: 1000, h: 700 }
    return { x: b.x0 - MARGIN, y: b.y0 - MARGIN, w: b.x1 - b.x0 + MARGIN * 2, h: b.y1 - b.y0 + MARGIN * 2 }
  }, [house, roomMap])
  const [view, setView] = useState<View | null>(null)
  const v = view ?? fit
  // a new house or new rooms: fit them again
  useEffect(() => { setView(null) }, [fit])

  // drag the background to move around
  const drag = useRef<{ px: number; py: number; view: View; moved: boolean } | null>(null)
  const scale = () => { const r = svg.current!.getBoundingClientRect(); return Math.max(v.w / r.width, v.h / r.height) }
  const onDown = (e: React.PointerEvent) => {
    drag.current = { px: e.clientX, py: e.clientY, view: v, moved: false }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const k = scale()
    const dx = (e.clientX - d.px) * k, dy = (e.clientY - d.py) * k
    if (Math.abs(e.clientX - d.px) + Math.abs(e.clientY - d.py) > 4) d.moved = true
    if (d.moved) setView({ ...d.view, x: d.view.x - dx, y: d.view.y - dy })
  }
  // a press let go without dragging is a click: open the room under it (the map holds the pointer
  // while it is down, so the rooms themselves never see the click)
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved || !house) return
    const p = roomAt(house, roomMap, toPlan(e.clientX, e.clientY))
    if (p) void openRoom(p.roomId)
  }
  /** A point on the screen, on the house plan (the viewBox is centred in the element, "meet"). */
  const toPlan = (cx: number, cy: number): [number, number] => {
    const r = svg.current!.getBoundingClientRect()
    const k = scale()
    return [v.x + (cx - r.left - (r.width - v.w / k) / 2) * k, v.y + (cy - r.top - (r.height - v.h / k) / 2) * k]
  }
  // scroll to zoom about the pointer
  useEffect(() => {
    const el = svg.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      setView((cur) => {
        const c = cur ?? fit
        const r = el.getBoundingClientRect()
        const k = Math.max(c.w / r.width, c.h / r.height)
        // the plan point under the pointer (the viewBox is centred in the element)
        const px = c.x + (e.clientX - r.left - (r.width - c.w / k) / 2) * k
        const py = c.y + (e.clientY - r.top - (r.height - c.h / k) / 2) * k
        const f = Math.min(4, Math.max(0.25, Math.exp(e.deltaY * 0.0015)))
        const w = Math.min(fit.w * 4, Math.max(150, c.w * f)), h = (w / c.w) * c.h
        return { x: px - (px - c.x) * (w / c.w), y: py - (py - c.y) * (w / c.w), w, h }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [fit])

  const open = (p: HouseRoom) => { void openRoom(p.roomId) }

  if (!house) return null
  const missing = house.rooms.filter((p) => !rooms[p.roomId])
  const loading = status === 'loading' && !Object.keys(rooms).length

  return (
    <div className="house">
      <header className="house-head">
        <button className="back" onClick={closeHouse} title="Back to your rooms">‹ Rooms</button>
        <div className="house-title">
          <h1>{house.name}</h1>
          <span className="muted small">{house.rooms.length} room{house.rooms.length === 1 ? '' : 's'} · click a room to open it · scroll to zoom, drag to move around</span>
        </div>
        <button className="chip ghost" onClick={() => setView(null)} title="Show the whole house">Fit</button>
      </header>
      {error && <div className="lib-error" role="alert"><span>{error}</span></div>}
      {missing.length > 0 && !loading && (
        <p className="house-note muted small">{missing.length} room{missing.length === 1 ? '' : 's'} of this house {missing.length === 1 ? 'is' : 'are'} not in your rooms folder any more.</p>
      )}
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
        {house.rooms.map((p) => {
          const doc = rooms[p.roomId]
          if (!doc) return null
          return (
            <g key={p.roomId} className={hover === p.roomId ? 'house-room hover' : 'house-room'}
              onPointerEnter={() => setHover(p.roomId)} onPointerLeave={() => setHover(null)}
              role="button" tabIndex={0} aria-label={`Open ${doc.name}`}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(p) } }}>
              <g transform={`translate(${p.x} ${p.y}) rotate(${p.rot})`}>
                <RoomDrawing room={doc.room} items={doc.items} />
              </g>
              {/* the hover and click target: the room's floor */}
              <polygon className="house-hit" points={roomOnPlan(doc.room, p).map((q) => q.join(',')).join(' ')} />
            </g>
          )
        })}
        {/* names on top, the right way up whatever the room's turn */}
        {house.rooms.map((p) => {
          const doc = rooms[p.roomId]
          if (!doc) return null
          const b = polygonBounds(roomOnPlan(doc.room, p))
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
