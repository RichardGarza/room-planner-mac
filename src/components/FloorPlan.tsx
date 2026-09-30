import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { closetClearanceDepth, closetInside, doorSwing, wallStripPolygon, edgeIndex, footprint, frontRecessPad, isAxisAligned, isSide, normalizeRot, rectOf, roomPolygon, roomWalls, wallAxes, wallLength, wallPoint, wallStripRect } from '../geometry'
import { isRugKind } from '../placement'
import { useStore } from '../store'
import type { AnyWall, Closet, Door, Item, Room, Wall } from '../types'
import { CM_PER_IN, formatLength, parseSize, sizeParts, toUnitNumber, useUnits } from '../units'

const M = 34 // margin around the room for labels (cm units in the viewBox)
const PARK_H = 150
/** the scale bar: 1 m in cm mode, 3 ft in inch mode */
const SCALE = { cm: { length: 100, label: '1 m' }, in: { length: 36 * CM_PER_IN, label: '3 ft' } }

export function FloorPlan() {
  const room = useStore((s) => s.room)
  const items = useStore((s) => s.items)
  const selectedId = useStore((s) => s.selectedId)
  const select = useStore((s) => s.select)
  const dragTo = useStore((s) => s.dragTo)
  const snapshot = useStore((s) => s.snapshot)
  const view = useStore((s) => s.view)
  const walkPose = useStore((s) => s.walkPose)
  const unit = useUnits((s) => s.unit)
  const scale = SCALE[unit]
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null)
  /** the label being edited in place: a piece's name or its size (double-click either on the plan) */
  const [editing, setEditing] = useState<{ itemId: string; field: LabelField; el: Element } | null>(null)
  const edit = (it: Item, field: LabelField, el: Element) => setEditing({ itemId: it.id, field, el })

  const toRoom = useCallback((e: React.PointerEvent) => {
    const svg = svgRef.current!
    const pt = svg.createSVGPoint()
    pt.x = e.clientX
    pt.y = e.clientY
    const p = pt.matrixTransform(svg.getScreenCTM()!.inverse())
    return { x: p.x - M, y: p.y - M }
  }, [])

  const onDown = (e: React.PointerEvent, it: Item) => {
    e.stopPropagation()
    const p = toRoom(e)
    select(it.id)
    // a locked piece can be picked, but not moved
    if (it.locked) return
    snapshot()
    setDrag({ id: it.id, dx: it.x - p.x, dy: it.y - p.y })
    ;(e.target as Element).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return
    const p = toRoom(e)
    dragTo(drag.id, p.x + drag.dx, p.y + drag.dy)
  }
  const onUp = () => setDrag(null)

  const sel = items.find((i) => i.id === selectedId)
  // doors that swing out draw their arc outside the room: widen the view so it is not clipped
  const outPad = (wall: Wall) => Math.max(0, ...room.doors.filter((d) => d.swing === 'out' && d.wall === wall).map((d) => d.width + 22 - M))
  // a closet recess sits outside the wall line too: widen the margin on its side by what does not fit in it
  const closetPad = (wall: Wall) => Math.max(0, ...(room.closets ?? []).filter((c) => c.wall === wall).map((c) => c.depth + 10 - M))
  const padL = Math.max(outPad('left'), closetPad('left')), padR = Math.max(outPad('right'), closetPad('right')), padT = Math.max(outPad('top'), closetPad('top'))
  // a recess on the front wall pushes the parking strip down (the store parks items past it too)
  const padB = frontRecessPad(room)
  const W = room.w + M * 2
  const H = room.d + M * 2 + PARK_H + padB
  const wallsWithOpenings = new Set<AnyWall>([...room.windows, ...room.doors].map((o) => o.wall))
  const outline = roomPolygon(room).map((p) => p.join(',')).join(' ')
  const drawn = !!room.outline

  return (
    <>
    <svg
      ref={svgRef}
      className="plan"
      viewBox={`${-padL} ${-padT} ${W + padL + padR} ${H + padT}`}
      preserveAspectRatio="xMidYMin meet"
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerDown={() => select(null)}
    >
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#b9b1a8" strokeWidth="1.5" />
        </pattern>
      </defs>
      <g transform={`translate(${M} ${M})`}>
        <clipPath id="plan-floor"><polygon points={outline} /></clipPath>
        {/* floor (a cut-off corner is not part of it) */}
        <polygon points={outline} fill="#fbf7f2" />
        {/* wall tints (a plain room's side walls) */}
        {!drawn && <rect x={-6} y={0} width={6} height={room.d} fill={room.wallColors.left} />}
        {!drawn && <rect x={room.w} y={0} width={6} height={room.d} fill={room.wallColors.right} />}
        {/* grid */}
        <g clipPath="url(#plan-floor)">
        {Array.from({ length: Math.floor(room.w / 50) }, (_, i) => (
          <line key={`v${i}`} x1={(i + 1) * 50} y1={0} x2={(i + 1) * 50} y2={room.d} stroke="#ede6df" strokeWidth={0.6} />
        ))}
        {Array.from({ length: Math.floor(room.d / 50) }, (_, i) => (
          <line key={`h${i}`} x1={0} y1={(i + 1) * 50} x2={room.w} y2={(i + 1) * 50} stroke="#ede6df" strokeWidth={0.6} />
        ))}
        </g>

        {/* radiators */}
        {room.radiators.map((rad) => {
          const r = wallStripRect(room, rad.wall, rad.offset, rad.width, rad.depth)
          return <rect key={rad.id} x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill="url(#hatch)" stroke="#a89f95" strokeWidth={0.8} />
        })}

        {/* closet floors: furniture can stand in them, so they go under it */}
        {(room.closets ?? []).map((c) => <ClosetPlan key={c.id} room={room} closet={c} part="floor" />)}

        {/* rugs first, then solid items */}
        {items.filter((i) => i.inRoom && isRugKind(i.kind)).map((it) => (
          <PlanItem key={it.id} item={it} selected={it.id === selectedId} onDown={onDown} toRoom={toRoom} onEdit={edit} />
        ))}
        {items.filter((i) => i.inRoom && !isRugKind(i.kind)).map((it) => (
          <PlanItem key={it.id} item={it} selected={it.id === selectedId} onDown={onDown} toRoom={toRoom} onEdit={edit} />
        ))}

        {/* door swings (an out-swinging door draws its arc outside the room) */}
        {room.doors.map((door) => <DoorSwing key={door.id} room={room} door={door} />)}

        {/* walls, open across each closet opening so what stands in the doorway shows */}
        <mask id="plan-closet-gaps" maskUnits="userSpaceOnUse" x={-M} y={-M} width={W + M} height={H + M}>
          <rect x={-M} y={-M} width={W + M} height={H + M} fill="#fff" />
          {(room.closets ?? []).map((c) => <polygon key={c.id} points={openingBand(room, c).map((p) => p.join(',')).join(' ')} fill="#000" />)}
        </mask>
        <polygon points={outline} fill="none" stroke="#3f3833" strokeWidth={6} strokeLinejoin="miter" mask="url(#plan-closet-gaps)" />
        {/* windows */}
        {room.windows.map((win) => <Opening key={win.id} room={room} wall={win.wall} offset={win.offset} width={win.width} kind="window" />)}
        {/* door openings */}
        {room.doors.map((door) => <Opening key={door.id} room={room} wall={door.wall} offset={door.offset} width={door.width} kind="door" />)}
        {/* closets: the jambs, the doors and the floor they need, over the furniture */}
        {(room.closets ?? []).map((c) => <ClosetPlan key={c.id} room={room} closet={c} part="marks" />)}

        {/* dimension lines for the selection */}
        {sel && sel.inRoom && <DimLines item={sel} roomW={room.w} roomD={room.d} />}

        {/* where you are standing in walk mode */}
        {view === 'walk' && (
          <g transform={`translate(${walkPose.x} ${walkPose.y})`} pointerEvents="none">
            <path
              d={`M 0 0 L ${-Math.sin(walkPose.yaw - 0.45) * 70} ${-Math.cos(walkPose.yaw - 0.45) * 70} A 70 70 0 0 1 ${-Math.sin(walkPose.yaw + 0.45) * 70} ${-Math.cos(walkPose.yaw + 0.45) * 70} Z`}
              fill="#e5407a"
              opacity={0.18}
            />
            <circle r={7} fill="#e5407a" stroke="#fff" strokeWidth={2} />
          </g>
        )}

        {/* labels */}
        {room.windows.map((win, i) => (
          <WallText key={win.id} room={room} wall={win.wall} t={win.offset + win.width / 2} text={room.windows.length > 1 ? `WINDOW ${i + 1}` : 'WINDOW'} />
        ))}
        {room.doors.map((door, i) => (
          <WallText
            key={door.id}
            room={room}
            wall={door.wall}
            t={door.offset + door.width / 2}
            text={room.doors.length > 1 ? `DOOR ${i + 1}` : 'DOOR'}
            dist={door.swing === 'out' ? door.width + 12 : undefined}
          />
        ))}
        {/* a drawn room: every wall's number and length just inside it, as in the wall editor */}
        {drawn && roomWalls(room).map((w) => (
          <WallText key={`n-${w}`} room={room} wall={w} t={wallLength(room, w) / 2} dist={-12} className="plan-wallnum"
            text={`${edgeIndex(w) + 1} · ${formatLength(wallLength(room, w), { unit, feet: true })}`} />
        ))}
        {!drawn && (['top', 'bottom', 'left', 'right'] as const)
          .filter((w) => !wallsWithOpenings.has(w))
          .map((w) => (
            <WallText key={w} room={room} wall={w} t={wallLength(room, w) / 2} text={w === 'left' ? 'LEFT WALL' : w === 'right' ? 'RIGHT WALL' : w === 'top' ? 'BACK WALL' : 'FRONT WALL'} />
          ))}
        <text x={room.w} y={room.d + 16} className="plan-dim" textAnchor="end">{formatLength(room.w, { unit, feet: true })}</text>
        <text transform={`translate(${room.w + 16} 6) rotate(90)`} className="plan-dim">{formatLength(room.d, { unit, feet: true })}</text>

        {/* parking strip (pushed down past a closet recess on the front wall) */}
        <g transform={`translate(0 ${room.d + 30 + padB})`}>
          <rect x={0} y={0} width={room.w} height={PARK_H - 30} rx={6} fill="none" stroke="#d8d0c7" strokeWidth={1} strokeDasharray="4 4" />
          <text x={room.w / 2} y={14} className="plan-label" textAnchor="middle">OUT OF THE ROOM</text>
          {items.filter((i) => !i.inRoom).length === 0 && (
            <text x={room.w / 2} y={(PARK_H - 30) / 2 + 4} className="plan-hint" textAnchor="middle">
              Drag furniture here to take it out of the room
            </text>
          )}
        </g>
        {items.filter((i) => !i.inRoom).map((it) => (
          <PlanItem key={it.id} item={it} selected={it.id === selectedId} onDown={onDown} toRoom={toRoom} onEdit={edit} muted />
        ))}

        {/* scale */}
        <g transform={`translate(0 ${room.d + PARK_H + 8 + padB})`}>
          <line x1={0} y1={0} x2={scale.length} y2={0} stroke="#3f3833" strokeWidth={1.2} />
          <line x1={0} y1={-3} x2={0} y2={3} stroke="#3f3833" strokeWidth={1.2} />
          <line x1={scale.length} y1={-3} x2={scale.length} y2={3} stroke="#3f3833" strokeWidth={1.2} />
          <text x={scale.length / 2} y={12} className="plan-dim" textAnchor="middle">{scale.label}</text>
        </g>
      </g>
    </svg>
    {editing && (() => {
      const it = items.find((x) => x.id === editing.itemId)
      return it ? <LabelEditor item={it} field={editing.field} label={editing.el} onDone={() => setEditing(null)} /> : null
    })()}
    </>
  )
}

