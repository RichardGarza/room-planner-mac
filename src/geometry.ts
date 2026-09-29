import type { AnyWall, CheckLevel, Closet, Door, EdgeWall, Item, ItemKind, Rect, Room, Wall } from './types'

/** Rugs are walked over and lie under other furniture, so they never collide. */
export function isRugKind(kind: ItemKind) {
  return kind === 'rug' || kind === 'rugRect'
}

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Any angle in degrees brought into [0, 360), rounded to 0.01° so float noise never stops 90 from being 90. */
export function normalizeRot(deg: number): number {
  if (!Number.isFinite(deg)) return 0
  const r = Math.round((((deg % 360) + 360) % 360) * 100) / 100
  return r >= 360 ? 0 : r
}

/** True for 0 / 90 / 180 / 270: the item's edges run along the room's walls. */
export function isAxisAligned(rot: number) {
  return normalizeRot(rot) % 90 === 0
}

/** The multiple of 90 nearest to an angle (for code that only knows the four wall-facing directions). */
export function snap90(rot: number): 0 | 90 | 180 | 270 {
  return ((Math.round(normalizeRot(rot) / 90) * 90) % 360) as 0 | 90 | 180 | 270
}

/** cos / sin of a plan rotation; exact for multiples of 90 so axis-aligned corners stay exact. */
function rotTrig(rot: number): [number, number] {
  const r = normalizeRot(rot)
  if (r % 90 === 0) {
    const q = (r / 90) % 4
    return [[1, 0, -1, 0][q], [0, 1, 0, -1][q]]
  }
  const a = (r * Math.PI) / 180
  return [Math.cos(a), Math.sin(a)]
}

/**
 * Footprint size after rotation: the axis-aligned extents. Exact for 0 / 90 / 180 / 270; for any
 * other angle fw = |w cos θ| + |d sin θ|, fd = |w sin θ| + |d cos θ| (the rotated box's bounding box),
 * so everything that works with rectOf stays conservative.
 */
export function footprint(item: Pick<Item, 'w' | 'd' | 'rot'>) {
  const [c, s] = rotTrig(item.rot)
  return { fw: Math.abs(item.w * c) + Math.abs(item.d * s), fd: Math.abs(item.w * s) + Math.abs(item.d * c) }
}

/** Axis-aligned bounding box of the (possibly turned) item. */
export function rectOf(item: Item): Rect {
  const { fw, fd } = footprint(item)
  return { x0: item.x - fw / 2, y0: item.y - fd / 2, x1: item.x + fw / 2, y1: item.y + fd / 2 }
}

/** A convex polygon in room coordinates, corners in order. */
export type Polygon = [number, number][]

/** The item's four corners after rotation about its centre (same winding as SVG's rotate: clockwise on the plan). */
export function polygonOf(item: Pick<Item, 'w' | 'd' | 'rot' | 'x' | 'y'>): Polygon {
  const [c, s] = rotTrig(item.rot)
  const hw = item.w / 2, hd = item.d / 2
  const local: [number, number][] = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]]
  return local.map(([lx, ly]) => [item.x + lx * c - ly * s, item.y + lx * s + ly * c])
}

export function rectToPolygon(r: Rect): Polygon {
  return [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]
}

export function polygonBounds(poly: Polygon): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const [x, y] of poly) {
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  return { x0, y0, x1, y1 }
}

/** True when every edge runs along x or y (the polygon is an axis-aligned box). */
function polygonIsAxisAligned(poly: Polygon) {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]
    if (Math.abs(ax - bx) > 1e-9 && Math.abs(ay - by) > 1e-9) return false
  }
  return true
}

/**
 * Separating-axis test for two convex polygons. Like `intersects` for rects, they only count as
 * overlapping when they share more than `tolerance` cm along every axis, so edges touching is fine.
 */
export function polygonsIntersect(a: Polygon, b: Polygon, tolerance = 0.5) {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]
      const ex = bx - ax, ey = by - ay
      const len = Math.hypot(ex, ey)
      if (len < 1e-9) continue
      // the edge normal, unit length so the tolerance is in cm
      const nx = -ey / len, ny = ex / len
      let minA = Infinity, maxA = -Infinity, minB = Infinity, maxB = -Infinity
      for (const [x, y] of a) { const p = x * nx + y * ny; if (p < minA) minA = p; if (p > maxA) maxA = p }
      for (const [x, y] of b) { const p = x * nx + y * ny; if (p < minB) minB = p; if (p > maxB) maxB = p }
      if (Math.min(maxA, maxB) - Math.max(minA, minB) <= tolerance) return false
    }
  }
  return true
}

