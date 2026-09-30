import { polygonBounds, polygonOf, pointInOutline, roomPolygon, segmentsCross, type Polygon } from './geometry'
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
    rooms.push({ roomId: o.roomId, x: o.x, y: o.y, rot })
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

/** The box around every placed room (rooms whose file is missing are skipped); null for an empty house. */
export function houseBounds(house: HouseDoc, rooms: Map<string, Room>): Rect | null {
  let b: Rect | null = null
  for (const p of house.rooms) {
    const room = rooms.get(p.roomId)
    if (!room) continue
    const r = polygonBounds(roomOnPlan(room, p))
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
  const others = house.rooms.filter((r) => r.roomId !== moving.roomId && rooms.has(r.roomId)).flatMap((r) => edgesOnPlan(rooms.get(r.roomId)!, r))
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
  return {
    place: { ...moving, x: moving.x + (dx ?? 0), y: moving.y + (dy ?? 0) },
    snapped: { x: dx !== null, y: dy !== null },
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
