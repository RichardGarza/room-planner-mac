import { footprint, roomPolygon, wallAxes, wallPoint } from '../geometry'
import { roomOpenings } from '../library'
import type { Door, Item, Room } from '../types'

/**
 * A small, label-free plan of a room for the library cards: walls, windows,
 * doors (gap + swing arc) and the furniture that is in the room.
 */
export function PlanThumb({ room, items, size = 180 }: { room: Room; items: Item[]; size?: number }) {
  const PAD = 12
  const W = room.w + PAD * 2
  const H = room.d + PAD * 2
  const { windows, doors } = roomOpenings(room)
  const inRoom = items.filter((i) => i.inRoom)
  const rugs = inRoom.filter((i) => i.kind === 'rug' || i.kind === 'rugRect')
  const solids = inRoom.filter((i) => i.kind !== 'rug' && i.kind !== 'rugRect')
  const height = Math.round((size * 3) / 4)
  const outline = roomPolygon(room).map((p) => p.join(',')).join(' ')

  return (
    <svg className="plan-thumb" viewBox={`0 0 ${W} ${H}`} width={size} height={height} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      <g transform={`translate(${PAD} ${PAD})`}>
        <polygon points={outline} fill="#fbf7f2" />
        {rugs.map((it) => <ThumbItem key={it.id} item={it} />)}
        {solids.map((it) => <ThumbItem key={it.id} item={it} />)}
        {doors.map((d, i) => <DoorArc key={`arc${i}`} room={room} door={d} />)}
        <polygon points={outline} fill="none" stroke="#3f3833" strokeWidth={6} strokeLinejoin="miter" />
        {windows.map((o, i) => <WindowMark key={`w${i}`} room={room} wall={o.wall} offset={o.offset} width={o.width} />)}
        {doors.map((d, i) => <DoorGap key={`d${i}`} room={room} wall={d.wall} offset={d.offset} width={d.width} />)}
      </g>
    </svg>
  )
}

function ThumbItem({ item }: { item: Item }) {
  const { fw, fd } = footprint(item)
  const round = item.kind === 'rug' || item.kind === 'chair'
  return (
    <rect
      x={item.x - fw / 2}
      y={item.y - fd / 2}
      width={fw}
      height={fd}
      rx={round ? Math.min(fw, fd) / 2 : 5}
      fill={item.color}
      stroke="rgba(0,0,0,0.18)"
      strokeWidth={1.5}
    />
  )
}

/** The opening's two ends and an 8 cm band across the wall line, turned with the wall. */
function openingBox(room: Room, wall: Door['wall'], offset: number, width: number) {
  const [x0, y0] = wallPoint(room, wall, offset)
  const [x1, y1] = wallPoint(room, wall, offset + width)
  const { normal: [nx, ny] } = wallAxes(wall, room)
  const band = [[x0 - nx * 4, y0 - ny * 4], [x1 - nx * 4, y1 - ny * 4], [x1 + nx * 4, y1 + ny * 4], [x0 + nx * 4, y0 + ny * 4]].map((p) => p.join(',')).join(' ')
  return { x0, y0, x1, y1, band }
}

function WindowMark({ room, wall, offset, width }: { room: Room; wall: Door['wall']; offset: number; width: number }) {
  const b = openingBox(room, wall, offset, width)
  return (
    <g>
      <polygon points={b.band} fill="#fff" stroke="#3f3833" strokeWidth={1} />
      <line x1={b.x0} y1={b.y0} x2={b.x1} y2={b.y1} stroke="#8fb5d6" strokeWidth={3} />
    </g>
  )
}

function DoorGap({ room, wall, offset, width }: { room: Room; wall: Door['wall']; offset: number; width: number }) {
  const b = openingBox(room, wall, offset, width)
  return <polygon points={b.band} fill="#fbf7f2" />
}

function DoorArc({ room, door }: { room: Room; door: Door }) {
  const { along, normal } = wallAxes(door.wall, room)
  const sign = door.hinge === 'left' ? 1 : -1
  const out = door.swing === 'out' ? -1 : 1
  const [hx, hy] = wallPoint(room, door.wall, door.hinge === 'left' ? door.offset : door.offset + door.width)
  const dir = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180
    return [sign * along[0] * Math.cos(a) + out * normal[0] * Math.sin(a), sign * along[1] * Math.cos(a) + out * normal[1] * Math.sin(a)]
  }
  const r = door.width
  const [x0, y0] = dir(0)
  const [x1, y1] = dir(90)
  const [mx, my] = dir(45)
  const sweep = x0 * my - y0 * mx > 0 ? 1 : 0
  return (
    <g>
      <path d={`M ${hx + x0 * r} ${hy + y0 * r} A ${r} ${r} 0 0 ${sweep} ${hx + x1 * r} ${hy + y1 * r}`} fill="none" stroke="#c9bfb4" strokeWidth={1.5} strokeDasharray="4 4" />
      <line x1={hx} y1={hy} x2={hx + x1 * r} y2={hy + y1 * r} stroke="#5c534b" strokeWidth={2.5} />
    </g>
  )
}