function DoorSwing({ room, door }: { room: Room; door: Door }) {
  const swing = doorSwing(room, door)
  const [lx, ly] = swing.leafDir(90)
  return (
    <g opacity={swing.out ? 0.7 : 1}>
      <path d={arcPath(swing.hx, swing.hy, swing.r, swing.leafDir)} fill="none" stroke="#c9bfb4" strokeWidth={1} strokeDasharray="3 3" />
      <line x1={swing.hx} y1={swing.hy} x2={swing.hx + lx * swing.r} y2={swing.hy + ly * swing.r} stroke="#5c534b" strokeWidth={2} />
    </g>
  )
}

function arcPath(hx: number, hy: number, r: number, leafDir: (deg: number) => [number, number]) {
  const [x0, y0] = leafDir(0)
  const [x1, y1] = leafDir(90)
  // choose the sweep flag by checking which way the mid-angle point lies
  const [mx, my] = leafDir(45)
  const cross = (x0 * my - y0 * mx)
  return `M ${hx + x0 * r} ${hy + y0 * r} A ${r} ${r} 0 0 ${cross > 0 ? 1 : 0} ${hx + x1 * r} ${hy + y1 * r}`
}

/**
 * A closet on the plan: the recess drawn outside the wall line, the opening as a gap in the wall,
 * the doors by type (hinged leaves with their arcs, bi-fold chevrons, sliding bars, or nothing)
 * and a faint dashed rect for the floor that must stay clear in front of it.
 */
