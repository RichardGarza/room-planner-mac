import { polygonBounds, polygonOf, pointInOutline, roomPolygon, type Polygon } from './geometry'
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