/** Does a polygon reach into a rect (a wall strip, a doorway, the floor a closet needs)? Exact for turned items. */
export function polygonIntersectsRect(poly: Polygon, rect: Rect, tolerance = 0.5) {
  const bounds = polygonBounds(poly)
  if (!intersects(bounds, rect, tolerance)) return false
  if (polygonIsAxisAligned(poly)) return true
  return polygonsIntersect(poly, rectToPolygon(rect), tolerance)
}

/** Exact overlap test between two items: their bounding boxes when both stand square, else their turned outlines. */
export function itemsIntersect(a: Item, b: Item, tolerance = 0.5) {
  if (isAxisAligned(a.rot) && isAxisAligned(b.rot)) return intersects(rectOf(a), rectOf(b), tolerance)
  const pa = polygonOf(a), pb = polygonOf(b)
  if (!intersects(polygonBounds(pa), polygonBounds(pb), tolerance)) return false
  return polygonsIntersect(pa, pb, tolerance)
}

/** Strictly inside a convex polygon (points on the outline do not count), whichever way it winds. */
export function pointInPolygon(px: number, py: number, poly: Polygon) {
  let sign = 0
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i], [bx, by] = poly[(i + 1) % poly.length]
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax)
    if (Math.abs(cross) < 1e-9) return false
    const s = cross > 0 ? 1 : -1
    if (sign === 0) sign = s
    else if (s !== sign) return false
  }
  return true
}

export function overlapArea(a: Rect, b: Rect) {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  const h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  return w > 0 && h > 0 ? w * h : 0
}

export function intersects(a: Rect, b: Rect, tolerance = 0.5) {
  return a.x0 < b.x1 - tolerance && a.x1 > b.x0 + tolerance && a.y0 < b.y1 - tolerance && a.y1 > b.y0 + tolerance
}

/** Gap between two rects along x or y when they overlap on the other axis. null when they are diagonal. */
export function gapBetween(a: Rect, b: Rect): { axis: 'x' | 'y'; gap: number } | null {
  const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
  const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)
  if (overlapY > 10) {
    const gap = a.x0 < b.x0 ? b.x0 - a.x1 : a.x0 - b.x1
    return { axis: 'x', gap }
  }
  if (overlapX > 10) {
    const gap = a.y0 < b.y0 ? b.y0 - a.y1 : a.y0 - b.y1
    return { axis: 'y', gap }
  }
  return null
}

/* ---------- walls: the four sides of a plain room, or the walls of a drawn outline ---------- */

type Shape = Pick<Room, 'w' | 'd' | 'outline'>

export const SIDES: Wall[] = ['top', 'right', 'bottom', 'left']
/** Fewest and most walls a drawn room may have. */
export const MIN_WALLS = 3
export const MAX_WALLS = 20

export function isSide(wall: AnyWall): wall is Wall {
  return wall === 'top' || wall === 'bottom' || wall === 'left' || wall === 'right'
}

/** The outline wall id for point i (wall "e<i>" starts there). */
export const edgeWall = (i: number): EdgeWall => `e${i}`

/** Index of an outline wall ("e3" → 3), or -1 for a side. */
export function edgeIndex(wall: AnyWall): number {
  return isSide(wall) ? -1 : Number(wall.slice(1))
}

/** Every wall of the room, going round clockwise: the outline's walls, or back, right, front, left. */
export function roomWalls(room: Shape): AnyWall[] {
  return room.outline ? room.outline.map((_, i) => edgeWall(i)) : ['top', 'right', 'bottom', 'left']
}

/** The floor outline, clockwise on the plan (y down). */
export function roomPolygon(room: Shape): Polygon {
  return room.outline ? room.outline.map(([x, y]) => [x, y]) : [[0, 0], [room.w, 0], [room.w, room.d], [0, room.d]]
}

export interface WallFrame {
  /** where offset 0 is */
  start: [number, number]
  /** unit vector of increasing offset */
  along: [number, number]
  /** unit vector pointing into the room */
  normal: [number, number]
  length: number
}

/**
 * A wall as a line: start point, direction, inward normal and length. A side keeps its old meaning
 * (offset from the x = 0 or y = 0 end). An outline wall runs from its point to the next one; going
 * round clockwise, the room is on its right, so the inward normal is its direction turned 90°.
 */