/** The band 8 cm either side of a closet's opening: where the wall line is left out. */
function openingBand(room: Room, c: Closet): [number, number][] {
  const inward = wallStripPolygon(room, c.wall, c.offset, c.width, 8), outward = wallStripPolygon(room, c.wall, c.offset, c.width, -8)
  return [outward[3], outward[2], inward[2], inward[3]]
}

/** A closet on the plan: its floor (drawn under the furniture) or its marks (jambs, doors, clearance, label; over it). */
function ClosetPlan({ room, closet: c, part }: { room: Room; closet: Closet; part: 'floor' | 'marks' }) {
  const { along, normal } = wallAxes(c.wall, room)
  const [x0, y0] = wallPoint(room, c.wall, c.offset)
  const clearDepth = closetClearanceDepth(c)
  // local frame: origin at the opening's start on the wall line, u along the wall, v into the room
  const pt = (u: number, v: number): [number, number] => [x0 + along[0] * u + normal[0] * v, y0 + along[1] * u + normal[1] * v]
  const P = (u: number, v: number) => pt(u, v).join(' ')
  const w = c.width
  const half = w / 2
  const wallHalf = 3
  // the inside, which reaches past the opening on either side in a walk-in (u runs along the wall from the opening's start)
  const inside = closetInside(c)
  const u0 = inside.offset - c.offset, u1 = u0 + inside.width
  // label towards the back of the recess so it stays clear of the wall's own label, turned with the wall
  const [lx, ly] = pt((u0 + u1) / 2, -Math.max(c.depth * 0.7, c.depth - 14) - wallHalf)
  const labelRot = readableAngle(along)
  const poly = (pts: [number, number][]) => pts.map((p) => p.join(',')).join(' ')
  if (part === 'floor') {
    return (
      <g className="closet">
        {/* the inside, from the wall line back (the wall stroke covers its edge beside a walk-in's opening) */}
        <polygon points={poly([pt(u0, 0), pt(u1, 0), pt(u1, -wallHalf - c.depth), pt(u0, -wallHalf - c.depth)])} fill="#f6f1ea" />
        <polyline points={poly([pt(u0, -wallHalf), pt(u0, -wallHalf - c.depth), pt(u1, -wallHalf - c.depth), pt(u1, -wallHalf)])} fill="none" stroke="#8f867d" strokeWidth={0.8} />
        {/* floor that stays free in front */}
        <polygon points={poly([pt(0, 0), pt(w, 0), pt(w, clearDepth), pt(0, clearDepth)])} fill="#8f867d" fillOpacity={0.05} stroke="#c9bfb4" strokeWidth={0.8} strokeDasharray="3 3" />
      </g>
    )
  }
  return (
    <g className="closet" pointerEvents="none">
      <line x1={pt(0, -wallHalf)[0]} y1={pt(0, -wallHalf)[1]} x2={pt(0, wallHalf)[0]} y2={pt(0, wallHalf)[1]} stroke="#3f3833" strokeWidth={1.2} />
      <line x1={pt(w, -wallHalf)[0]} y1={pt(w, -wallHalf)[1]} x2={pt(w, wallHalf)[0]} y2={pt(w, wallHalf)[1]} stroke="#3f3833" strokeWidth={1.2} />
      {c.doors === 'hinged' && (
        <g>
          {/* two leaves, each half the width, hinged at the jambs and swinging into the room */}
          <path d={`M ${P(half, 0)} A ${half} ${half} 0 0 ${arcSweep(along, normal) ? 1 : 0} ${P(0, half)}`} fill="none" stroke="#c9bfb4" strokeWidth={1} strokeDasharray="3 3" />
          <path d={`M ${P(half, 0)} A ${half} ${half} 0 0 ${arcSweep(along, normal) ? 0 : 1} ${P(w, half)}`} fill="none" stroke="#c9bfb4" strokeWidth={1} strokeDasharray="3 3" />
          <line x1={pt(0, 0)[0]} y1={pt(0, 0)[1]} x2={pt(0, half)[0]} y2={pt(0, half)[1]} stroke="#5c534b" strokeWidth={2} />
          <line x1={pt(w, 0)[0]} y1={pt(w, 0)[1]} x2={pt(w, half)[0]} y2={pt(w, half)[1]} stroke="#5c534b" strokeWidth={2} />
        </g>
      )}
      {c.doors === 'bifold' && (
        <g>
          {/* each half folds in two panels: a chevron from the jamb back to the track */}
          <polyline points={`${P(0, 0)} ${P(w / 8, (w / 4) * 0.87)} ${P(w / 4, 0)}`} fill="none" stroke="#5c534b" strokeWidth={1.5} strokeLinejoin="round" />
          <polyline points={`${P(w, 0)} ${P(w - w / 8, (w / 4) * 0.87)} ${P(w - w / 4, 0)}`} fill="none" stroke="#5c534b" strokeWidth={1.5} strokeLinejoin="round" />
        </g>
      )}
      {c.doors === 'sliding' && (
        <g>
          {/* two panels on a track, overlapping in the middle */}
          <line x1={pt(0, 1.6)[0]} y1={pt(0, 1.6)[1]} x2={pt(half + 4, 1.6)[0]} y2={pt(half + 4, 1.6)[1]} stroke="#5c534b" strokeWidth={2} />
          <line x1={pt(half - 4, -1.6)[0]} y1={pt(half - 4, -1.6)[1]} x2={pt(w, -1.6)[0]} y2={pt(w, -1.6)[1]} stroke="#5c534b" strokeWidth={2} />
        </g>
      )}
      <text transform={`translate(${lx} ${ly}) rotate(${labelRot})`} className="plan-label" textAnchor="middle" dominantBaseline="middle">CLOSET</text>
    </g>
  )
}

