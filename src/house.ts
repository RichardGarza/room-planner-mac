import { floorBounds, polygonBounds, polygonOf, pointInOutline, roomPolygon, segmentsCross, wallFrame, wallPoint, type Polygon } from './geometry'
import type { Item, Rect, Room, Rot } from './types'

/*
 * A house: where each room sits in one home. Rooms stay in their own files (their furniture and
 * layouts included); a house only places them. See docs/HOUSE_ROADMAP.md.
 *
 * House coordinates are centimetres on one big plan, x to the right and y down like a room's. A room
 * sits with its own (0, 0) corner at (x, y), turned `rot` degrees clockwise about that corner.
 */

export type QuarterTurn = 0 | 90 | 180 | 270

export interface HouseRoom {
  roomId: string
  x: number
  y: number
  rot: QuarterTurn
  /** which floor: 0 the ground floor (the default), 1 the first floor up, -1 a basement */
  level?: number
}

export interface HouseDoc {
  id: string
  name: string
  createdAt: string
  updatedAt: string
  version: number
  rooms: HouseRoom[]
}

export const HOUSE_VERSION = 1
/** How far apart two rooms that share a wall stand: the wall's thickness (the 3D view draws 12 cm walls). */
export const WALL_GAP = 12

const TURNS: QuarterTurn[] = [0, 90, 180, 270]
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** A house from a saved file, or null when it is not one. Rooms listed twice keep their first place. */
export function migrateHouse(raw: unknown): HouseDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (typeof d.id !== 'string' || !d.id.trim() || !Array.isArray(d.rooms)) return null
  const ts = new Date().toISOString()
  const seen = new Set<string>()
  const rooms: HouseRoom[] = []
  for (const r of d.rooms) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    if (typeof o.roomId !== 'string' || !o.roomId || seen.has(o.roomId) || !finite(o.x) || !finite(o.y)) continue
    seen.add(o.roomId)
    const rot = TURNS.includes(o.rot as QuarterTurn) ? (o.rot as QuarterTurn) : 0
    const level = finite(o.level) ? Math.max(-3, Math.min(10, Math.round(o.level))) : 0
    rooms.push(level ? { roomId: o.roomId, x: o.x, y: o.y, rot, level } : { roomId: o.roomId, x: o.x, y: o.y, rot })
  }
  return {
    id: d.id,
    name: typeof d.name === 'string' && d.name.trim() ? d.name : 'House',
    createdAt: typeof d.createdAt === 'string' ? d.createdAt : ts,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : ts,
    version: HOUSE_VERSION,
    rooms,
  }
}

/* ---------- floors ---------- */

export const levelOf = (p: Pick<HouseRoom, 'level'>) => p.level ?? 0

/** The floors the house has rooms on, lowest first (the ground floor when it has none). */
export function levels(house: HouseDoc): number[] {
  const set = new Set(house.rooms.map(levelOf))
  return set.size ? [...set].sort((a, b) => a - b) : [0]
}

/** The house with only the rooms of one floor: what the map shows, snaps and connects. */
export function onLevel(house: HouseDoc, level: number): HouseDoc {
  return { ...house, rooms: house.rooms.filter((p) => levelOf(p) === level) }
}

/** "Ground floor", "First floor", "Basement", … */
export function levelName(level: number): string {
  if (level === 0) return 'Ground floor'
  if (level < 0) return level === -1 ? 'Basement' : `Basement ${-level}`
  const names = ['First', 'Second', 'Third', 'Fourth', 'Fifth', 'Sixth', 'Seventh', 'Eighth', 'Ninth', 'Tenth']
  return `${names[level - 1] ?? `Floor ${level}`} floor`
}

/** -0 becomes 0 (turning a point can make one), so points compare equal. */
const z = (v: number) => v + 0

/** A point of the room, on the house plan. */
export function toHouse(p: Pick<HouseRoom, 'x' | 'y' | 'rot'>, [x, y]: [number, number]): [number, number] {
  switch (p.rot) {
    case 90: return [z(p.x - y), z(p.y + x)]
    case 180: return [z(p.x - x), z(p.y - y)]
    case 270: return [z(p.x + y), z(p.y - x)]
    default: return [z(p.x + x), z(p.y + y)]
  }
}