export function wallFrame(room: Shape, wall: AnyWall): WallFrame {
  if (isSide(wall)) {
    const { along, normal } = sideAxes(wall)
    return { start: sidePoint(room, wall, 0), along, normal, length: wall === 'top' || wall === 'bottom' ? room.w : room.d }
  }
  const pts = room.outline ?? roomPolygon(room)
  const i = ((edgeIndex(wall) % pts.length) + pts.length) % pts.length
  const a = pts[i], b = pts[(i + 1) % pts.length]
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-9
  const along: [number, number] = [(b[0] - a[0]) / length, (b[1] - a[1]) / length]
  return { start: [a[0], a[1]], along, normal: [-along[1], along[0]], length }
}

/** The stretch of a wall that openings may use: all of it. */
export function wallSpan(room: Shape, wall: AnyWall): [number, number] {
  return [0, wallLength(room, wall)]
}

/**
 * The side of the room box a wall lies on, when it runs straight along one (every wall of a plain
 * room; the outer walls of a drawn room that follow the box), with an opening's offset turned into
 * that side's coordinate. Null for a wall inside the box or at an angle.
 */
export function sideOf(room: Shape, wall: AnyWall, offset: number, width: number): { wall: Wall; offset: number; width: number } | null {
  if (isSide(wall)) return { wall, offset, width }
  const f = wallFrame(room, wall)
  const p0 = wallPoint(room, wall, offset), p1 = wallPoint(room, wall, offset + width)
  const on = (v: number, at: number) => Math.abs(v - at) < 0.5
  if (Math.abs(f.along[1]) < 1e-6) {
    const x0 = Math.min(p0[0], p1[0])
    if (on(f.start[1], 0) && f.normal[1] > 0) return { wall: 'top', offset: x0, width }
    if (on(f.start[1], room.d) && f.normal[1] < 0) return { wall: 'bottom', offset: x0, width }
  }
  if (Math.abs(f.along[0]) < 1e-6) {
    const y0 = Math.min(p0[1], p1[1])
    if (on(f.start[0], 0) && f.normal[0] > 0) return { wall: 'left', offset: y0, width }
    if (on(f.start[0], room.w) && f.normal[0] < 0) return { wall: 'right', offset: y0, width }
  }
  return null
}

/** Which way a wall faces, to the nearest side: an outline wall facing into the room from the back is 'top'. */
export function wallFacing(room: Shape, wall: AnyWall): Wall {
  if (isSide(wall)) return wall
  const [nx, ny] = wallFrame(room, wall).normal
  if (Math.abs(ny) >= Math.abs(nx)) return ny > 0 ? 'top' : 'bottom'
  return nx > 0 ? 'left' : 'right'
}

/** "Back wall", "Wall 3", … */
export function wallName(wall: AnyWall): string {
  if (isSide(wall)) return { top: 'Back wall', bottom: 'Front wall', left: 'Left wall', right: 'Right wall' }[wall]
  return `Wall ${edgeIndex(wall) + 1}`
}

/** Signed area of a plan polygon: positive when it runs clockwise on the plan (y down). */
export function polygonArea(poly: Polygon): number {
  let a = 0
  for (let i = 0; i < poly.length; i++) {
    const [x0, y0] = poly[i], [x1, y1] = poly[(i + 1) % poly.length]
    a += x0 * y1 - x1 * y0
  }
  return a / 2
}

function segmentsCross(a: [number, number], b: [number, number], c: [number, number], d: [number, number]) {
  const o = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0])
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d)
  return ((d1 > 1e-9 && d2 < -1e-9) || (d1 < -1e-9 && d2 > 1e-9)) && ((d3 > 1e-9 && d4 < -1e-9) || (d3 < -1e-9 && d4 > 1e-9))
}

/** True when no two walls of the outline cross (neighbours share their corner and do not count). */
export function isSimplePolygon(poly: Polygon): boolean {
  const n = poly.length
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue
      if (segmentsCross(poly[i], poly[(i + 1) % n], poly[j], poly[(j + 1) % n])) return false
    }
  }
  return true
}

/** A convex polygon (clockwise on the plan, y down) pushed out by `d` on every side, corners mitred. */
export function offsetPolygon(poly: Polygon, d: number): Polygon {
  const n = poly.length
  const lines = poly.map((a, i) => {
    const b = poly[(i + 1) % n]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    const out: [number, number] = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len]
    return { p: [a[0] + out[0] * d, a[1] + out[1] * d] as [number, number], dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] as [number, number] }
  })
  return poly.map((_, i) => {
    const l1 = lines[(i + n - 1) % n], l2 = lines[i]
    const den = l1.dir[0] * l2.dir[1] - l1.dir[1] * l2.dir[0]
    if (Math.abs(den) < 1e-9) return l2.p
    const t = ((l2.p[0] - l1.p[0]) * l2.dir[1] - (l2.p[1] - l1.p[1]) * l2.dir[0]) / den
    return [l1.p[0] + l1.dir[0] * t, l1.p[1] + l1.dir[1] * t]
  })
}

