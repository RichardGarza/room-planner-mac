import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { polygonBounds } from '../geometry'
import { runChecks } from '../checks'
import { connections, floorsOverlap, houseBounds, itemAt, itemOnPlan, roomAt, roomOnPlan, snapPlacement, toHouse, type HouseDoc, type HouseRoom } from '../house'
import { useHouses } from '../houses'
import { libraryStorage, useLibrary } from '../library'
import type { Item, Room } from '../types'
import { formatRoomSize, useUnits } from '../units'
import { RoomDrawing } from './PlanThumb'
import './house.css'

// three.js only loads when the 3D view is opened
const HouseScene3D = lazy(() => import('../scene/HouseScene3D').then((m) => ({ default: m.HouseScene3D })))

/*
 * The house map: every room of the house at its place, with its furniture. Scroll to zoom, drag to
 * move around, click a room to open it in the planner (the planner's back button comes back here).
 * Drag a piece of furniture to move it, into another room too; click one to pick it (R turns it).
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
  /** a piece of furniture: `grab` is the pointer's offset from its middle on the plan */
  | { kind: 'item'; px: number; py: number; roomId: string; item: Item; grab: [number, number]; moved: boolean }

/** A piece picked on the map: which room it is in and its id there. */
interface Picked { roomId: string; itemId: string }