/** A wall's direction as a text angle that reads left to right (never upside down). */
function readableAngle(along: [number, number]) {
  const a = (Math.atan2(along[1], along[0]) * 180) / Math.PI
  return a > 90 ? a - 180 : a <= -90 ? a + 180 : a
}

/** Sweep flag for a quarter arc from the wall direction round to the room normal. */
function arcSweep(along: [number, number], normal: [number, number]) {
  return along[0] * normal[1] - along[1] * normal[0] > 0
}

function Opening({ room, wall, offset, width, kind }: { room: Room; wall: AnyWall; offset: number; width: number; kind: 'window' | 'door' }) {
  const { normal: [nx, ny] } = wallAxes(wall, room)
  const [x0, y0] = wallPoint(room, wall, offset)
  const [x1, y1] = wallPoint(room, wall, offset + width)
  // a band 8 cm across the wall line, turned with the wall (angled corner walls included)
  const band = [[x0 - nx * 4, y0 - ny * 4], [x1 - nx * 4, y1 - ny * 4], [x1 + nx * 4, y1 + ny * 4], [x0 + nx * 4, y0 + ny * 4]].map((p) => p.join(',')).join(' ')
  if (kind === 'door') return <polygon points={band} fill="#fbf7f2" />
  const thirds = [1 / 3, 2 / 3].map((f) => wallPoint(room, wall, offset + width * f))
  return (
    <g>
      <polygon points={band} fill="#fff" stroke="#3f3833" strokeWidth={1} />
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="#8fb5d6" strokeWidth={2} />
      {thirds.map(([tx, ty], i) => (
        <line key={i} x1={tx - nx * 4} y1={ty - ny * 4} x2={tx + nx * 4} y2={ty + ny * 4} stroke="#3f3833" strokeWidth={1} />
      ))}
    </g>
  )
}