/** Point in any simple polygon, convex or not (even–odd rule); pointInPolygon is the faster convex-only test. */
export function pointInOutline(px: number, py: number, poly: Polygon): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j]
    if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** True when a point is on the room's floor (a drawn outline, or the box). */
export function pointInRoom(room: Shape, px: number, py: number): boolean {
  if (px < -0.01 || py < -0.01 || px > room.w + 0.01 || py > room.d + 0.01) return false
  return !room.outline || pointInOutline(px, py, room.outline)
}

/** Shortest distance from a point to any wall line of the room. */
export function distanceToWalls(room: Shape, px: number, py: number): number {
  let best = Infinity
  const pts = roomPolygon(room)
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = clamp(((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1), 0, 1)
    best = Math.min(best, Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t))
  }
  return best
}

/**
 * True when a piece's outline (or any polygon) stands on the room's floor: every corner inside,
 * and no corner of the room poking into it (a notch of an L-shaped room). 0.5 cm of slack.
 */
export function polygonInRoom(room: Shape, poly: Polygon): boolean {
  if (poly.some(([x, y]) => x < -0.5 || y < -0.5 || x > room.w + 0.5 || y > room.d + 0.5)) return false
  if (!room.outline) return true
  const outline = room.outline
  // a corner within 0.5 cm of a wall counts as inside (furniture pushed against a slanted wall)
  if (poly.some(([x, y]) => !pointInOutline(x, y, outline) && distanceToWalls(room, x, y) > 0.5)) return false
  return !outline.some(([x, y]) => pointInPolygon(x, y, poly) && distanceToPolygonEdges(poly, x, y) > 0.5)
}

function distanceToPolygonEdges(poly: Polygon, px: number, py: number): number {
  return distanceToWalls({ w: Infinity, d: Infinity, outline: poly }, px, py)
}

/** True when a rect lies on the room's floor. */
export function rectInRoom(room: Shape, r: Rect): boolean {
  if (r.x0 < -0.01 || r.y0 < -0.01 || r.x1 > room.w + 0.01 || r.y1 > room.d + 0.01) return false
  if (!room.outline) return true // the common case, and a hot path in the suggestions
  return polygonInRoom(room, rectToPolygon(r))
}

/** The strip an opening covers on its wall, reaching `depth` cm into the room (negative: out of it), as a polygon. */
export function wallStripPolygon(room: Shape, wall: AnyWall, offset: number, width: number, depth: number): Polygon {
  const f = wallFrame(room, wall)
  const p = (t: number, n: number): [number, number] => [f.start[0] + f.along[0] * t + f.normal[0] * n, f.start[1] + f.along[1] * t + f.normal[1] * n]
  return [p(offset, 0), p(offset + width, 0), p(offset + width, depth), p(offset, depth)]
}

/**
 * Rect that an opening / radiator occupies against its wall, projected `depth` cm into the room.
 * On an outline wall it is the box around that strip (exact when the wall runs straight across
 * or down the plan; wallStripPolygon has the exact shape of a slanted one).
 */
export function wallStripRect(room: Shape, wall: AnyWall, offset: number, width: number, depth: number): Rect {
  switch (wall) {
    case 'top':
      return { x0: offset, y0: 0, x1: offset + width, y1: depth }
    case 'bottom':
      return { x0: offset, y0: room.d - depth, x1: offset + width, y1: room.d }
    case 'left':
      return { x0: 0, y0: offset, x1: depth, y1: offset + width }
    case 'right':
      return { x0: room.w - depth, y0: offset, x1: room.w, y1: offset + width }
    default:
      return polygonBounds(wallStripPolygon(room, wall, offset, width, depth))
  }
}

function sideAxes(wall: Wall): { along: [number, number]; normal: [number, number] } {
  switch (wall) {
    case 'top': return { along: [1, 0], normal: [0, 1] }
    case 'bottom': return { along: [1, 0], normal: [0, -1] }
    case 'left': return { along: [0, 1], normal: [1, 0] }
    case 'right': return { along: [0, 1], normal: [-1, 0] }
  }
}

function sidePoint(room: Shape, wall: Wall, t: number): [number, number] {
  switch (wall) {
    case 'top': return [t, 0]
    case 'bottom': return [t, room.d]
    case 'left': return [0, t]
    case 'right': return [room.w, t]
  }
}

/**
 * Unit tangent along a wall (direction of increasing offset) and the normal pointing into the room.
 * An outline wall needs the room to know its direction.
 */
