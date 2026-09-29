import { MAX_WALLS, MIN_WALLS, edgeWall, isSide, isSimplePolygon, polygonArea, roomPolygon, roomWalls, wallFacing, wallFrame, wallPoint, type Polygon } from './geometry'
import type { AnyWall, Room } from './types'

/*
 * Drawn room shapes. A room's outline is a list of corner points; the wall editor describes the
 * same shape as wall lengths and corner angles, the way you measure a room with a tape:
 *
 *   wall i runs from corner i to corner i + 1;
 *   corners[i] is the angle inside the room where wall i meets wall i + 1
 *   (90 for an ordinary corner, 135 for a 45° angled wall, 270 for an inside corner).
 *
 * Going round clockwise on the plan, the heading turns by 180 − angle at every corner. One wall is
 * left to close the shape: its length and the angles at both of its ends are worked out.
 */

export interface WallSpec {
  /** wall lengths in cm, wall i from corner i to corner i + 1 */
  lengths: number[]
  /** angle inside the room at the end of wall i, in degrees */
  angles: number[]
  /** direction of each wall on the plan, degrees clockwise from "to the right"; only the one after the closing wall is used, to keep the room from turning */
  headings: number[]
}

const rad = (deg: number) => (deg * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI
const norm360 = (a: number) => ((a % 360) + 360) % 360

/** Lengths, corner angles and the first wall's heading of an outline. */
export function wallsFromOutline(pts: Polygon): WallSpec {
  const n = pts.length
  const dirs = pts.map((a, i) => {
    const b = pts[(i + 1) % n]
    return Math.atan2(b[1] - a[1], b[0] - a[0])
  })
  const lengths = pts.map((a, i) => {
    const b = pts[(i + 1) % n]
    return Math.hypot(b[0] - a[0], b[1] - a[1])
  })
  const angles = dirs.map((d, i) => {
    const turn = norm360(deg(dirs[(i + 1) % n] - d) + 180) - 180 // (-180, 180], clockwise positive
    return 180 - turn
  })
  return { lengths, angles, headings: dirs.map((d) => norm360(deg(d))) }
}

export interface Closed {
  /** the corners on the plan, one per wall, before any tidying (see normalizeOutline) */
  points: Polygon
  /** the closing wall's length and the two angles worked out for it */
  closing: { wall: number; length: number; angleBefore: number; angleAfter: number }
}

/**
 * The outline from wall lengths and corner angles, with wall `close` worked out: every other wall
 * keeps its length, every corner not touching the closing wall keeps its angle, and the wall after
 * the closing one keeps its heading (so the room does not spin while you type).
 */
export function outlineFromWalls(spec: WallSpec, close: number): Closed | { error: string } {
  const n = spec.lengths.length
  if (n < MIN_WALLS || n > MAX_WALLS) return { error: `A room needs ${MIN_WALLS} to ${MAX_WALLS} walls.` }
  if (spec.lengths.some((l, i) => i !== close && !(l > 0))) return { error: 'Every wall needs a length.' }
  // walk from the start of the wall after the closing one, all the way round to the closing wall;
  // the angles at both ends of the closing wall are never used
  const first = (close + 1) % n
  const pts: [number, number][] = new Array(n)
  let p: [number, number] = [0, 0]
  pts[first] = p
  let h = spec.headings[first] ?? 0
  for (let k = 0; k < n - 1; k++) {
    const i = (first + k) % n
    if (k > 0) h += 180 - spec.angles[(i + n - 1) % n]
    p = [p[0] + spec.lengths[i] * Math.cos(rad(h)), p[1] + spec.lengths[i] * Math.sin(rad(h))]
    pts[(i + 1) % n] = p
  }
  const a = pts[close], b = pts[first]
  const length = Math.hypot(b[0] - a[0], b[1] - a[1])
  const back = wallsFromOutline(pts)
  const closing = { wall: close, length, angleBefore: back.angles[(close + n - 1) % n], angleAfter: back.angles[close] }
  if (length < 5) return { error: `The walls meet before wall ${close + 1}: make a wall shorter or change an angle.` }
  if (!isSimplePolygon(pts)) return { error: 'Two walls cross each other: check the lengths and angles.' }
  if (polygonArea(pts) <= 0) return { error: 'The walls go round the wrong way: an inside corner (270°) is probably set where an ordinary one (90°) should be.' }
  return { points: pts, closing }
}

/**
 * Tidy a drawn outline: clockwise, no repeated points, no straight-through corners, moved so the
 * box around it starts at (0, 0), in whole centimetres. Refuses walls that cross.
 */
export function normalizeOutline(raw: Polygon): { points: Polygon } | { error: string } {
  let pts = raw.map(([x, y]): [number, number] => [x, y])
  // drop repeated points and corners where the wall runs straight on
  for (let changed = true; changed && pts.length > 2; ) {
    changed = false
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i], c = pts[(i + 1) % pts.length]
      const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
      const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) < 1 || (Math.abs(cross) < 1e-6 * Math.max(1, Math.hypot(b[0] - a[0], b[1] - a[1]) * Math.hypot(c[0] - b[0], c[1] - b[1])) && dot > 0)) {
        pts.splice(i, 1)
        changed = true
        break
      }
    }
  }
  if (pts.length < MIN_WALLS) return { error: 'A room needs at least three walls.' }
  if (pts.length > MAX_WALLS) return { error: `A room can have at most ${MAX_WALLS} walls.` }
  if (!isSimplePolygon(pts)) return { error: 'Two walls cross each other.' }
  if (polygonArea(pts) < 0) pts = [pts[0], ...pts.slice(1).reverse()]
  const minX = Math.min(...pts.map((p) => p[0])), minY = Math.min(...pts.map((p) => p[1]))
  return { points: pts.map(([x, y]) => [Math.round((x - minX) * 10) / 10, Math.round((y - minY) * 10) / 10]) }
}