/** A point of the house plan, in the room's own coordinates. */
export function toRoom(p: Pick<HouseRoom, 'x' | 'y' | 'rot'>, [X, Y]: [number, number]): [number, number] {
  const dx = X - p.x, dy = Y - p.y
  switch (p.rot) {
    case 90: return [z(dy), z(-dx)]
    case 180: return [z(-dx), z(-dy)]
    case 270: return [z(-dy), z(dx)]
    default: return [z(dx), z(dy)]
  }
}

/** A piece's angle on the house plan. */
export const houseRot = (p: Pick<HouseRoom, 'rot'>, rot: Rot): Rot => (((rot + p.rot) % 360) + 360) % 360

/** The room's floor outline on the house plan. */
export function roomOnPlan(room: Room, p: HouseRoom): Polygon {
  return roomPolygon(room).map((pt) => toHouse(p, pt))
}

/** A piece of furniture's outline on the house plan. */
export function itemOnPlan(item: Item, p: HouseRoom): Polygon {
  return polygonOf(item).map((pt) => toHouse(p, pt))
}

/** The box around a placed room's floor, closets included, on the house plan. */
export function floorOnPlan(room: Room, p: HouseRoom): Rect {
  const f = floorBounds(room)
  return polygonBounds(([[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]] as [number, number][]).map((pt) => toHouse(p, pt)))
}

/** The box around every placed room, closets included (rooms whose file is missing are skipped); null for an empty house. */
export function houseBounds(house: HouseDoc, rooms: Map<string, Room>): Rect | null {
  let b: Rect | null = null
  for (const p of house.rooms) {
    const room = rooms.get(p.roomId)
    if (!room) continue
    const r = floorOnPlan(room, p)
    b = b ? { x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) } : r
  }
  return b
}

/** Which placed room's floor a house point is on, or null. */
export function roomAt(house: HouseDoc, rooms: Map<string, Room>, pt: [number, number]): HouseRoom | null {
  for (const p of house.rooms) {
    const room = rooms.get(p.roomId)
    if (room && pointInOutline(pt[0], pt[1], roomOnPlan(room, p))) return p
  }
  return null
}

/* ---------- arranging: snapping walls together ---------- */

/** How close (cm) a wall has to come to another room's wall before it snaps to it. */
export const SNAP = 30

interface PlanEdge { a: [number, number]; b: [number, number]; out: [number, number] }

/** A placed room's walls on the house plan, each with its outward normal. */
function edgesOnPlan(room: Room, p: HouseRoom): PlanEdge[] {
  const pts = roomOnPlan(room, p)
  return pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    // clockwise on the plan (a turn keeps it clockwise): the room is on the right, outside on the left
    return { a, b, out: [(b[1] - a[1]) / len, -(b[0] - a[0]) / len] as [number, number] }
  })
}

const across = (e: PlanEdge) => Math.abs(e.b[1] - e.a[1]) < 0.01 // runs along x
const down = (e: PlanEdge) => Math.abs(e.b[0] - e.a[0]) < 0.01 // runs along y
const span = (e: PlanEdge, k: 0 | 1): [number, number] => [Math.min(e.a[k], e.b[k]), Math.max(e.a[k], e.b[k])]
const overlap = ([a0, a1]: [number, number], [b0, b1]: [number, number]) => Math.min(a1, b1) - Math.max(a0, b0)

/**
 * Where a room being moved should land: each of its straight walls that comes within `snap` of
 * another room's wall facing it snaps a wall's thickness (WALL_GAP) away from it; a wall running the
 * same way as another's (two outside walls in line) lines up with it. Across and down the plan are
 * snapped on their own, each to the nearest candidate. Returns the placement and what it snapped to.
 */