export function wallAxes(wall: Wall): { along: [number, number]; normal: [number, number] }
export function wallAxes(wall: AnyWall, room: Shape): { along: [number, number]; normal: [number, number] }
export function wallAxes(wall: AnyWall, room?: Shape): { along: [number, number]; normal: [number, number] } {
  if (isSide(wall)) return sideAxes(wall)
  if (!room) throw new Error(`wallAxes: wall ${wall} needs the room`)
  const { along, normal } = wallFrame(room, wall)
  return { along, normal }
}

/** Point on a wall line at distance `t` along it from its start (the x = 0 or y = 0 end of a side). */
export function wallPoint(room: Shape, wall: AnyWall, t: number): [number, number] {
  if (isSide(wall)) return sidePoint(room, wall, t)
  const f = wallFrame(room, wall)
  return [f.start[0] + f.along[0] * t, f.start[1] + f.along[1] * t]
}

export function wallLength(room: Shape, wall: AnyWall) {
  if (isSide(wall)) return wall === 'top' || wall === 'bottom' ? room.w : room.d
  return wallFrame(room, wall).length
}

/**
 * Door swing: hinge point, and the leaf direction as a function of the opening angle.
 * `hinge: 'left'` means the hinge sits at the smaller offset along the wall.
 * A door that swings "out" sweeps away from the room: the wall normal is mirrored.
 */
export function doorSwing(room: Room, door: Door) {
  const { along, normal: inward } = wallAxes(door.wall, room)
  const out = door.swing === 'out'
  const normal: [number, number] = out ? [-inward[0], -inward[1]] : inward
  const sign = door.hinge === 'left' ? 1 : -1
  const [hx, hy] = wallPoint(room, door.wall, door.hinge === 'left' ? door.offset : door.offset + door.width)
  const leafDir = (deg: number): [number, number] => {
    const a = (deg * Math.PI) / 180
    return [sign * along[0] * Math.cos(a) + normal[0] * Math.sin(a), sign * along[1] * Math.cos(a) + normal[1] * Math.sin(a)]
  }
  return { hx, hy, r: door.width, leafDir, sign, out }
}

/** Strip `depth` cm into the room in front of a door: what must stay clear to walk through it. */
export function doorwayRect(room: Room, door: Door, depth = 40): Rect {
  return wallStripRect(room, door.wall, door.offset, door.width, depth)
}

/** The same strip as a polygon, exact on an angled wall too. */
export function doorwayPolygon(room: Room, door: Door, depth = 40): Polygon {
  return wallStripPolygon(room, door.wall, door.offset, door.width, depth)
}

/**
 * Max angle (deg, 0..90) one door can open before hitting an item.
 * An out-swinging leaf never meets the furniture, so it always reports 90.
 */
export function doorClearanceFor(room: Room, door: Door, items: Item[]) {
  let best = 90
  let blocker: Item | null = null
  if (door.swing === 'out') return { maxAngle: best, blocker }
  const { hx, hy, r, leafDir } = doorSwing(room, door)
  for (const it of items) {
    if (!it.inRoom || isRugKind(it.kind)) continue
    const poly = polygonOf(it)
    const rc = polygonBounds(poly)
    for (let deg = 5; deg <= 90; deg += 5) {
      const [dx, dy] = leafDir(deg)
      let hit = false
      for (const f of [0.3, 0.5, 0.7, 0.85, 1]) {
        const px = hx + dx * r * f
        const py = hy + dy * r * f
        if (px > rc.x0 && px < rc.x1 && py > rc.y0 && py < rc.y1 && pointInPolygon(px, py, poly)) { hit = true; break }
      }
      if (hit) {
        if (deg - 5 < best) { best = deg - 5; blocker = it }
        break
      }
    }
  }
  return { maxAngle: best, blocker }
}

/** Worst clearance over all the room's doors (90 with nothing in the way). */
export function doorClearance(room: Room, items: Item[]) {
  let result: { maxAngle: number; blocker: Item | null; door: Door | null } = { maxAngle: 90, blocker: null, door: null }
  for (const door of room.doors) {
    const c = doorClearanceFor(room, door, items)
    if (c.maxAngle < result.maxAngle) result = { ...c, door }
  }
  return result
}

/* ---------- closets ---------- */

/** Default height of a closet opening (cm). */
export const CLOSET_HEIGHT = 203

/** The closet opening as a strip on the wall line, projected `depth` cm into the room (0 = the line itself). */
export function closetOpeningRect(room: Room, closet: Closet, depth = 0): Rect {
  return wallStripRect(room, closet.wall, closet.offset, closet.width, depth)
}