/** A label beside a wall, `dist` cm outside it (negative: inside), turned with the wall and kept the right way up. */
function WallText({ room, wall, t, text, dist = 14, className = 'plan-label' }: { room: Room; wall: AnyWall; t: number; text: string; dist?: number; className?: string }) {
  const [x, y] = wallPoint(room, wall, t)
  const { along, normal } = wallAxes(wall, room)
  const ox = -normal[0] * dist, oy = -normal[1] * dist
  const rot = wall === 'left' ? -90 : wall === 'right' ? 90 : isSide(wall) ? 0 : readableAngle(along)
  return (
    <text transform={`translate(${x + ox} ${y + oy + (wall === 'top' ? 2 : wall === 'bottom' ? 4 : 0)}) rotate(${rot})`} className={className} textAnchor="middle" dominantBaseline={rot ? 'middle' : undefined}>
      {text}
    </text>
  )
}

type ToRoom = (e: React.PointerEvent) => { x: number; y: number }

function PlanItem({ item, selected, onDown, toRoom, muted, onEdit }: { item: Item; selected: boolean; onDown: (e: React.PointerEvent, it: Item) => void; toRoom: ToRoom; muted?: boolean; onEdit?: (it: Item, field: LabelField, el: Element) => void }) {
  const { fw } = footprint(item)
  const unit = useUnits((s) => s.unit)
  const stroke = selected ? '#f28c28' : '#8f867d'
  const fontSize = Math.min(11, Math.max(7, fw / 6))
  const locked = !!item.locked
  return (
    <g
      className={`plan-item${selected ? ' selected' : ''}${locked ? ' locked' : ''}`}
      transform={`translate(${item.x} ${item.y})`}
      onPointerDown={(e) => onDown(e, item)}
      opacity={muted ? 0.75 : 1}
      style={{ cursor: locked ? 'default' : 'grab' }}
    >
      <g transform={`rotate(${item.rot})`}>
        {item.kind === 'rug' ? (
          <circle r={item.w / 2} fill={item.color} opacity={0.55} stroke={stroke} strokeWidth={selected ? 2 : 0} />
        ) : item.kind === 'rugRect' ? (
          <rect x={-item.w / 2} y={-item.d / 2} width={item.w} height={item.d} rx={4} fill={item.color} opacity={0.55} stroke={stroke} strokeWidth={selected ? 2 : 0} />
        ) : item.kind === 'table' && item.w === item.d ? (
          <circle r={item.w / 2} fill={item.color} stroke={stroke} strokeWidth={selected ? 2 : 1} />
        ) : item.kind === 'plant' ? (
          <ellipse rx={item.w / 2} ry={item.d / 2} fill={item.color} stroke={stroke} strokeWidth={selected ? 2 : 1} />
        ) : (
          <rect x={-item.w / 2} y={-item.d / 2} width={item.w} height={item.d} rx={2} fill={item.color} stroke={stroke} strokeWidth={selected ? 2 : 1} />
        )}
        {item.kind === 'bed' && (
          <>
            <rect x={-item.w / 2} y={-item.d / 2} width={item.w} height={7} fill="#c9a78c" />
            <rect x={-item.w / 2 + 12} y={-item.d / 2 + 14} width={item.w / 2 - 16} height={26} rx={4} fill="#fff" opacity={0.9} />
            <rect x={4} y={-item.d / 2 + 14} width={item.w / 2 - 16} height={26} rx={4} fill="#fff" opacity={0.9} />
          </>
        )}
        {item.kind === 'chair' && <circle r={item.w / 2 - 4} fill="none" stroke="#9a8f86" strokeWidth={1} />}
        {(item.kind === 'wardrobe' || item.kind === 'dresser') && (
          <line x1={0} y1={-item.d / 2} x2={0} y2={item.d / 2} stroke="#b7ada3" strokeWidth={0.8} />
        )}
        {item.kind === 'nightstand' && (
          <>
            <line x1={-item.w / 2 + 3} y1={0} x2={item.w / 2 - 3} y2={0} stroke="#b7ada3" strokeWidth={0.8} />
            <circle cx={0} cy={item.d / 4} r={1.5} fill="#b7ada3" />
          </>
        )}
        {item.kind === 'sofa' && (() => {
          const arm = Math.min(18, item.w * 0.12), back = Math.min(20, item.d * 0.25)
          const inner = item.w - 2 * arm
          const n = Math.max(1, Math.round(inner / 70))
          const y0 = -item.d / 2 + back
          return (
            <>
              <rect x={-item.w / 2} y={-item.d / 2} width={item.w} height={back} fill="#000" opacity={0.07} />
              <line x1={-item.w / 2} y1={y0} x2={item.w / 2} y2={y0} stroke="#9a8f86" strokeWidth={1} />
              <line x1={-inner / 2} y1={y0} x2={-inner / 2} y2={item.d / 2} stroke="#9a8f86" strokeWidth={0.8} />
              <line x1={inner / 2} y1={y0} x2={inner / 2} y2={item.d / 2} stroke="#9a8f86" strokeWidth={0.8} />
              {Array.from({ length: n }, (_, i) => (
                <rect key={i} x={-inner / 2 + (i * inner) / n + 2} y={y0 + 3} width={inner / n - 4} height={item.d - back - 8} rx={4} fill="#fff" opacity={0.35} stroke="#9a8f86" strokeWidth={0.6} />
              ))}
            </>
          )
        })()}
        {item.kind === 'plant' && (() => {
          const L = Math.min(item.w, item.d) * 0.55
          return (
            <g transform="rotate(-35)">
              <path d={`M0,${-L / 2} Q${L * 0.42},0 0,${L / 2} Q${-L * 0.42},0 0,${-L / 2} Z M0,${-L / 2} L0,${L / 2}`} fill="#fff" fillOpacity={0.4} stroke="#3f6b3a" strokeWidth={1} strokeLinejoin="round" />
            </g>
          )
        })()}
        {item.kind === 'table' && item.w !== item.d && (
          <rect x={-item.w / 2 + 5} y={-item.d / 2 + 5} width={item.w - 10} height={item.d - 10} rx={2} fill="none" stroke="#b7ada3" strokeWidth={0.8} />
        )}
      </g>
      {/* double-click the name to rename the piece, the size to resize it */}
      <text className="plan-item-name" textAnchor="middle" y={-1} fontSize={fontSize}
        onDoubleClick={(e) => { e.stopPropagation(); onEdit?.(item, 'name', e.currentTarget) }}>
        <title>Double-click to rename</title>
        {item.name.split(' ').slice(0, 2).join(' ')}
      </text>
      <text className="plan-item-dim" textAnchor="middle" y={fontSize} fontSize={fontSize * 0.7}
        onDoubleClick={(e) => { e.stopPropagation(); onEdit?.(item, 'size', e.currentTarget) }}>
        <title>Double-click to change the size</title>
        {formatLength(item.w, { unit, bare: true })}×{formatLength(item.d, { unit, bare: true })}
      </text>
      {selected && !locked && <RotateHandle item={item} toRoom={toRoom} />}
      {locked && <LockBadge item={item} />}
    </g>
  )
}