export function snapPlacement(house: HouseDoc, rooms: Map<string, Room>, moving: HouseRoom, snap = SNAP): { place: HouseRoom; snapped: { x: boolean; y: boolean } } {
  const room = rooms.get(moving.roomId)
  if (!room) return { place: moving, snapped: { x: false, y: false } }
  const mine = edgesOnPlan(room, moving)
  // only rooms on the same floor
  const others = house.rooms.filter((r) => r.roomId !== moving.roomId && rooms.has(r.roomId) && levelOf(r) === levelOf(moving)).flatMap((r) => edgesOnPlan(rooms.get(r.roomId)!, r))
  let dx: number | null = null, dy: number | null = null
  const consider = (axis: 'x' | 'y', shift: number) => {
    if (Math.abs(shift) > snap) return
    if (axis === 'x' && (dx === null || Math.abs(shift) < Math.abs(dx))) dx = shift
    if (axis === 'y' && (dy === null || Math.abs(shift) < Math.abs(dy))) dy = shift
  }
  for (const e of mine) {
    for (const f of others) {
      if (down(e) && down(f)) {
        const ex = e.a[0], fx = f.a[0]
        if (e.out[0] * f.out[0] < 0) {
          // facing each other: only where they actually run alongside
          if (overlap(span(e, 1), span(f, 1)) > 0) consider('x', fx - Math.sign(e.out[0]) * WALL_GAP - ex)
        } else consider('x', fx - ex)
      } else if (across(e) && across(f)) {
        const ey = e.a[1], fy = f.a[1]
        if (e.out[1] * f.out[1] < 0) {
          if (overlap(span(e, 0), span(f, 0)) > 0) consider('y', fy - Math.sign(e.out[1]) * WALL_GAP - ey)
        } else consider('y', fy - ey)
      }
    }
  }
  // Doors: a door facing another room's door across the walls lines up with it along the wall; that
  // wins over lining up the walls' ends on the same axis (it is what you are after).
  let doorX: number | null = null, doorY: number | null = null
  const others2 = house.rooms.filter((r) => r.roomId !== moving.roomId && rooms.has(r.roomId) && levelOf(r) === levelOf(moving))
  for (const dm of doorsOnPlan(room, moving)) {
    for (const r of others2) {
      for (const dn of doorsOnPlan(rooms.get(r.roomId)!, r)) {
        if (dm.inward[0] * dn.inward[0] + dm.inward[1] * dn.inward[1] > -0.98) continue
        const mid = (d: { a: [number, number]; b: [number, number] }): [number, number] => [(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2]
        const [mx, my] = mid(dm), [nx, ny] = mid(dn)
        if (Math.abs(dm.inward[0]) > 0.99) {
          // doors in walls running down the plan: close across (x), lined up along (y)
          const across = Math.abs(nx - mx)
          if (across > DOOR_REACH + snap) continue
          const shift = ny - my
          if (Math.abs(shift) <= snap && (doorY === null || Math.abs(shift) < Math.abs(doorY))) doorY = shift
        } else if (Math.abs(dm.inward[1]) > 0.99) {
          const across = Math.abs(ny - my)
          if (across > DOOR_REACH + snap) continue
          const shift = nx - mx
          if (Math.abs(shift) <= snap && (doorX === null || Math.abs(shift) < Math.abs(doorX))) doorX = shift
        }
      }
    }
  }
  // a door lined up along a wall running down the plan moves the room along y; one across, along x
  const fx = doorX ?? dx, fy = doorY ?? dy
  return {
    place: { ...moving, x: moving.x + (fx ?? 0), y: moving.y + (fy ?? 0) },
    snapped: { x: fx !== null, y: fy !== null },
  }
}

/** True when two room floors overlap (touching or a wall's thickness apart does not count). */
export function floorsOverlap(a: Polygon, b: Polygon): boolean {
  const inside = (pts: Polygon, poly: Polygon) => pts.some(([x, y]) => pointInOutline(x, y, poly) && edgeDistance(poly, x, y) > 1)
  if (inside(a, b) || inside(b, a)) return true
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      if (segmentsCross(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length])) return true
    }
  }
  return false
}

function edgeDistance(poly: Polygon, px: number, py: number): number {
  let best = Infinity
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length]
    const dx = b[0] - a[0], dy = b[1] - a[1]
    const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (py - a[1]) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t))
  }
  return best
}

/* ---------- furniture on the house plan ---------- */