/** The recess itself: the closet's depth beyond the wall line, outside the room. */
export function closetRecessRect(room: Room, closet: Closet): Rect {
  if (!isSide(closet.wall)) return polygonBounds(closetRecessPolygon(room, closet))
  const { normal } = sideAxes(closet.wall)
  const strip = closetOpeningRect(room, closet, 0)
  const dx = -normal[0] * closet.depth, dy = -normal[1] * closet.depth
  return {
    x0: Math.min(strip.x0, strip.x0 + dx), y0: Math.min(strip.y0, strip.y0 + dy),
    x1: Math.max(strip.x1, strip.x1 + dx), y1: Math.max(strip.y1, strip.y1 + dy),
  }
}

/** The recess as a polygon: exact on a slanted wall too. */
export function closetRecessPolygon(room: Room, closet: Closet): Polygon {
  return wallStripPolygon(room, closet.wall, closet.offset, closet.width, -closet.depth)
}

/** How deep the floor in front of a closet must stay free for its doors to work (or for you to reach in). */
export function closetClearanceDepth(closet: Closet): number {
  switch (closet.doors) {
    case 'hinged': return Math.round(closet.width / 2 + 10)
    case 'bifold': return Math.round(closet.width / 4 + 15)
    case 'sliding': return 40
    case 'none': return 40
  }
}

export interface ClosetClearance {
  /** the floor area inside the room that should stay free */
  rect: Rect
  /** hinged and bi-fold doors cannot open at all when blocked; a sliding or open closet is only awkward */
  level: Exclude<CheckLevel, 'ok'>
  /** the check text for an item standing in the rect; `label` is "the closet" or "closet 2" */
  text: (itemName: string, label?: string) => string
}

/**
 * The area in front of a closet that must stay free, and the check it raises when something stands there:
 * no doors → 40 cm (warn: you can still reach in), sliding → 40 cm (warn), bi-fold → width/4 + 15 cm (bad),
 * hinged → width/2 + 10 cm, two leaves each half the width swinging into the room (bad).
 */
export function closetClearance(room: Room, closet: Closet): ClosetClearance {
  const rect = closetOpeningRect(room, closet, closetClearanceDepth(closet))
  const blocksDoors = closet.doors === 'hinged' || closet.doors === 'bifold'
  return {
    rect,
    level: blocksDoors ? 'bad' : 'warn',
    text: (itemName, label = 'the closet') => (blocksDoors ? `${itemName} blocks ${label === 'the closet' ? 'the closet doors' : `the doors of ${label}`}` : `${itemName} is in front of ${label}`),
  }
}

/**
 * How far the plan's parking strip has to move down to clear a closet recess on the front wall
 * (the strip normally starts 30 cm below the room, with 10 cm to spare beyond the recess).
 */
export function frontRecessPad(room: Room): number {
  const closets = room.closets ?? []
  if (!closets.length) return 0
  return Math.max(0, ...closets.filter((c) => c.wall !== 'top' && c.wall !== 'left' && c.wall !== 'right').map((c) => closetRecessRect(room, c).y1 - room.d + 10 - 30))
}

/** "the closet" with one, "closet 2" with several (1-based). */
export function closetLabel(i: number, count: number) {
  return count > 1 ? `closet ${i + 1}` : 'the closet'
}

export function wallLabel(w: Wall) {
  return { top: 'window wall', bottom: 'door wall', left: 'left wall', right: 'right wall' }[w]
}

/* ---------- access space: the floor a piece needs in front of it ---------- */

/** Which faces of a piece need a free strip, and whether every listed face needs one or any one will do. */
export interface AccessRule {
  /** how deep the free strip is (cm) */
  depth: number
  /** the front (+d side, where the drawers and doors are), every side, or the two long sides */
  faces: 'front' | 'all' | 'long'
  /** 'all': every listed face must be free; 'any': one free face is enough */
  mode: 'all' | 'any'
  /** what the space is for, e.g. "drawers" */
  reason: string
}

/**
 * How much floor each kind of furniture needs in front of it to be usable: drawers and doors
 * have to open, a chair has to pull out, legs need room, a bed needs one side to get in.
 * Tables depend on their size (see accessRuleFor); chairs, plants, boxes and rugs need nothing.
 */