/** radius of the padlock badge at a locked piece's top-right corner (plan cm) */
const LOCK_R = 7

/**
 * A small padlock just inside the top-right corner of a locked piece's footprint (its bounding
 * box, so it stays upright and in the same corner however the piece is turned). It sits inside
 * the shape so a piece against a wall keeps it clear of the wall stroke. Clicking it unlocks.
 */
function LockBadge({ item }: { item: Item }) {
  const toggleLock = useStore((s) => s.toggleLock)
  const r = rectOf(item)
  const inset = LOCK_R + 2
  const cx = r.x1 - item.x - inset
  const cy = r.y0 - item.y + inset
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  return (
    <g
      className="lock-badge"
      transform={`translate(${cx} ${cy})`}
      onPointerDown={stop}
      onClick={(e) => { e.stopPropagation(); toggleLock(item.id) }}
      style={{ cursor: 'pointer' }}
      role="button"
      aria-label="Locked in place — click to unlock"
    >
      <title>Locked in place — click to unlock</title>
      <circle r={LOCK_R} fill="#2f2a26" stroke="#fff" strokeWidth={1.2} />
      {/* shackle and body */}
      <path d={`M ${-LOCK_R * 0.3} ${-LOCK_R * 0.1} V ${-LOCK_R * 0.35} A ${LOCK_R * 0.3} ${LOCK_R * 0.3} 0 0 1 ${LOCK_R * 0.3} ${-LOCK_R * 0.35} V ${-LOCK_R * 0.1}`} fill="none" stroke="#fff" strokeWidth={1.1} strokeLinecap="round" />
      <rect x={-LOCK_R * 0.45} y={-LOCK_R * 0.1} width={LOCK_R * 0.9} height={LOCK_R * 0.6} rx={1} fill="#fff" />
    </g>
  )
}

/** how far the rotate handle sits above the item's top edge, and its size (plan cm) */
const HANDLE_STEM = 16
const HANDLE_R = 7
/** the handle snaps to these steps, and to a quarter turn when this close to one, unless Shift is held */
const SNAP_STEP = 15
const SNAP_90 = 6

/**
 * A small circle on a stem above the item's top edge (in its own turned frame). Dragging it turns
 * the item about its centre to follow the pointer, in 15° steps that also snap to the quarter
 * turns; Shift turns freely. One undo step per drag. Drawn inside the PlanItem so it moves with it,
 * and stops its pointer events so grabbing the handle never starts a move.
 */