/**
 * The piece of furniture under a house point: solid pieces before rugs, the last drawn first (the
 * one on top). Only pieces that are in their room count.
 */
export function itemAt(house: HouseDoc, docs: Record<string, { items: Item[] }>, pt: [number, number]): { roomId: string; item: Item } | null {
  for (const rugs of [false, true]) {
    for (const p of [...house.rooms].reverse()) {
      const doc = docs[p.roomId]
      if (!doc) continue
      for (const item of [...doc.items].reverse()) {
        if (!item.inRoom || (item.kind === 'rug' || item.kind === 'rugRect') !== rugs) continue
        if (pointInOutline(pt[0], pt[1], itemOnPlan(item, p))) return { roomId: p.roomId, item }
      }
    }
  }
  return null
}

/* ---------- connections: doors that meet across a shared wall ---------- */

/** How far apart (cm) two door openings may be across a wall and still meet: a wall's thickness and a bit. */
export const DOOR_REACH = WALL_GAP + 15

export interface DoorEnd { roomId: string; doorId: string }

export interface Connection {
  a: DoorEnd
  b: DoorEnd
  /** the passage between the two openings on the house plan: where they overlap, across the wall */
  passage: Polygon
}

/** A placed room's doors on the house plan: each door's opening as a segment, and the way into its room. */
function doorsOnPlan(room: Room, p: HouseRoom) {
  return room.doors.map((d) => {
    const a = toHouse(p, wallPoint(room, d.wall, d.offset))
    const b = toHouse(p, wallPoint(room, d.wall, d.offset + d.width))
    const f = wallFrame(room, d.wall)
    // the room's inward normal, turned with the room
    const n = toHouse({ x: 0, y: 0, rot: p.rot }, f.normal)
    return { door: d, a, b, inward: n }
  })
}

/**
 * The doors of different rooms that meet: on parallel walls facing each other, no more than
 * DOOR_REACH apart, their openings overlapping by at least half the narrower one.
 */
export function connections(house: HouseDoc, docs: Record<string, { room: Room }>): Connection[] {
  const placed = house.rooms.filter((p) => docs[p.roomId])
  const out: Connection[] = []
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length; j++) {
      const A = placed[i], B = placed[j]
      if (levelOf(A) !== levelOf(B)) continue
      for (const da of doorsOnPlan(docs[A.roomId].room, A)) {
        for (const db of doorsOnPlan(docs[B.roomId].room, B)) {
          // facing each other across the wall
          if (da.inward[0] * db.inward[0] + da.inward[1] * db.inward[1] > -0.98) continue
          const len = Math.hypot(da.b[0] - da.a[0], da.b[1] - da.a[1]) || 1
          const u: [number, number] = [(da.b[0] - da.a[0]) / len, (da.b[1] - da.a[1]) / len]
          // how far B's opening is behind A's (along A's outward normal) and where it runs along A's
          const dist = (q: [number, number]) => -((q[0] - da.a[0]) * da.inward[0] + (q[1] - da.a[1]) * da.inward[1])
          const along = (q: [number, number]) => (q[0] - da.a[0]) * u[0] + (q[1] - da.a[1]) * u[1]
          const gap = (dist(db.a) + dist(db.b)) / 2
          if (gap < -1 || gap > DOOR_REACH || Math.abs(dist(db.a) - dist(db.b)) > 2) continue
          const t0 = Math.max(0, Math.min(along(db.a), along(db.b))), t1 = Math.min(len, Math.max(along(db.a), along(db.b)))
          if (t1 - t0 < 0.5 * Math.min(len, Math.hypot(db.b[0] - db.a[0], db.b[1] - db.a[1]))) continue
          const at = (t: number, back: number): [number, number] => [da.a[0] + u[0] * t - da.inward[0] * back, da.a[1] + u[1] * t - da.inward[1] * back]
          out.push({
            a: { roomId: A.roomId, doorId: da.door.id },
            b: { roomId: B.roomId, doorId: db.door.id },
            passage: [at(t0, 0), at(t1, 0), at(t1, gap), at(t0, gap)],
          })
        }
      }
    }
  }
  return out
}