export const accessRules: Record<ItemKind, AccessRule | null> = {
  dresser: { depth: 45, faces: 'front', mode: 'all', reason: 'drawers' },
  nightstand: { depth: 45, faces: 'front', mode: 'all', reason: 'drawers' },
  wardrobe: { depth: 65, faces: 'front', mode: 'all', reason: 'doors' },
  bookcase: { depth: 40, faces: 'front', mode: 'all', reason: 'shelves' },
  shelf: { depth: 40, faces: 'front', mode: 'all', reason: 'shelves' },
  desk: { depth: 65, faces: 'front', mode: 'all', reason: 'chair' },
  sofa: { depth: 60, faces: 'front', mode: 'all', reason: 'legroom' },
  /** dining tables (w ≥ 120) need 60 cm on every side; smaller tables 45 cm on at least one side */
  table: { depth: 60, faces: 'all', mode: 'all', reason: 'seats' },
  bed: { depth: 60, faces: 'long', mode: 'any', reason: 'getting in' },
  chair: null,
  plant: null,
  box: null,
  rug: null,
  rugRect: null,
}

/** The access rule for one piece (tables depend on their size). */
export function accessRuleFor(item: Pick<Item, 'kind' | 'w' | 'd'>): AccessRule | null {
  if (item.kind === 'table') return item.w >= 120 ? accessRules.table : { depth: 45, faces: 'all', mode: 'any', reason: 'reach' }
  return accessRules[item.kind]
}

/** A point given in the item's own frame (x across its width, y front-to-back, origin at its centre), in room coordinates. */
export function localToRoom(item: Pick<Item, 'x' | 'y' | 'rot'>, lx: number, ly: number): [number, number] {
  const [c, s] = rotTrig(item.rot)
  return [item.x + lx * c - ly * s, item.y + lx * s + ly * c]
}

/** A rect in the item's own frame, turned with it: corners in the same winding as polygonOf. */
export function localPolygon(item: Pick<Item, 'x' | 'y' | 'rot'>, lx0: number, ly0: number, lx1: number, ly1: number): Polygon {
  return [localToRoom(item, lx0, ly0), localToRoom(item, lx1, ly0), localToRoom(item, lx1, ly1), localToRoom(item, lx0, ly1)]
}

export type Face = 'front' | 'back' | 'left' | 'right'

/** The strip `depth` cm beyond one face of a piece, turned with it. Front is the +d side. */
export function faceZone(item: Pick<Item, 'x' | 'y' | 'rot' | 'w' | 'd'>, face: Face, depth: number): Polygon {
  const hw = item.w / 2, hd = item.d / 2
  switch (face) {
    case 'front': return localPolygon(item, -hw, hd, hw, hd + depth)
    case 'back': return localPolygon(item, -hw, -hd - depth, hw, -hd)
    case 'left': return localPolygon(item, -hw - depth, -hd, -hw, hd)
    case 'right': return localPolygon(item, hw, -hd, hw + depth, hd)
  }
}

/**
 * The floor in front of a piece that must stay free so its drawers, doors or chair can move:
 * the strip beyond its front edge (local +d), turned with the item. `depth` defaults to the
 * kind's access rule (45 cm for a dresser, 65 for a wardrobe, 65 for a desk, …).
 */
export function frontZone(item: Pick<Item, 'x' | 'y' | 'rot' | 'w' | 'd' | 'kind'>, depth = accessRuleFor(item)?.depth ?? 45): Polygon {
  return faceZone(item, 'front', depth)
}

export interface AccessZone {
  face: Face
  poly: Polygon
  /** the polygon's bounding box (the polygon itself when the item stands square) */
  rect: Rect
}

/** Every strip the piece's access rule asks for, with the rule; nothing for kinds that need none. */
export function accessZones(item: Pick<Item, 'x' | 'y' | 'rot' | 'w' | 'd' | 'kind'>): { rule: AccessRule; zones: AccessZone[] } | null {
  const rule = accessRuleFor(item)
  if (!rule) return null
  const faces: Face[] =
    rule.faces === 'front' ? ['front'] : rule.faces === 'all' ? ['front', 'back', 'left', 'right'] : item.d >= item.w ? ['left', 'right'] : ['front', 'back']
  const zones = faces.map((face) => {
    const poly = faceZone(item, face, rule.depth)
    return { face, poly, rect: polygonBounds(poly) }
  })
  return { rule, zones }
}

/** A nightstand, or a small table (≤ 60 cm each way) that belongs at the end of a sofa. */
export function isSideTable(item: Pick<Item, 'kind' | 'w' | 'd'>) {
  return item.kind === 'nightstand' || (item.kind === 'table' && item.w <= 60 && item.d <= 60)
}

/** Beds people climb into (85 cm and wider); anything narrower is a crib or a cot. */
export function isRealBed(item: Pick<Item, 'kind' | 'w' | 'd'>) {
  return item.kind === 'bed' && Math.min(item.w, item.d) >= 85
}

/**
 * Pieces that belong right next to each other, so no walking gap is expected between them:
 * a nightstand and a bed, a chair and its desk or table, a side table and a sofa or armchair,
 * and a rug with anything (it lies underneath).
 */