function RotateHandle({ item, toRoom }: { item: Item; toRoom: ToRoom }) {
  const setRotation = useStore((s) => s.setRotation)
  const snapshot = useStore((s) => s.snapshot)
  const [turning, setTurning] = useState(false)
  const stem = item.d / 2 + HANDLE_STEM
  const cy = -(stem + HANDLE_R)
  const angleFrom = (e: React.PointerEvent) => {
    const p = toRoom(e)
    // the handle points "up" from the item, which is a plan angle of rot − 90°
    const raw = (Math.atan2(p.y - item.y, p.x - item.x) * 180) / Math.PI + 90
    if (e.shiftKey) return normalizeRot(Math.round(raw))
    const q = Math.round(raw / 90) * 90
    if (Math.abs(raw - q) <= SNAP_90) return normalizeRot(q)
    return normalizeRot(Math.round(raw / SNAP_STEP) * SNAP_STEP)
  }
  const onDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    e.preventDefault()
    snapshot()
    setTurning(true)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
  }
  const onMove = (e: React.PointerEvent) => {
    if (!turning) return
    e.stopPropagation()
    const rot = angleFrom(e)
    if (rot !== item.rot) setRotation(item.id, rot)
  }
  const onUp = (e: React.PointerEvent) => {
    if (!turning) return
    e.stopPropagation()
    setTurning(false)
  }
  // the label stays upright: place it in the item's unturned frame, just past the handle
  const a = (item.rot * Math.PI) / 180
  const reach = stem + 2 * HANDLE_R + 6
  const lx = Math.sin(a) * reach
  const ly = -Math.cos(a) * reach
  return (
    <g className={`rotate-handle${turning ? ' turning' : ''}`}>
      <g transform={`rotate(${item.rot})`}>
        <line x1={0} y1={-item.d / 2} x2={0} y2={-stem} stroke="#f28c28" strokeWidth={1} />
        <g
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onLostPointerCapture={() => setTurning(false)}
          style={{ cursor: turning ? 'grabbing' : 'grab', touchAction: 'none' }}
        >
          {/* a wider invisible target so the handle is easy to grab */}
          <circle cy={cy} r={HANDLE_R * 2} fill="transparent" />
          <circle cy={cy} r={HANDLE_R} fill="#fff" stroke="#f28c28" strokeWidth={1.4} />
          {/* curved arrow glyph */}
          <path
            d={`M ${-HANDLE_R * 0.55} ${cy + HANDLE_R * 0.25} A ${HANDLE_R * 0.55} ${HANDLE_R * 0.55} 0 1 1 ${HANDLE_R * 0.55} ${cy + HANDLE_R * 0.25}`}
            fill="none" stroke="#f28c28" strokeWidth={1.2} strokeLinecap="round"
          />
          <path
            d={`M ${HANDLE_R * 0.55 - 2.2} ${cy + HANDLE_R * 0.25 - 1.6} L ${HANDLE_R * 0.55} ${cy + HANDLE_R * 0.25} L ${HANDLE_R * 0.55 + 1.6} ${cy + HANDLE_R * 0.25 - 2.4}`}
            fill="none" stroke="#f28c28" strokeWidth={1.2} strokeLinecap="round" strokeLinejoin="round"
          />
        </g>
      </g>
      {turning && (
        <g transform={`translate(${lx} ${ly})`} pointerEvents="none">
          <rect x={-14} y={-6} width={28} height={12} rx={3} fill="#fff" stroke="#f28c28" strokeWidth={0.6} />
          <text className="dim-text" textAnchor="middle" y={3}>{Math.round(item.rot)}°</text>
        </g>
      )}
    </g>
  )
}