/** The room's outline, whether it was drawn or is a plain rectangle (back wall first). */
export function outlineOf(room: Room): Polygon {
  return roomPolygon(room)
}

type Placed = { wall: AnyWall; offset: number; width: number }

/**
 * Where an opening lands on a new outline: its two ends are found on the plan and matched to the
 * new wall they lie on. The offset comes from the end nearer the new wall's start; `flipped` says
 * the wall now runs the other way (a door's hinge side swaps). Null when no wall holds it any more.
 */
export function remapOnto<T extends Placed>(from: Room, to: Room, o: T): { wall: AnyWall; offset: number; flipped: boolean } | null {
  return placeByPoints(to, wallPoint(from, o.wall, o.offset), wallPoint(from, o.wall, o.offset + o.width))
}

/** The wall of `to` that runs through both points, the offset of the nearer one along it, and whether they come in reverse order. */
export function placeByPoints(to: Pick<Room, 'w' | 'd' | 'outline'>, p0: [number, number], p1: [number, number]): { wall: AnyWall; offset: number; flipped: boolean } | null {
  for (const w of roomWalls(to)) {
    const f = wallFrame(to, w)
    const off = (p: [number, number]) => {
      const dx = p[0] - f.start[0], dy = p[1] - f.start[1]
      return { t: dx * f.along[0] + dy * f.along[1], n: dx * f.normal[0] + dy * f.normal[1] }
    }
    const a = off(p0), b = off(p1)
    if (Math.abs(a.n) > 1 || Math.abs(b.n) > 1) continue
    if (Math.min(a.t, b.t) < -1 || Math.max(a.t, b.t) > f.length + 1) continue
    return { wall: w, offset: Math.max(0, Math.min(a.t, b.t)), flipped: a.t > b.t }
  }
  return null
}

/**
 * The room with a new outline. Turning a plain room into a drawn one, every opening keeps its place
 * on the plan (the back wall becomes the drawn wall along it). Editing a drawn room, openings keep
 * their wall number and offset, and sanitizeRoom pulls them back onto the wall if it got shorter.
 */
export function withOutline(room: Room, points: Polygon): Room {
  const w = Math.max(...points.map((p) => p[0])), d = Math.max(...points.map((p) => p[1]))
  const next: Room = { ...room, w, d, outline: points.map(([x, y]): [number, number] => [x, y]) }
  const n = points.length
  const move = <T extends Placed>(o: T, flip: (o: T) => T = (x) => x): T => {
    if (!isSide(o.wall)) return { ...o, wall: edgeWall(Math.min(Number(o.wall.slice(1)), n - 1)) }
    const m = remapOnto(room, next, o)
    if (m) return m.flipped ? flip({ ...o, wall: m.wall, offset: m.offset }) : { ...o, wall: m.wall, offset: m.offset }
    // no drawn wall runs where it was: the wall facing the same way, else the first
    const facing = roomWalls(next).find((x) => wallFacing(next, x) === o.wall)
    return { ...o, wall: facing ?? edgeWall(0) }
  }
  return {
    ...next,
    windows: room.windows.map((o) => move(o)),
    doors: room.doors.map((o) => move(o, (x) => ({ ...x, hinge: x.hinge === 'left' ? 'right' : 'left' }))),
    radiators: room.radiators.map((o) => move(o)),
    closets: (room.closets ?? []).map((o) => move(o)),
  }
}
