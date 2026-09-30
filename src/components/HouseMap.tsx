import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react'
import { polygonBounds } from '../geometry'
import { runChecks } from '../checks'
import { connections, floorsOverlap, houseBounds, itemAt, itemOnPlan, levelName, levels, onLevel, roomAt, roomOnPlan, snapPlacement, toHouse, toRoom, type HouseDoc, type HouseRoom } from '../house'
import { canResize, outward, resizeRoom as resize, snapResize } from '../resize'
import { useHouses } from '../houses'
import { libraryStorage, useLibrary } from '../library'
import type { Item, Room, RoomDoc, Wall } from '../types'
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
  /** a wall's handle of the selected room, being dragged to resize it */
  | { kind: 'resize'; px: number; py: number; roomId: string; side: Wall; grab: [number, number]; start: HouseRoom; doc: RoomDoc; moved: boolean }

/** A piece picked on the map: which room it is in and its id there. */
interface Picked { roomId: string; itemId: string }

export function HouseMap() {
  const houseId = useHouses((s) => s.currentId)
  const house = useHouses((s) => s.houses.find((h) => h.id === s.currentId))
  const rooms = useHouses((s) => s.rooms)
  const status = useHouses((s) => s.status)
  const error = useHouses((s) => s.error)
  const { open: openHouse, close: closeHouse, moveRoom, turnRoom, addRoom, removeRoom, moveItem, addHallway, exportHouse, setLevel: setRoomLevel, resizeRoom } = useHouses.getState()
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
  /** the floor on screen; a floor with no rooms yet can be shown to add rooms to it */
  const [level, setLevel] = useState(0)
  const floors = house ? [...new Set([...levels(house), level])].sort((a, b) => a - b) : [0]
  /** The house plan on one page (letter for inches, A4 for centimetres), saved as a PDF. */
  const savePdf = async () => {
    if (!house) return
    setPrinting(true)
    try {
      const [{ buildHouseSheet }, { sheetsToPdf }] = await Promise.all([import('../print'), import('../print/pdf')])
      // a page per floor
      const all = levels(house)
      const sheets = all.map((l) => buildHouseSheet({ house: onLevel(house, l), rooms, unit, floor: all.length > 1 ? levelName(l) : undefined }, { paper: unit === 'in' ? 'letter' : 'a4', orientation: 'auto' }))
      const pdf = await sheetsToPdf(sheets, `${house.name} - house plan`)
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
  /** the room being resized: how it would look with the wall where it is dragged to */
  const [resizing, setResizing] = useState<{ roomId: string; side: Wall; doc: RoomDoc; place: HouseRoom; amount: number } | null>(null)
  /** the piece being dragged across the map: where its middle is */
  const [carrying, setCarrying] = useState<{ roomId: string; item: Item; x: number; y: number } | null>(null)

  // (re)load the rooms each time the map shows: they may have changed in the planner
  useEffect(() => { if (houseId) void openHouse(houseId) }, [houseId, openHouse])

  const roomMap = useMemo(() => new Map(Object.entries(rooms).map(([id, d]) => [id, d.room] as [string, Room])), [rooms])
  // the floor on screen, as drawn: with the room being dragged where it would land
  const floor: HouseDoc | undefined = useMemo(() => (house ? onLevel(house, level) : undefined), [house, level])
  const shown: HouseDoc | undefined = useMemo(() => {
    const moved = dragging?.place ?? resizing?.place
    if (!floor || !moved) return floor
    return { ...floor, rooms: floor.rooms.map((p) => (p.roomId === moved.roomId ? moved : p)) }
  }, [floor, dragging, resizing])
  // the rooms as drawn: the one being resized at its new size
  const docs = resizing ? { ...rooms, [resizing.roomId]: resizing.doc } : rooms
  function fit(): View {
    const b = floor ? houseBounds(floor, roomMap) : null
    if (!b) return { x: 0, y: 0, w: 1000, h: 700 }
    return { x: b.x0 - MARGIN, y: b.y0 - MARGIN, w: b.x1 - b.x0 + MARGIN * 2, h: b.y1 - b.y0 + MARGIN * 2 }
  }
  const [view, setView] = useState<View | null>(null)
  const v = view ?? fit()
  /** The handle on each wall of the selected room (a plain one), in the room's own terms, sized to the view. */
  const handleSize = v.w / 70
  const handleOf = (room: Room, side: Wall) => {
    const len = Math.min(handleSize * 3.5, (side === 'left' || side === 'right' ? room.d : room.w) * 0.5)
    const t = handleSize
    switch (side) {
      case 'left': return { x: -t / 2, y: room.d / 2 - len / 2, w: t, h: len }
      case 'right': return { x: room.w - t / 2, y: room.d / 2 - len / 2, w: t, h: len }
      case 'top': return { x: room.w / 2 - len / 2, y: -t / 2, w: len, h: t }
      case 'bottom': return { x: room.w / 2 - len / 2, y: room.d - t / 2, w: len, h: t }
    }
  }
  const SIDES: Wall[] = ['left', 'right', 'top', 'bottom']
  /** The handle of the selected room under a plan point, if any (a little larger than drawn, to be easy to catch). */
  const handleAt = (at: [number, number]): { place: HouseRoom; side: Wall } | null => {
    if (!arranging || !selected || !floor) return null
    const place = floor.rooms.find((p) => p.roomId === selected)
    const doc = rooms[selected]
    if (!place || !doc || !canResize(doc.room)) return null
    const [lx, ly] = toRoom(place, at)
    const pad = handleSize * 0.6
    const side = SIDES.find((sd) => { const h = handleOf(doc.room, sd); return lx > h.x - pad && lx < h.x + h.w + pad && ly > h.y - pad && ly < h.y + h.h + pad })
    return side ? { place, side } : null
  }

  // another house, or its rooms loaded: fit them (not while arranging, or the map would jump with every move)
  const fitKey = `${houseId}|${level}|${Object.keys(rooms).sort().join()}`
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
    if (!floor) return
    const at = toPlan(e.clientX, e.clientY)
    // a wall handle of the selected room: resizing it
    const grip = handleAt(at)
    if (grip) {
      press.current = { kind: 'resize', px: e.clientX, py: e.clientY, roomId: grip.place.roomId, side: grip.side, grab: at, start: grip.place, doc: rooms[grip.place.roomId], moved: false }
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      return
    }
    const hit = arranging ? roomAt(floor, roomMap, at) : null
    // a piece of furniture (not while arranging): picked up, unless it is locked
    const piece = arranging ? null : itemAt(floor, rooms, at)
    const place = piece && floor.rooms.find((r) => r.roomId === piece.roomId)
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
    if (!p || !house || !floor) return
    if (Math.abs(e.clientX - p.px) + Math.abs(e.clientY - p.py) > 4) p.moved = true
    if (!p.moved) return
    if (p.kind === 'pan') {
      const k = scale()
      setView({ ...p.view, x: p.view.x - (e.clientX - p.px) * k, y: p.view.y - (e.clientY - p.py) * k })
    } else if (p.kind === 'resize') {
      const at = toPlan(e.clientX, e.clientY)
      const out = outward(p.start, p.side)
      const raw = (at[0] - p.grab[0]) * out[0] + (at[1] - p.grab[1]) * out[1]
      const amount = e.altKey ? raw : snapResize(floor, roomMap, p.start, p.doc.room, p.side, raw)
      const r = resize(p.doc, p.start, p.side, amount)
      setResizing({ roomId: p.roomId, side: p.side, doc: r.doc, place: r.place, amount: r.amount })
    } else if (p.kind === 'item') {
      const at = toPlan(e.clientX, e.clientY)
      setCarrying({ roomId: p.roomId, item: p.item, x: at[0] - p.grab[0], y: at[1] - p.grab[1] })
    } else {
      const at = toPlan(e.clientX, e.clientY)
      const moved: HouseRoom = { ...p.start, x: p.start.x + at[0] - p.grab[0], y: p.start.y + at[1] - p.grab[1] }
      setDragging(e.altKey ? { place: moved, snapped: { x: false, y: false } } : snapPlacement(floor, roomMap, moved))
    }
  }
  const onUp = (e: React.PointerEvent) => {
    const p = press.current
    press.current = null
    if (!p || !house || !floor) return
    if (p.kind === 'room' && p.moved && dragging) {
      void moveRoom(dragging.place.roomId, dragging.place.x, dragging.place.y)
      setSelected(dragging.place.roomId)
      setDragging(null)
      return
    }
    setDragging(null)
    if (p.kind === 'resize') {
      const done = resizing
      if (p.moved && done && done.amount) void resizeRoom(done.roomId, done.side, done.amount).then(() => setResizing(null))
      else setResizing(null)
      return
    }
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
    if (arranging) return setSelected(roomAt(floor, roomMap, at)?.roomId ?? null)
    // a click on a piece picks it; on a room's floor opens the room; on nothing lets go
    const piece = itemAt(floor, rooms, at)
    if (piece) return setPicked({ roomId: piece.roomId, itemId: piece.item.id })
    const hit = roomAt(floor, roomMap, at)
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
  const outlines = new Map(shown.rooms.filter((p) => docs[p.roomId]).map((p) => [p.roomId, roomOnPlan(docs[p.roomId].room, p)]))
  const overlapping = new Set<string>()
  const ids = [...outlines.keys()]
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
    if (floorsOverlap(outlines.get(ids[i])!, outlines.get(ids[j])!)) { overlapping.add(ids[i]); overlapping.add(ids[j]) }
  }
  // doors that meet across a shared wall: drawn as a passage through the wall
  const links = connections(shown, docs)
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
              ? 'Drag a room to move it: its walls snap to the rooms around it (hold ⌥ to place it freely). Click a room to select it: R turns it, and a plain room\'s handles resize it.'
              : `${house.rooms.length} room${house.rooms.length === 1 ? '' : 's'}${links.length ? ` · ${links.length} connected door${links.length === 1 ? '' : 's'}` : ''} · click a room to open it · scroll to zoom, drag to move around`}
          </span>
        </div>
        {(floors.length > 1 || arranging) && (
          <label className="house-floor">
            <select value={level} onChange={(e) => { setLevel(e.target.value === 'up' ? Math.max(...floors) + 1 : Number(e.target.value)); setSelected(null); setPicked(null) }} aria-label="Floor">
              {floors.map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
              {arranging && <option value="up">+ New floor above</option>}
            </select>
          </label>
        )}
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
            <button className={arranging ? 'chip solid' : 'chip'} aria-pressed={arranging} onClick={() => {
              // while arranging the view holds still (it would follow the house's size as rooms move and grow)
              if (!arranging && !view) setView(fit())
              setArranging(!arranging)
              setSelected(null)
            }}>
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
              <label className="house-add">
                Floor
                <select value={level} onChange={(e) => {
                  const to = e.target.value === 'up' ? Math.max(...floors) + 1 : Number(e.target.value)
                  const id = selected!
                  // follow the room to its new floor, still selected
                  void setRoomLevel(id, to).then(() => { setLevel(to); setSelected(id) })
                }}>
                  {floors.map((l) => <option key={l} value={l}>{levelName(l)}</option>)}
                  <option value="up">A new floor above</option>
                </select>
              </label>
            </>
          ) : <span className="muted small">Select a room to turn it or take it out.</span>}
          <span className="house-tools-gap" />
          <button className="chip ghost" onClick={() => void addHallway(level).then((id) => id && setSelected(id))} title="A new empty room for a hallway or open area, placed next to the house">+ Add a hallway</button>
          {addable.length > 0 && (
            <label className="house-add">
              Add a room
              <select value="" onChange={(e) => { if (e.target.value) void addRoom(e.target.value, level) }}>
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
            <HouseScene3D house={house} rooms={rooms} cutaway={cutaway} upTo={level} onOpen={(id) => void openRoom(id)} />
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
          const doc = docs[p.roomId]
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
          const over = roomAt(floor!, roomMap, [carrying.x, carrying.y])
          return <polygon className={over ? 'house-carried' : 'house-carried nowhere'} points={pts.map((q) => q.join(',')).join(' ')} fill={carrying.item.color} />
        })()}
        {/* the selected room's wall handles: drag one to move that wall (plain rooms only) */}
        {arranging && selected && (() => {
          const place = shown.rooms.find((r) => r.roomId === selected)
          const doc = docs[selected]
          if (!place || !doc || !canResize(doc.room)) return null
          return (
            <g transform={`translate(${place.x} ${place.y}) rotate(${place.rot})`} className="house-handles" pointerEvents="none">
              {SIDES.map((sd) => {
                const h = handleOf(doc.room, sd)
                return <rect key={sd} className={resizing?.side === sd ? 'house-handle on' : 'house-handle'} x={h.x} y={h.y} width={h.w} height={h.h} rx={handleSize / 2} />
              })}
            </g>
          )
        })()}
        {/* names on top, the right way up whatever the room's turn */}
        {shown.rooms.map((p) => {
          const doc = docs[p.roomId]
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