function DimLines({ item, roomW, roomD }: { item: Item; roomW: number; roomD: number }) {
  const unit = useUnits((s) => s.unit)
  const r = rectOf(item)
  const left = r.x0, right = roomW - r.x1, top = r.y0, bottom = roomD - r.y1
  const cy = (r.y0 + r.y1) / 2
  const cx = (r.x0 + r.x1) / 2
  const horiz = left <= right ? { x1: 0, x2: r.x0, v: left } : { x1: r.x1, x2: roomW, v: right }
  const vert = top <= bottom ? { y1: 0, y2: r.y0, v: top } : { y1: r.y1, y2: roomD, v: bottom }
  return (
    <g className="dims">
      {/* a turned item: the numbers measure its bounding box, so show that box */}
      {!isAxisAligned(item.rot) && (
        <rect x={r.x0} y={r.y0} width={r.x1 - r.x0} height={r.y1 - r.y0} fill="none" stroke="#e5407a" strokeWidth={0.6} strokeDasharray="2 2" pointerEvents="none" />
      )}
      {horiz.v > 2 && (
        <g>
          <line x1={horiz.x1} y1={cy} x2={horiz.x2} y2={cy} stroke="#e5407a" strokeWidth={1.2} />
          <circle cx={horiz.x1} cy={cy} r={1.8} fill="#e5407a" />
          <circle cx={horiz.x2} cy={cy} r={1.8} fill="#e5407a" />
          <rect x={(horiz.x1 + horiz.x2) / 2 - 15} y={cy - 12} width={30} height={10} rx={3} fill="#fff" stroke="#e5407a" strokeWidth={0.6} />
          <text x={(horiz.x1 + horiz.x2) / 2} y={cy - 4.5} className="dim-text" textAnchor="middle">{formatLength(horiz.v, { unit })}</text>
        </g>
      )}
      {vert.v > 2 && (
        <g>
          <line x1={cx} y1={vert.y1} x2={cx} y2={vert.y2} stroke="#e5407a" strokeWidth={1.2} />
          <circle cx={cx} cy={vert.y1} r={1.8} fill="#e5407a" />
          <circle cx={cx} cy={vert.y2} r={1.8} fill="#e5407a" />
          <rect x={cx + 3} y={(vert.y1 + vert.y2) / 2 - 5} width={30} height={10} rx={3} fill="#fff" stroke="#e5407a" strokeWidth={0.6} />
          <text x={cx + 18} y={(vert.y1 + vert.y2) / 2 + 2.5} className="dim-text" textAnchor="middle">{formatLength(vert.v, { unit })}</text>
        </g>
      )}
    </g>
  )
}

type LabelField = 'name' | 'size'

/**
 * Editing a piece's name or size in place, in a box over its label on the plan. Enter or clicking
 * away saves, Esc cancels. A size is typed as width × depth, or width × depth × height, in any
 * unit (parseSize); one that cannot be read is shown in red and not saved.
 */
function LabelEditor({ item, field, label, onDone }: { item: Item; field: LabelField; label: Element; onDone: () => void }) {
  const unit = useUnits((s) => s.unit)
  const updateItem = useStore((s) => s.updateItem)
  const resizeItem = useStore((s) => s.resizeItem)
  // the size as the box shows it: numbers parseSize reads back exactly (41.5, not 41½)
  const shownParts = [item.w, item.d, item.h].map((v) => String(toUnitNumber(v, unit)))
  const initial = field === 'name' ? item.name : shownParts.join(' × ')
  const [text, setText] = useState(initial)
  // sit over the label, and follow it when the window resizes or the page scrolls
  const [box, setBox] = useState(() => label.getBoundingClientRect())
  useEffect(() => {
    const follow = () => setBox(label.getBoundingClientRect())
    window.addEventListener('resize', follow)
    window.addEventListener('scroll', follow, true)
    return () => { window.removeEventListener('resize', follow); window.removeEventListener('scroll', follow, true) }
  }, [label])
  const [bad, setBad] = useState(false)
  const done = useRef(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { input.current?.focus(); input.current?.select() }, [])

  /** Save what was typed; true when it was saved (or nothing changed). */
  const save = (): boolean => {
    if (field === 'name') {
      const name = text.trim()
      if (name && name !== item.name) updateItem(item.id, { name })
      return true
    }
    const size = parseSize(text, unit)
    if (!size) return false
    const fit = (v: number, lo: number, hi: number) => Math.round(Math.min(hi, Math.max(lo, v)))
    // a part left as it was keeps its exact stored size (the box shows it rounded to the half inch)
    const typed = sizeParts(text)
    const same = (i: number) => typed[i] === shownParts[i]
    const next: Partial<Pick<Item, 'w' | 'd' | 'h'>> = {}
    if (!same(0)) next.w = fit(size.w, 5, 600)
    if (!same(1)) next.d = fit(size.d, 5, 600)
    if (size.h !== undefined && !same(2)) next.h = fit(size.h, 1, 400)
    if ((next.w ?? item.w) !== item.w || (next.d ?? item.d) !== item.d || (next.h ?? item.h) !== item.h) resizeItem(item.id, next)
    return true
  }
  const finish = (keep: boolean) => {
    if (done.current) return
    if (keep && !save()) {
      setBad(true)
      return
    }
    done.current = true
    onDone()
  }
  const width = Math.max(field === 'name' ? 150 : 130, box.width + 40)
  return createPortal(
    <input
      ref={input}
      className={bad ? 'plan-label-edit bad' : 'plan-label-edit'}
      style={{ left: box.left + box.width / 2 - width / 2, top: box.top + box.height / 2 - 15, width }}
      value={text}
      aria-label={field === 'name' ? `Name of ${item.name}` : `Size of ${item.name}, width × depth × height`}
      title={field === 'size' ? 'Width × depth, or width × depth × height, in any unit' : undefined}
      onChange={(e) => { setText(e.target.value); setBad(false) }}
      // (no stopPropagation: ⌘S and ⌘P still reach the app; its other shortcuts ignore text boxes)
      onKeyDown={(e) => {
        if (e.key === 'Enter') finish(true)
        if (e.key === 'Escape') { done.current = true; onDone() }
      }}
      // clicking away saves it if it can be read, and closes either way
      onBlur={() => {
        if (done.current) return
        save()
        done.current = true
        onDone()
      }}
    />,
    document.body,
  )
}
