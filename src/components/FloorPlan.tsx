import { useCallback, useRef, useState } from 'react'
import { closetClearance, closetRecessRect, doorSwing, footprint, frontRecessPad, isAxisAligned, isCorner, normalizeRot, rectOf, roomPolygon, wallAxes, wallPoint, wallSpan, wallStripRect } from '../geometry'
import { isRugKind } from '../placement'
import { useStore } from '../store'
import type { AnyWall, Closet, Door, Item, Room, Wall } from '../types'
import { CM_PER_IN, formatLength, useUnits } from '../units'

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
  const spanL = wallSpan(room, 'left'), spanR = wallSpan(room, 'right')

  return (
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
        {/* wall tints */}
        <rect x={-6} y={spanL[0]} width={6} height={spanL[1] - spanL[0]} fill={room.wallColors.left} />
        <rect x={room.w} y={spanR[0]} width={6} height={spanR[1] - spanR[0]} fill={room.wallColors.right} />
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

        {/* rugs first, then solid items */}
        {items.filter((i) => i.inRoom && isRugKind(i.kind)).map((it) => (
          <PlanItem key={it.id} item={it} selected={it.id === selectedId} onDown={onDown} toRoom={toRoom} />
        ))}
        {items.filter((i) => i.inRoom && !isRugKind(i.kind)).map((it) => (
          <PlanItem key={it.id} item={it} selected={it.id === selectedId} onDown={onDown} toRoom={toRoom} />
        ))}

        {/* door swings (an out-swinging door draws its arc outside the room) */}
        {room.doors.map((door) => <DoorSwing key={door.id} room={room} door={door} />)}

        {/* walls, angled ones across cut corners included */}
        <polygon points={outline} fill="none" stroke="#3f3833" strokeWidth={6} strokeLinejoin="miter" />
        {/* windows */}
        {room.windows.map((win) => <Opening key={win.id} room={room} wall={win.wall} offset={win.offset} width={win.width} kind="window" />)}
        {/* door openings */}
        {room.doors.map((door) => <Opening key={door.id} room={room} wall={door.wall} offset={door.offset} width={door.width} kind="door" />)}
        {/* closets: recess outside the wall, the opening, its doors and the floor they need */}
        {(room.closets ?? []).map((c) => <ClosetPlan key={c.id} room={room} closet={c} />)}

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
        {(['top', 'bottom', 'left', 'right'] as const)
          .filter((w) => !wallsWithOpenings.has(w))
          .map((w) => (
            <WallText key={w} room={room} wall={w} t={(wallSpan(room, w)[0] + wallSpan(room, w)[1]) / 2} text={w === 'left' ? 'LEFT WALL' : w === 'right' ? 'RIGHT WALL' : w === 'top' ? 'BACK WALL' : 'FRONT WALL'} />
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
          <PlanItem key={it.id} item={it} selected={it.id === selectedId} onDown={onDown} toRoom={toRoom} muted />
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
function ClosetPlan({ room, closet: c }: { room: Room; closet: Closet }) {
  const { along, normal } = wallAxes(c.wall)
  const [x0, y0] = wallPoint(room, c.wall, c.offset)
  const recess = closetRecessRect(room, c)
  const clear = closetClearance(room, c)
  // local frame: origin at the opening's start on the wall line, u along the wall, v into the room
  const pt = (u: number, v: number): [number, number] => [x0 + along[0] * u + normal[0] * v, y0 + along[1] * u + normal[1] * v]
  const P = (u: number, v: number) => pt(u, v).join(' ')
  const w = c.width
  const half = w / 2
  const wallHalf = 3
  const horizontal = c.wall === 'top' || c.wall === 'bottom'
  // label towards the back of the recess so it stays clear of the wall's own label
  const [lx, ly] = pt(half, -Math.max(c.depth * 0.7, c.depth - 14) - wallHalf)
  const labelRot = horizontal ? 0 : c.wall === 'left' ? -90 : 90
  const [gx, gy] = pt(0, -4)
  return (
    <g className="closet">
      {/* the recess beyond the wall (the wall stroke covers its inner edge) */}
      <rect x={recess.x0} y={recess.y0} width={recess.x1 - recess.x0} height={recess.y1 - recess.y0} fill="#f6f1ea" stroke="#8f867d" strokeWidth={0.8}
        transform={`translate(${-normal[0] * wallHalf} ${-normal[1] * wallHalf})`} />
      {/* floor that stays free in front */}
      <rect x={clear.rect.x0} y={clear.rect.y0} width={clear.rect.x1 - clear.rect.x0} height={clear.rect.y1 - clear.rect.y0} fill="#8f867d" fillOpacity={0.05} stroke="#c9bfb4" strokeWidth={0.8} strokeDasharray="3 3" />
      {/* the opening: a gap in the wall */}
      <rect x={horizontal ? gx : Math.min(gx, gx + normal[0] * 8)} y={horizontal ? Math.min(gy, gy + normal[1] * 8) : gy} width={horizontal ? w : 8} height={horizontal ? 8 : w} fill="#f6f1ea" />
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
      <text transform={`translate(${lx} ${ly + (labelRot ? 0 : 2.5)}) rotate(${labelRot})`} className="plan-label" textAnchor="middle" dominantBaseline={labelRot ? 'middle' : undefined}>CLOSET</text>
    </g>
  )
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

function WallText({ room, wall, t, text, dist = 14 }: { room: Room; wall: AnyWall; t: number; text: string; dist?: number }) {
  const [x, y] = wallPoint(room, wall, t)
  const { along, normal } = wallAxes(wall, room)
  const ox = -normal[0] * dist, oy = -normal[1] * dist
  // along an angled wall, turned with it and kept the right way up
  const slant = (Math.atan2(along[1], along[0]) * 180) / Math.PI
  const rot = wall === 'left' ? -90 : wall === 'right' ? 90 : isCorner(wall) ? (slant > 90 ? slant - 180 : slant < -90 ? slant + 180 : slant) : 0
  return (
    <text transform={`translate(${x + ox} ${y + oy + (wall === 'top' ? 2 : wall === 'bottom' ? 4 : 0)}) rotate(${rot})`} className="plan-label" textAnchor="middle" dominantBaseline={rot ? 'middle' : undefined}>
      {text}
    </text>
  )
}

type ToRoom = (e: React.PointerEvent) => { x: number; y: number }

function PlanItem({ item, selected, onDown, toRoom, muted }: { item: Item; selected: boolean; onDown: (e: React.PointerEvent, it: Item) => void; toRoom: ToRoom; muted?: boolean }) {
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
      <text className="plan-item-name" textAnchor="middle" y={-1} fontSize={fontSize}>
        {item.name.split(' ').slice(0, 2).join(' ')}
      </text>
      <text className="plan-item-dim" textAnchor="middle" y={fontSize} fontSize={fontSize * 0.7}>
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