export function areCompanions(a: Pick<Item, 'kind' | 'w' | 'd'>, b: Pick<Item, 'kind' | 'w' | 'd'>) {
  if (isRugKind(a.kind) || isRugKind(b.kind)) return true
  const pair = (x: Pick<Item, 'kind' | 'w' | 'd'>, y: Pick<Item, 'kind' | 'w' | 'd'>) =>
    (x.kind === 'nightstand' && y.kind === 'bed') ||
    (x.kind === 'chair' && (y.kind === 'desk' || y.kind === 'table')) ||
    (isSideTable(x) && y.kind === 'sofa')
  return pair(a, b) || pair(b, a)
}

/**
 * May `guest` stand in `host`'s access space? A chair at its desk or table, a side table or a
 * low (coffee) table by a sofa, a nightstand by a bed.
 */
export function accessAllows(host: Pick<Item, 'kind' | 'w' | 'd' | 'h'>, guest: Pick<Item, 'kind' | 'w' | 'd' | 'h'>) {
  if (host.kind === 'sofa' && guest.kind === 'table' && guest.h <= 60) return true
  if (guest.kind === 'sofa' && host.kind === 'table' && host.h <= 60) return true
  return areCompanions(host, guest)
}

/** Gap between two rects (0 when they touch or overlap): the straight-line distance between their closest points. */
export function rectDistance(a: Rect, b: Rect) {
  const dx = Math.max(0, Math.max(a.x0, b.x0) - Math.min(a.x1, b.x1))
  const dy = Math.max(0, Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1))
  return Math.hypot(dx, dy)
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const ex = bx - ax, ey = by - ay
  const len2 = ex * ex + ey * ey
  const t = len2 < 1e-9 ? 0 : clamp(((px - ax) * ex + (py - ay) * ey) / len2, 0, 1)
  return Math.hypot(px - (ax + t * ex), py - (ay + t * ey))
}

/** Gap between two convex polygons (0 when they overlap): the shortest corner-to-edge distance. */
export function polygonDistance(a: Polygon, b: Polygon) {
  if (polygonsIntersect(a, b, 0)) return 0
  let best = Infinity
  for (const [p, q] of [[a, b], [b, a]]) {
    for (const [px, py] of p) {
      for (let i = 0; i < q.length; i++) {
        const [ax, ay] = q[i], [bx, by] = q[(i + 1) % q.length]
        const d = pointSegmentDistance(px, py, ax, ay, bx, by)
        if (d < best) best = d
      }
    }
  }
  return best
}

/** Gap between two items' outlines (0 when they touch or overlap); exact for turned pieces. */
export function itemsGap(a: Item, b: Item) {
  if (isAxisAligned(a.rot) && isAxisAligned(b.rot)) return rectDistance(rectOf(a), rectOf(b))
  return polygonDistance(polygonOf(a), polygonOf(b))
}

/** How much of a rect lies inside the room (0..1). */
export function fractionInRoom(room: Pick<Room, 'w' | 'd' | 'outline'>, r: Rect) {
  const area = (r.x1 - r.x0) * (r.y1 - r.y0)
  if (area <= 0) return 1
  if (!room.outline) return overlapArea(r, { x0: 0, y0: 0, x1: room.w, y1: room.d }) / area
  // the floor inside the rect: the outline clipped to it
  return polygonRectOverlap(room.outline, r) / area
}

/** Area of a polygon inside a rect: the polygon clipped to the rect (Sutherland–Hodgman), then its area. */
function polygonRectOverlap(subject: Polygon, r: Rect): number {
  let poly: Polygon = subject
  const clip = (inside: (p: [number, number]) => boolean, cross: (a: [number, number], b: [number, number]) => [number, number]) => {
    const out: Polygon = []
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b = poly[(i + 1) % poly.length]
      if (inside(b)) {
        if (!inside(a)) out.push(cross(a, b))
        out.push(b)
      } else if (inside(a)) out.push(cross(a, b))
    }
    poly = out
  }
  const atX = (x: number) => (a: [number, number], b: [number, number]): [number, number] => [x, a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0])]
  const atY = (y: number) => (a: [number, number], b: [number, number]): [number, number] => [a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]), y]
  clip((p) => p[0] >= r.x0, atX(r.x0))
  clip((p) => p[0] <= r.x1, atX(r.x1))
  clip((p) => p[1] >= r.y0, atY(r.y0))
  clip((p) => p[1] <= r.y1, atY(r.y1))
  let area = 0
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    area += a[0] * b[1] - b[0] * a[1]
  }
  return Math.abs(area) / 2
}