export function HouseMap() {
  const houseId = useHouses((s) => s.currentId)
  const house = useHouses((s) => s.houses.find((h) => h.id === s.currentId))
  const rooms = useHouses((s) => s.rooms)
  const status = useHouses((s) => s.status)
  const error = useHouses((s) => s.error)
  const { open: openHouse, close: closeHouse, moveRoom, turnRoom, addRoom, removeRoom, moveItem, addHallway, exportHouse } = useHouses.getState()
  const openRoom = useLibrary((s) => s.open)
  const library = useLibrary((s) => s.rooms)
  const unit = useUnits((s) => s.unit)
  const svg = useRef<SVGSVGElement>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [arranging, setArranging] = useState(false)
  /** the whole house in 3D (a mass model) instead of the map; walls cut away at waist height or full */
  const [in3d, setIn3d] = useState(false)
  const [cutaway, setCutaway] = useState(true)
  const [printing, setPrinting] = useState(false)
  /** The house plan on one page (letter for inches, A4 for centimetres), saved as a PDF. */
  const savePdf = async () => {
    if (!house) return
    setPrinting(true)
    try {
      const [{ buildHouseSheet }, { sheetsToPdf }] = await Promise.all([import('../print'), import('../print/pdf')])
      const sheet = buildHouseSheet({ house, rooms, unit }, { paper: unit === 'in' ? 'letter' : 'a4', orientation: 'auto' })
      const pdf = await sheetsToPdf([sheet], `${house.name} - house plan`)
      const s = await libraryStorage()
      const slug = house.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'house'
      await s.saveFile?.(`${slug}-house-plan.pdf`, pdf, 'application/pdf')
    } catch (e) {
      useHouses.setState({ error: `Could not save the PDF: ${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setPrinting(false)
    }
  }
  const [selected, setSelected] = useState<string | null>(null)
  /** the room being dragged, where it would land (snapped) */
  const [dragging, setDragging] = useState<{ place: HouseRoom; snapped: { x: boolean; y: boolean } } | null>(null)
  /** the piece of furniture picked on the map (not while arranging) */
  const [picked, setPicked] = useState<Picked | null>(null)
  /** the piece being dragged across the map: where its middle is */
  const [carrying, setCarrying] = useState<{ roomId: string; item: Item; x: number; y: number } | null>(null)

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
    // a piece of furniture (not while arranging): picked up, unless it is locked
    const piece = arranging ? null : itemAt(house, rooms, at)
    const place = piece && house.rooms.find((r) => r.roomId === piece.roomId)
    if (piece && place && !piece.item.locked) {
      const [cx, cy] = toHouse(place, [piece.item.x, piece.item.y])
      press.current = { kind: 'item', px: e.clientX, py: e.clientY, roomId: piece.roomId, item: piece.item, grab: [at[0] - cx, at[1] - cy], moved: false }
    } else {
      press.current = hit
        ? { kind: 'room', px: e.clientX, py: e.clientY, start: hit, grab: at, moved: false }
        : { kind: 'pan', px: e.clientX, py: e.clientY, view: v, moved: false }
    }
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
    } else if (p.kind === 'item') {
      const at = toPlan(e.clientX, e.clientY)
      setCarrying({ roomId: p.roomId, item: p.item, x: at[0] - p.grab[0], y: at[1] - p.grab[1] })
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
    if (p.kind === 'item' && p.moved && carrying) {
      const drop = carrying
      void moveItem(drop.roomId, drop.item.id, drop.x, drop.y).then((landed) => {
        setCarrying(null)
        setPicked(landed ?? { roomId: drop.roomId, itemId: drop.item.id })
      })
      return
    }
    setCarrying(null)
    if (p.moved) return
    const at = toPlan(e.clientX, e.clientY)
    if (arranging) return setSelected(roomAt(house, roomMap, at)?.roomId ?? null)
    // a click on a piece picks it; on a room's floor opens the room; on nothing lets go
    const piece = itemAt(house, rooms, at)
    if (piece) return setPicked({ roomId: piece.roomId, itemId: piece.item.id })
    const hit = roomAt(house, roomMap, at)
    if (hit) void openRoom(hit.roomId)
    else setPicked(null)
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

  // the picked piece: R turns it a quarter where it stands (⇧R the other way), Esc lets go
  const pickedDoc = picked ? rooms[picked.roomId] : undefined
  const pickedItem = pickedDoc?.items.find((i) => i.id === picked!.itemId)
  const turnPicked = (deg: number) => {
    const place = house?.rooms.find((r) => r.roomId === picked?.roomId)
    if (!picked || !pickedItem || !place || pickedItem.locked) return
    const [cx, cy] = toHouse(place, [pickedItem.x, pickedItem.y])
    void moveItem(picked.roomId, pickedItem.id, cx, cy, deg)
  }
  useEffect(() => {
    if (arranging || !picked) return
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      if (e.key === 'r' || e.key === 'R') { e.preventDefault(); turnPicked(e.shiftKey ? -90 : 90) }
      if (e.key === 'Escape') setPicked(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!house || !shown) return null
  const missing = house.rooms.filter((p) => !rooms[p.roomId])
  const loading = status === 'loading' && !Object.keys(rooms).length
  const outlines = new Map(shown.rooms.filter((p) => rooms[p.roomId]).map((p) => [p.roomId, roomOnPlan(rooms[p.roomId].room, p)]))
  const overlapping = new Set<string>()
  const ids = [...outlines.keys()]
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (floorsOverlap(outlines.get(ids[i])!, outlines.get(ids[j])!)) { overlapping.add(ids[i]); overlapping.add(ids[j]) }
  }
  // doors that meet across a shared wall: drawn as a passage through the wall
  const links = connections(shown, rooms)
  const addable = library.filter((r) => !house.rooms.some((p) => p.roomId === r.id))
  const selectedName = selected ? rooms[selected]?.name : null
  // what the picked piece gets wrong where it stands now (the planner's own checks)
  const problems = pickedDoc && pickedItem
    ? runChecks(pickedDoc.room, pickedDoc.items).filter((c) => c.level !== 'ok' && c.itemIds.includes(pickedItem.id))
    : []

  return (
    <div className={arranging ? 'house arranging' : 'house'}>
      <header className="house-head">
        <button className="back" onClick={closeHouse} title="Back to your rooms">‹ Rooms</button>
        <div className="house-title">
          <h1>{house.name}</h1>
          <span className="muted small">
            {in3d
              ? 'Drag to look around, scroll to zoom, click a room to open it.'
              : arranging
              ? 'Drag a room to move it: its walls snap to the rooms around it (hold ⌥ to place it freely). Click a room to select it, R turns it.'
              : `${house.rooms.length} room${house.rooms.length === 1 ? '' : 's'}${links.length ? ` · ${links.length} connected door${links.length === 1 ? '' : 's'}` : ''} · click a room to open it · scroll to zoom, drag to move around`}
          </span>
        </div>
        <div className="seg" role="group" aria-label="Map or 3D">
          <button className={in3d ? '' : 'on'} aria-pressed={!in3d} onClick={() => setIn3d(false)}>Map</button>
          <button className={in3d ? 'on' : ''} aria-pressed={in3d} onClick={() => { setIn3d(true); setArranging(false); setPicked(null) }}>3D</button>
        </div>
        {in3d ? (
          <button className="chip ghost" aria-pressed={!cutaway} onClick={() => setCutaway(!cutaway)} title="Walls cut away at waist height, or at full height">{cutaway ? 'Full-height walls' : 'Cut the walls away'}</button>
        ) : (
          <>
            <button className="chip ghost" onClick={() => setView(null)} title="Show the whole house">Fit</button>
            <button className="chip ghost" onClick={() => void exportHouse(house.id)} title="Save the house and all its rooms (layouts too) as one file, to back up or open on another computer">Export</button>
            <button className="chip ghost" onClick={() => void savePdf()} disabled={printing} title="The whole house on one page, as a PDF">{printing ? 'Saving…' : 'Save as PDF'}</button>
            <button className={arranging ? 'chip solid' : 'chip'} aria-pressed={arranging} onClick={() => { setArranging(!arranging); setSelected(null) }}>
              {arranging ? 'Done arranging' : 'Arrange rooms'}
            </button>
          </>
        )}
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
          <button className="chip ghost" onClick={() => void addHallway().then((id) => id && setSelected(id))} title="A new empty room for a hallway or open area, placed next to the house">+ Add a hallway</button>
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
      {!arranging && pickedItem && pickedDoc && (
        <div className="house-tools" role="toolbar" aria-label="Picked piece">
          <strong>{pickedItem.name}</strong>
          <span className="muted small">in {pickedDoc.name}{pickedItem.locked ? ' · locked' : ''}</span>
          {!pickedItem.locked && <button className="chip" onClick={() => turnPicked(90)} title="A quarter turn clockwise (R; ⇧R the other way)">↻ Turn 90°</button>}
          <button className="chip ghost" onClick={() => void openRoom(picked!.roomId)}>Open {pickedDoc.name}</button>
          <span className="house-tools-gap" />
          {problems.length
            ? <span className={problems.some((c) => c.level === 'bad') ? 'house-problem bad' : 'house-problem'}>{problems[0].text}{problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}</span>
            : <span className="house-problem ok">Fits here</span>}
        </div>
      )}
      {error && <div className="lib-error" role="alert"><span>{error}</span></div>}
      {missing.length > 0 && !loading && (
        <p className="house-note muted small">{missing.length} room{missing.length === 1 ? '' : 's'} of this house {missing.length === 1 ? 'is' : 'are'} not in your rooms folder any more.</p>
      )}
      {overlapping.size > 0 && <p className="house-note warn small">Rooms drawn in red overlap: drag them apart.</p>}
      {in3d && (
        <div className="house-3d">
          <Suspense fallback={<p className="muted house-note">Loading 3D…</p>}>
            <HouseScene3D house={house} rooms={rooms} cutaway={cutaway} onOpen={(id) => void openRoom(id)} />
          </Suspense>
        </div>
      )}
      <svg
        ref={svg}
        style={in3d ? { display: 'none' } : undefined}
        className="house-map"
        viewBox={`${v.x} ${v.y} ${v.w} ${v.h}`}
        preserveAspectRatio="xMidYMid meet"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        // a mouse press does not move the keyboard focus to a room (its focus ring is for Tab)
        onMouseDown={(e) => e.preventDefault()}
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
                {/* the piece being carried is drawn at the pointer instead */}
                <RoomDrawing room={doc.room} items={carrying && carrying.roomId === p.roomId ? doc.items.filter((i) => i.id !== carrying.item.id) : doc.items} />
              </g>
              {/* the hover, selection and click target: the room's floor */}
              <polygon className="house-hit" points={outlines.get(p.roomId)!.map((q) => q.join(',')).join(' ')} />
            </g>
          )
        })}
        {/* connected doors: the wall between them opened up as a passage */}
        {links.map((c) => (
          <polygon key={`${c.a.roomId}:${c.a.doorId}|${c.b.roomId}:${c.b.doorId}`} className="house-passage" points={c.passage.map((q) => q.join(',')).join(' ')}>
            <title>{`${rooms[c.a.roomId]?.name} ↔ ${rooms[c.b.roomId]?.name}`}</title>
          </polygon>
        ))}
        {/* the picked piece's outline, and the piece being carried */}
        {pickedItem && !carrying && (() => {
          const place = shown.rooms.find((r) => r.roomId === picked!.roomId)
          return place ? <polygon className="house-picked" points={itemOnPlan(pickedItem, place).map((q) => q.join(',')).join(' ')} /> : null
        })()}
        {carrying && (() => {
          const place = shown.rooms.find((r) => r.roomId === carrying.roomId)
          if (!place) return null
          const [cx, cy] = toHouse(place, [carrying.item.x, carrying.item.y])
          const pts = itemOnPlan(carrying.item, place).map(([x, y]) => [x - cx + carrying.x, y - cy + carrying.y])
          const over = roomAt(house, roomMap, [carrying.x, carrying.y])
          return <polygon className={over ? 'house-carried' : 'house-carried nowhere'} points={pts.map((q) => q.join(',')).join(' ')} fill={carrying.item.color} />
        })()}
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
