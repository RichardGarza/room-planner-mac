import { isAccessCheck, runChecks } from './checks'
import { accessAllows, accessRuleFor, accessZones, areCompanions, closetClearance, doorSwing, isSide, rectInRoom, sideOf, wallFacing, wallStripPolygon, footprint, fractionInRoom, frontZone, intersects, isAxisAligned, isRealBed, isRugKind, isSideTable, itemsGap, localToRoom, overlapArea, polygonBounds, polygonDistance, polygonIntersectsRect, polygonOf, rectDistance, rectOf, rectToPolygon, snap90, type AccessRule, type Polygon, wallLength, wallStripRect } from './geometry'
import type { Check, Item, ItemKind, ItemPlacement, Layout, Rect, Room, Rot, Wall } from './types'

/**
 * Layout suggestions: a few good "try this" arrangements for any room.
 *
 * The anchor (the biggest bed, else the biggest solid piece) is tried with its back against
 * every wall, sliding along it in 10 cm steps. For each anchor spot the other pieces are placed
 * greedily by priority — wardrobes, dressers, the desk with its chair, bookcases, nightstands by
 * the bed head, seating with its side tables and the rest, rugs last — each on the best-scoring
 * free spot, walls first. A spot is only allowed when the piece's own access space (the floor its
 * drawers, doors or chair need, see accessRules in geometry.ts) faces open floor, and when it does
 * not stand in the access space of anything already placed. Nothing stands within 10 cm of what
 * the door leaf sweeps (the quarter disc and the line the fully open leaf reaches; 20 cm is
 * preferred), nor within 5 cm of the closet doors' clearance or a doorway strip (15 preferred).
 * Pieces that do not belong together (companions: nightstand and bed, chair and desk, side table
 * and sofa) are kept 45 cm apart when the room allows it; when something has to give, it is not
 * the bed (a bed with a single open side, a crib against the wall, keeps the full gap all round)
 * and a bed never stands beside the door leaf's sweep. Every complete arrangement is scored with
 * the layout checks plus a few room-sense heuristics — crowding weighs heavily, so the most open
 * of the layouts that pass everything else is the one recommended, and a headboard on the door
 * wall right by the door only wins when no other wall works — and the best few that differ in
 * where the anchor went are returned.
 *
 * Greedy filling is short-sighted in a tight room, so the anchor spots where it left a piece out
 * or blocked the way from the door get a second, slower pass: once more with the biggest piece
 * first, a wall piece that finds no spot may trade places with one already standing, and finally
 * a bounded search over the tight fits (every piece against something, with backtracking).
 * Layouts with nothing to apologise for come first; up to two more that pass every hard rule (no
 * red check, every drawer and door can open, every piece in, a way from the door to the bed) but
 * put the anchor on another wall may join them as trade-offs, and the description says what the
 * trade-off is. Layouts that break a hard rule are only offered when nothing passes them.
 *
 * Locked pieces stay exactly where they are in every layout and everything else is arranged
 * around them. Furniture the user has taken out of the room takes no part and stays out.
 *
 * Pure and deterministic: the same room and furniture always give the same layouts.
 */

export interface SuggestOptions {
  /** how many layouts to return (default 3) */
  max?: number
  /** keep locked pieces where they are and arrange the rest around them (default true) */
  respectLocks?: boolean
}

const GRID = 10
/** width a person needs to walk past something, and the strip needed beside a bed */
const PATH = 60
/** walking gap kept between solid pieces that do not belong together */
export const MIN_GAP = 45
const WINDOW_DEPTH = 12
const RADIATOR_CLEAR = 15
const DOORWAY_DEPTH = 40
/** how many candidate spots one call may look at before it stops trying more anchor positions */
const BUDGET = 800_000
/** how far a headboard is pulled off a window wall so it does not count as standing under the window */
const HEAD_INSET = 15
/** most anchor positions tried per wall (the sweep gets coarser on long walls) */
const ANCHOR_STEPS = 14
/** a bed side counts as usable while this much of its strip is inside the room and free */
const SIDE_FREE = 0.6
const LETTERS = 'ABCDEFGH'

const WALLS: Wall[] = ['top', 'left', 'right', 'bottom']
/** Rotation that turns an item's back (its −d side, the headboard of a bed) to a wall. */
const BACK_TO_WALL: Record<Wall, Rot> = { top: 0, right: 90, bottom: 180, left: 270 }
/**
 * Nothing stands closer than this to the door leaf's sweep (the quarter disc and the line the
 * fully open leaf reaches): the leaf would bang into it. A bed keeps a whole walking gap.
 */
export const DOOR_MARGIN = 10
/** and it is better still to leave this much */
export const DOOR_PREFER = 20
/** nothing stands closer than this to the closet doors' clearance or to a doorway strip */
export const CLOSET_MARGIN = 5
/** and it is better to leave this much */
export const CLOSET_PREFER = 15
/** a headboard on the door wall with the bed (or its nightstands) this close to the doorway: you walk in and meet the bed */
export const HEAD_DOOR_REACH = 100
/**
 * How much a walking gap under MIN_GAP counts, by the kinds of the pair: squeezing up to a bed is
 * worst (that is where people climb in and lean over), seating next, storage least.
 */
function gapWeight(a: Pick<Item, 'kind'>, b: Pick<Item, 'kind'>) {
  const w = (k: ItemKind) => (k === 'bed' ? 2 : k === 'sofa' || k === 'chair' ? 1.5 : 1)
  return Math.max(w(a.kind), w(b.kind))
}
/** Suggestions only turn things by quarter turns; an item saved at any other angle counts as the nearest one. */
const HEAD_WALL: Record<0 | 90 | 180 | 270, Wall> = { 0: 'top', 90: 'right', 180: 'bottom', 270: 'left' }
/** Unit vector an item's front faces at each rotation. */
const FRONT: Record<0 | 90 | 180 | 270, [number, number]> = { 0: [0, 1], 90: [-1, 0], 180: [0, -1], 270: [1, 0] }
const WALL_NAME: Record<Wall, string> = { top: 'back wall', bottom: 'front wall', left: 'left wall', right: 'right wall' }
const KIND_LABEL: Record<ItemKind, string> = {
  bed: 'bed', chair: 'chair', desk: 'desk', shelf: 'shelf', dresser: 'dresser', wardrobe: 'wardrobe', bookcase: 'bookcase',
  rug: 'rug', rugRect: 'rug', nightstand: 'nightstand', sofa: 'sofa', table: 'table', plant: 'plant', box: 'piece',
}
/** Placement priority of everything but the anchor (lower first). Chairs follow their desk, side tables their sofa. */
const PRIORITY: Record<ItemKind, number> = {
  wardrobe: 0, dresser: 1, sofa: 1, desk: 2, bookcase: 3, shelf: 3, nightstand: 4, table: 5, box: 6, bed: 6, chair: 7, plant: 8, rug: 9, rugRect: 9,
}
/** Kinds that belong against a wall: one of them left standing in the open costs a layout dearly. */
const WALL_KINDS = new Set<ItemKind>(['wardrobe', 'dresser', 'sofa', 'desk', 'bookcase', 'shelf', 'bed'])

interface Spot { x: number; y: number; rot: Rot }
/** A solid piece already standing in the arrangement; `poly` only when it is turned off the axes (a locked piece). */
interface Solid { item: Item; rect: Rect; poly?: Polygon }
/**
 * Floor that a candidate should (or must) keep off. Access space of a placed piece carries its
 * `host` (companions may stand in it); the soft zones around a bed list the kinds they allow.
 */
interface Zone {
  rect: Rect
  poly?: Polygon
  penalty: number
  hard: boolean
  host?: Item
  allow?: ItemKind[]
  /** a bed's side strip: the penalty scales with how much of the strip the candidate covers (its area, cm²) */
  area?: number
}
/** A pair of solid pieces that do not belong together and stand closer than MIN_GAP. */
interface TightPair { a: Item; b: Item; gap: number }
interface WindowInfo { rect: Rect; sill: number; height: number; wall: Wall; offset: number; width: number }

interface Ctx {
  room: Room
  windows: WindowInfo[]
  radiators: Rect[]
  /** strips 1 m deep in front of each door: keep them fairly clear */
  approaches: Rect[]
  /** the floor closet doors need to open: nothing may stand there */
  closets: Rect[]
  doorWalls: Set<Wall>
  /** pieces that stay exactly where they are (obstacles in every arrangement) */
  locked: Item[]
  /** a side table is waiting to go at the end of a sofa, so a sofa spot should leave room for one */
  wantsSideTables: boolean
  budget: number
}

interface Arrangement {
  placed: Map<string, Item>
  solids: Solid[]
  zones: Zone[]
}

interface Scored {
  items: Item[]
  score: number
  checks: Check[]
  /** which wall the anchor's back is on, and where along it (a window it spans, a corner, or the middle) */
  head: { wall: Wall; side: 'left' | 'right' | 'top' | 'bottom' | 'window' | 'middle'; corner?: Wall }
  deskByWindow: boolean
  pathsOk: boolean
  leftOut: Item[]
  /** some pair stands closer than MIN_GAP, or a nightstand or side table is away from its bed or sofa */
  crowded: boolean
  /** the pairs that stand closer than MIN_GAP, closest first */
  tight: TightPair[]
  /** a nightstand or side table away from its bed or sofa, or a hamper, plant or box left in the open */
  stranded: boolean
  order: number
}

/* ---------- small geometry helpers ---------- */

const round = (v: number) => Math.round(v)
const rectAt = (x: number, y: number, fw: number, fd: number): Rect => ({ x0: x - fw / 2, y0: y - fd / 2, x1: x + fw / 2, y1: y + fd / 2 })

function spotRect(item: Pick<Item, 'w' | 'd'>, spot: Spot): Rect {
  const { fw, fd } = footprint({ w: item.w, d: item.d, rot: spot.rot })
  return rectAt(spot.x, spot.y, fw, fd)
}

function insideRoom(room: Room, r: Rect) {
  return rectInRoom(room, r)
}

function touchesWall(room: Room, r: Rect, wall: Wall, reach = 5) {
  switch (wall) {
    case 'top': return r.y0 <= reach
    case 'bottom': return r.y1 >= room.d - reach
    case 'left': return r.x0 <= reach
    case 'right': return r.x1 >= room.w - reach
  }
}

function wallsTouched(room: Room, r: Rect, reach = 5): Wall[] {
  return WALLS.filter((w) => touchesWall(room, r, w, reach))
}

/** Pieces with a front (drawers, doors, a headboard) only count as "on a wall" when their back is against one. */
function hasBack(item: Pick<Item, 'kind' | 'w' | 'd'>) {
  return item.kind === 'bed' || accessRuleFor(item)?.mode === 'all'
}

/** Is the wall behind the piece's back (its −d side) a room wall? Anything without a front just needs to touch one. */
function onWall(room: Room, item: Pick<Item, 'kind' | 'w' | 'd' | 'rot'>, r: Rect) {
  if (!hasBack(item)) return wallsTouched(room, r).length > 0
  return touchesWall(room, r, HEAD_WALL[snap90(item.rot)])
}

function spanOf(r: Rect, wall: Wall) {
  return wall === 'top' || wall === 'bottom' ? { offset: r.x0, width: r.x1 - r.x0 } : { offset: r.y0, width: r.y1 - r.y0 }
}

function spanOverlap(a: { offset: number; width: number }, b: { offset: number; width: number }) {
  return Math.min(a.offset + a.width, b.offset + b.width) - Math.max(a.offset, b.offset)
}

/** Does an axis-aligned rect reach into a solid or zone (its turned outline when it has one)? */
function hits(rect: Rect, target: { rect: Rect; poly?: Polygon }) {
  if (!intersects(rect, target.rect)) return false
  return !target.poly || polygonIntersectsRect(target.poly, rect)
}

/** Gap between an axis-aligned rect and a solid (0 when they touch). */
function gapTo(rect: Rect, s: Solid) {
  return s.poly ? polygonDistance(rectToPolygon(rect), s.poly) : rectDistance(rect, s.rect)
}

/** The item as it would stand at a spot. */
function at(item: Item, spot: Spot): Item {
  return { ...item, x: spot.x, y: spot.y, rot: spot.rot, inRoom: true }
}

/** Does an item under a window stand under it in the sense the checks use? */
function underWindow(ctx: Ctx, r: Rect) {
  return ctx.windows.some((w) => touchesWall(ctx.room, r, w.wall, WINDOW_DEPTH) && spanOverlap(spanOf(r, w.wall), w) >= 20)
}

/** True when the rect reaches into the doorway or the quarter circle an inward door leaf sweeps. */
function doorBlocks(room: Room, rect: Rect): boolean {
  for (const door of room.doors) {
    const depth = door.swing === 'out' ? Math.min(60, door.width) : DOORWAY_DEPTH
    if (!isSide(door.wall) ? polygonIntersectsRect(wallStripPolygon(room, door.wall, door.offset, door.width, depth), rect) : intersects(rect, wallStripRect(room, door.wall, door.offset, door.width, depth))) return true
    if (door.swing === 'out') continue
    const { hx, hy, r, leafDir } = doorSwing(room, door)
    if (rect.x1 <= hx - r || rect.x0 >= hx + r || rect.y1 <= hy - r || rect.y0 >= hy + r) continue
    const inside = (px: number, py: number) => px > rect.x0 + 0.5 && px < rect.x1 - 0.5 && py > rect.y0 + 0.5 && py < rect.y1 - 0.5
    for (let deg = 0; deg <= 90; deg += 5) {
      const [dx, dy] = leafDir(deg)
      for (let f = 0.1; f <= 1.001; f += 0.1) if (inside(hx + dx * r * f, hy + dy * r * f)) return true
    }
    const u = leafDir(0), v = leafDir(90)
    const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2
    for (const [px, py] of [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x0, rect.y1], [rect.x1, rect.y1], [cx, cy]]) {
      const ex = px - hx, ey = py - hy
      if (ex * ex + ey * ey < r * r - 0.5 && ex * u[0] + ey * u[1] > 0.5 && ex * v[0] + ey * v[1] > 0.5) return true
    }
  }
  return false
}

function pointRectDistance(px: number, py: number, rect: Rect) {
  return Math.hypot(Math.max(rect.x0 - px, 0, px - rect.x1), Math.max(rect.y0 - py, 0, py - rect.y1))
}

function pointSegmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const ex = bx - ax, ey = by - ay
  const len2 = ex * ex + ey * ey
  const t = len2 < 1e-9 ? 0 : Math.min(1, Math.max(0, ((px - ax) * ex + (py - ay) * ey) / len2))
  return Math.hypot(px - (ax + t * ex), py - (ay + t * ey))
}

/** Exact gap between an axis-aligned rect and a line segment (0 when the segment crosses the rect). */
function rectSegmentDistance(rect: Rect, ax: number, ay: number, bx: number, by: number) {
  const inside = (px: number, py: number) => px >= rect.x0 && px <= rect.x1 && py >= rect.y0 && py <= rect.y1
  if (inside(ax, ay) || inside(bx, by)) return 0
  // apart, the nearest points are a corner of the rect and a point of the segment, or an end of the segment and an edge
  const corners: [number, number][] = [[rect.x0, rect.y0], [rect.x1, rect.y0], [rect.x1, rect.y1], [rect.x0, rect.y1]]
  let best = Math.min(pointRectDistance(ax, ay, rect), pointRectDistance(bx, by, rect))
  for (const [cx, cy] of corners) best = Math.min(best, pointSegmentDistance(cx, cy, ax, ay, bx, by))
  if (best === 0) return 0
  // the segment can still cut straight through the rect with both ends outside: then it crosses an edge
  for (let i = 0; i < 4; i++) {
    const [px, py] = corners[i], [qx, qy] = corners[(i + 1) % 4]
    const d1 = (bx - ax) * (py - ay) - (by - ay) * (px - ax), d2 = (bx - ax) * (qy - ay) - (by - ay) * (qx - ax)
    const d3 = (qx - px) * (ay - py) - (qy - py) * (ax - px), d4 = (qx - px) * (by - py) - (qy - py) * (bx - px)
    if (d1 * d2 < 0 && d3 * d4 < 0) return 0
  }
  return best
}

/**
 * How far an axis-aligned rect stays from what an inward door leaf sweeps: the quarter disc and
 * the line the fully open leaf reaches (0 when it reaches into either, Infinity with no inward
 * door). The arc is sampled every 5°, the open leaf's line is exact.
 */
function doorSwingGap(room: Room, rect: Rect, upTo = MIN_GAP): number {
  let best = Infinity
  for (const door of room.doors) {
    if (door.swing === 'out') continue
    const { hx, hy, r, leafDir } = doorSwing(room, door)
    // the disc lies inside the r-square around the hinge: anything further than upTo from that square is far enough
    if (rect.x1 < hx - r - upTo || rect.x0 > hx + r + upTo || rect.y1 < hy - r - upTo || rect.y0 > hy + r + upTo) continue
    // the nearest point of the disc lies on its outline: the arc, and the two radii (the closed leaf
    // lies in the wall, so only the open one matters)
    for (let deg = 0; deg <= 90; deg += 5) {
      const [dx, dy] = leafDir(deg)
      best = Math.min(best, pointRectDistance(hx + dx * r, hy + dy * r, rect))
    }
    const [ox, oy] = leafDir(90)
    best = Math.min(best, rectSegmentDistance(rect, hx, hy, hx + ox * r, hy + oy * r))
    if (best === 0) return 0
  }
  return best
}

/** How far an axis-aligned rect stays from the doorway strips (the 40 cm in front of each door). */
function doorwayGap(room: Room, rect: Rect): number {
  let best = Infinity
  for (const door of room.doors) best = Math.min(best, rectDistance(rect, wallStripRect(room, door.wall, door.offset, door.width, DOORWAY_DEPTH)))
  return best
}

/** The floor an inward door leaf sweeps (its bounding box), or the doorway strip of an outward one. */
function doorSweepRect(room: Room, door: Room['doors'][number]): Rect {
  return wallStripRect(room, door.wall, door.offset, door.width, door.swing === 'out' ? DOORWAY_DEPTH : door.width)
}

/** A rect grown by `by` cm on every side. */
function grow(r: Rect, by: number): Rect {
  return { x0: r.x0 - by, y0: r.y0 - by, x1: r.x1 + by, y1: r.y1 + by }
}

function makeCtx(room: Room, locked: Item[] = []): Ctx {
  return {
    room,
    // the layout heuristics think in the four sides of the room box: a window on a wall of a drawn
    // outline counts when that wall runs along one of them (its offset turned into that side's)
    windows: room.windows
      .filter((w) => w.width > 0)
      .flatMap((w) => {
        const side = sideOf(room, w.wall, w.offset, w.width)
        return side ? [{ rect: wallStripRect(room, w.wall, w.offset, w.width, WINDOW_DEPTH), sill: w.sill, height: w.height, ...side }] : []
      }),
    radiators: room.radiators.filter((r) => r.width > 0).map((r) => wallStripRect(room, r.wall, r.offset, r.width, r.depth + RADIATOR_CLEAR)),
    approaches: room.doors.map((d) => wallStripRect(room, d.wall, Math.max(0, d.offset - PATH), d.width + 2 * PATH, 100)),
    closets: (room.closets ?? []).map((c) => closetClearance(room, c).rect),
    // a door on a slanted or inner wall counts for the side it faces most
    doorWalls: new Set(room.doors.map((d) => sideOf(room, d.wall, d.offset, d.width)?.wall ?? wallFacing(room, d.wall))),
    locked,
    wantsSideTables: false,
    budget: BUDGET,
  }
}

/* ---------- occupancy grid: free floor, walkable paths, wasted slivers ---------- */

class Occupancy {
  readonly room: Room
  readonly nx: number
  readonly ny: number
  private readonly sat: Int32Array

  constructor(room: Room, rects: Rect[]) {
    this.room = room
    this.nx = Math.max(1, Math.ceil(room.w / GRID))
    this.ny = Math.max(1, Math.ceil(room.d / GRID))
    const cells = new Uint8Array(this.nx * this.ny)
    for (const r of rects) {
      const [i0, i1] = this.range(r.x0, r.x1, this.nx)
      const [j0, j1] = this.range(r.y0, r.y1, this.ny)
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) cells[j * this.nx + i] = 1
    }
    this.sat = summedArea(cells, this.nx, this.ny)
  }

  /** Cells whose centre lies strictly inside [lo, hi]. */
  range(lo: number, hi: number, n: number): [number, number] {
    const a = Math.max(0, Math.floor(lo / GRID - 0.5) + 1)
    const b = Math.min(n - 1, Math.ceil(hi / GRID - 0.5) - 1)
    return [a, b]
  }

  /** Number of occupied cells whose centre lies inside the rect. */
  count(r: Rect) {
    const [i0, i1] = this.range(r.x0, r.x1, this.nx)
    const [j0, j1] = this.range(r.y0, r.y1, this.ny)
    if (i1 < i0 || j1 < j0) return 0
    return satSum(this.sat, this.nx, i0, j0, i1, j1)
  }
}

function summedArea(cells: Uint8Array, nx: number, ny: number) {
  const sat = new Int32Array((nx + 1) * (ny + 1))
  for (let j = 0; j < ny; j++) {
    let row = 0
    for (let i = 0; i < nx; i++) {
      row += cells[j * nx + i]
      sat[(j + 1) * (nx + 1) + i + 1] = sat[j * (nx + 1) + i + 1] + row
    }
  }
  return sat
}

function satSum(sat: Int32Array, nx: number, i0: number, j0: number, i1: number, j1: number) {
  const W = nx + 1
  return sat[(j1 + 1) * W + i1 + 1] - sat[j0 * W + i1 + 1] - sat[(j1 + 1) * W + i0] + sat[j0 * W + i0]
}

/** Cells where a person (a PATH×PATH square) fits with nothing in the way, plus their summed-area table. */
function walkable(occ: Occupancy) {
  const { nx, ny, room } = occ
  const cells = new Uint8Array(nx * ny)
  const half = PATH / 2
  for (let j = 0; j < ny; j++) {
    const cy = (j + 0.5) * GRID
    if (cy - half < -0.01 || cy + half > room.d + 0.01) continue
    for (let i = 0; i < nx; i++) {
      const cx = (i + 0.5) * GRID
      if (cx - half < -0.01 || cx + half > room.w + 0.01) continue
      if (occ.count({ x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half }) === 0) cells[j * nx + i] = 1
    }
  }
  return { cells, sat: summedArea(cells, nx, ny) }
}

/** Can a person walk from the door to the bed along a PATH-wide route? */
function pathExists(occ: Occupancy, walk: Uint8Array, from: Rect, to: Rect) {
  const { nx, ny } = occ
  const half = PATH / 2
  const boxOf = (i: number, j: number): Rect => {
    const cx = (i + 0.5) * GRID, cy = (j + 0.5) * GRID
    return { x0: cx - half, y0: cy - half, x1: cx + half, y1: cy + half }
  }
  const seen = new Uint8Array(nx * ny)
  const queue: number[] = []
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const k = j * nx + i
    if (walk[k] && intersects(boxOf(i, j), from, 0)) { seen[k] = 1; queue.push(k) }
  }
  for (let q = 0; q < queue.length; q++) {
    const k = queue[q]
    const i = k % nx, j = (k - i) / nx
    if (intersects(boxOf(i, j), to, 0)) return true
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ni = i + di, nj = j + dj
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue
      const nk = nj * nx + ni
      if (!walk[nk] || seen[nk]) continue
      seen[nk] = 1
      queue.push(nk)
    }
  }
  return false
}

/**
 * Can a person walk a PATH-wide (60 cm) route from every door to within reach of `target`,
 * past the solid furniture in `items`? Exported so tests can assert it on a layout.
 */
export function walkablePath(room: Room, items: Item[], target: Item): boolean {
  const occ = new Occupancy(room, items.filter((i) => i.inRoom && !isRugKind(i.kind)).map(rectOf))
  const walk = walkable(occ)
  const t = rectOf(target)
  const near: Rect = { x0: t.x0 - 15, y0: t.y0 - 15, x1: t.x1 + 15, y1: t.y1 + 15 }
  return room.doors.every((door) => pathExists(occ, walk.cells, wallStripRect(room, door.wall, door.offset, door.width, DOORWAY_DEPTH), near))
}

/** Free floor that no PATH-wide square can reach: gaps behind and between things. In m². */
function sliverArea(occ: Occupancy, walkSat: Int32Array) {
  const { nx, ny } = occ
  const reach = Math.round(PATH / 2 / GRID)
  let slivers = 0
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const cell: Rect = { x0: i * GRID, y0: j * GRID, x1: (i + 1) * GRID, y1: (j + 1) * GRID }
    if (occ.count(cell) > 0) continue
    const i0 = Math.max(0, i - reach), i1 = Math.min(nx - 1, i + reach)
    const j0 = Math.max(0, j - reach), j1 = Math.min(ny - 1, j + reach)
    if (satSum(walkSat, nx, i0, j0, i1, j1) === 0) slivers++
  }
  return (slivers * GRID * GRID) / 10000
}

/* ---------- candidate spots ---------- */

/** Positions along a wall from lo to hi: the corners first, then working inwards. */
function* sweep(lo: number, hi: number, step = GRID) {
  if (hi < lo) return
  const pts: number[] = []
  for (let t = lo; t <= hi + 0.01; t += step) pts.push(t)
  if (pts[pts.length - 1] < hi - 0.01) pts.push(hi)
  for (let a = 0, b = pts.length - 1; a <= b; a++, b--) {
    yield pts[a]
    if (a !== b) yield pts[b]
  }
}

/**
 * A spot's centre rounded to whole centimetres without leaving the room: an odd-sized piece
 * against the far wall is rounded inwards, not half a centimetre through the wall.
 */
function snapInside(room: Room, item: Pick<Item, 'w' | 'd'>, spot: Spot): Spot {
  const { fw, fd } = footprint({ w: item.w, d: item.d, rot: spot.rot })
  const x = fw > room.w ? round(spot.x) : Math.min(Math.max(round(spot.x), Math.ceil(fw / 2)), Math.floor(room.w - fw / 2))
  const y = fd > room.d ? round(spot.y) : Math.min(Math.max(round(spot.y), Math.ceil(fd / 2)), Math.floor(room.d - fd / 2))
  return { x, y, rot: spot.rot }
}

function wallSpot(room: Room, wall: Wall, t: number, item: Pick<Item, 'w' | 'd'>): Spot {
  const rot = BACK_TO_WALL[wall]
  const { fw, fd } = footprint({ w: item.w, d: item.d, rot })
  const horizontal = wall === 'top' || wall === 'bottom'
  const depth = horizontal ? fd : fw
  const x = horizontal ? t : wall === 'left' ? depth / 2 : room.w - depth / 2
  const y = horizontal ? (wall === 'top' ? depth / 2 : room.d - depth / 2) : t
  return snapInside(room, item, { x, y, rot })
}

/**
 * Centres to try along a wall for a piece `along` cm wide: a sweep from the corners inwards in
 * `step` cm, plus spots flush against, and a walking gap away from, everything already standing
 * in the arrangement (and the closet clearance), so a piece can slot exactly between two others
 * even when that spot is off the grid. Empty when the piece is wider than the wall. With `packed`
 * only the corners and the spots against something count: the tight fits a person tries when the
 * plain sweep leaves a piece with nowhere to go.
 */
function wallPositions(ctx: Ctx, arr: Arrangement, wall: Wall, along: number, depth: number, step: number, packed = false): number[] {
  const room = ctx.room
  const L = wallLength(room, wall)
  const lo = along / 2, hi = L - along / 2
  if (hi < lo) return []
  const out: number[] = packed ? [...new Set([round(lo), round(hi)])] : [...sweep(lo, hi, step)]
  const seen = new Set(out.map((t) => round(t)))
  const horizontal = wall === 'top' || wall === 'bottom'
  // only what reaches into the band the piece will occupy along this wall can abut it there
  const band: Rect =
    wall === 'top' ? { x0: 0, y0: 0, x1: room.w, y1: depth }
    : wall === 'bottom' ? { x0: 0, y0: room.d - depth, x1: room.w, y1: room.d }
    : wall === 'left' ? { x0: 0, y0: 0, x1: depth, y1: room.d }
    : { x0: room.w - depth, y0: 0, x1: room.w, y1: room.d }
  // what already stands there: flush against it, or a walking gap away; the door sweep and the closet
  // clearance: their margin away, the preferred margin away, or a walking gap away
  const edges: { e: number; gaps: number[] }[] = []
  const add = (r: Rect, gaps: number[]) => {
    if (!intersects(r, band, 0)) return
    edges.push({ e: horizontal ? r.x0 : r.y0, gaps }, { e: horizontal ? r.x1 : r.y1, gaps })
  }
  for (const r of [...arr.solids.map((s) => s.rect), ...arr.zones.filter((z) => z.hard).map((z) => z.rect)]) add(r, [0, MIN_GAP])
  for (const c of ctx.closets) add(c, [CLOSET_MARGIN, CLOSET_PREFER, MIN_GAP])
  for (const d of room.doors) add(doorSweepRect(room, d), [DOOR_MARGIN, DOOR_PREFER, MIN_GAP])
  for (const { e, gaps } of edges) {
    for (const g of gaps) {
      for (const t of [e + g + along / 2, e - g - along / 2]) {
        const v = round(t)
        if (v < lo - 0.01 || v > hi + 0.01 || seen.has(v)) continue
        seen.add(v)
        out.push(v)
      }
    }
  }
  return out
}

/** Wall spots for the pieces placed after the anchor: a 20 cm sweep, plus the spots flush against (and a gap away from) what already stands there. */
function* wallSpots(ctx: Ctx, arr: Arrangement, item: Pick<Item, 'w' | 'd'>, walls: Wall[] = WALLS, packed = false, step = 2 * GRID): Generator<Spot> {
  const room = ctx.room
  for (const wall of walls) {
    const { fw, fd } = footprint({ w: item.w, d: item.d, rot: BACK_TO_WALL[wall] })
    const horizontal = wall === 'top' || wall === 'bottom'
    const along = horizontal ? fw : fd
    const depth = horizontal ? fd : fw
    if (along > wallLength(room, wall) || depth > (horizontal ? room.d : room.w)) continue
    for (const t of wallPositions(ctx, arr, wall, along, depth, step, packed)) yield wallSpot(room, wall, t, item)
  }
}

/** Spots on a coarse grid over the floor; a piece with a front is tried facing all four ways so it can face open floor. */
function* gridSpots(room: Room, item: Pick<Item, 'w' | 'd' | 'kind'>, step = 20): Generator<Spot> {
  const faced = accessZones({ ...item, x: 0, y: 0, rot: 0 }) !== null
  const rots: Rot[] = faced ? [0, 90, 180, 270] : item.w === item.d ? [0] : [0, 90]
  for (const rot of rots) {
    const { fw, fd } = footprint({ w: item.w, d: item.d, rot })
    if (fw > room.w || fd > room.d) continue
    for (let y = fd / 2; y <= room.d - fd / 2 + 0.01; y += step) {
      for (let x = fw / 2; x <= room.w - fw / 2 + 0.01; x += step) yield snapInside(room, item, { x, y, rot })
    }
  }
}

/* ---------- scoring one spot for one item ---------- */

/** The strips an access rule asks for around a piece standing square at a spot (quarter turns only), as plain rects. */
function zoneRects(item: Pick<Item, 'w' | 'd'>, spot: Spot, rule: AccessRule): Rect[] {
  const [nx, ny] = FRONT[snap90(spot.rot)]
  const strip = (dx: number, dy: number, across: number, depth: number, off: number): Rect => {
    const cx = spot.x + dx * (off + depth / 2), cy = spot.y + dy * (off + depth / 2)
    return dx === 0 ? rectAt(cx, cy, across, depth) : rectAt(cx, cy, depth, across)
  }
  const front = (): Rect => strip(nx, ny, item.w, rule.depth, item.d / 2)
  const back = (): Rect => strip(-nx, -ny, item.w, rule.depth, item.d / 2)
  // the item's local +x axis in room coordinates is the front vector turned a quarter back
  const sides = (): Rect[] => [strip(-ny, nx, item.d, rule.depth, item.w / 2), strip(ny, -nx, item.d, rule.depth, item.w / 2)]
  if (rule.faces === 'front') return [front()]
  if (rule.faces === 'all') return [front(), back(), ...sides()]
  return item.d >= item.w ? sides() : [front(), back()]
}

/**
 * How good a spot is for an item, or -Infinity when it is not allowed: outside the room, on
 * top of something, in the way of a door or of the closet doors, in the access space of a piece
 * already placed (unless the two belong together), or with its own drawers, doors or chair
 * facing a wall or another piece.
 */
function evaluate(ctx: Ctx, arr: Arrangement, item: Item, spot: Spot, ignore?: Item): number {
  ctx.budget--
  const room = ctx.room
  const rect = spotRect(item, spot)
  if (!insideRoom(room, rect)) return -Infinity
  for (const s of arr.solids) if (s.item !== ignore && hits(rect, s)) return -Infinity
  if (doorBlocks(room, rect)) return -Infinity
  // the closet doors' clearance and the doorway strips keep a margin, and prefer a wider one
  let score = 0
  for (const c of ctx.closets) {
    const g = rectDistance(rect, c)
    if (g < CLOSET_MARGIN) return -Infinity
    if (g < CLOSET_PREFER) score -= 2
  }
  {
    const g = doorwayGap(room, rect)
    if (g < CLOSET_MARGIN) return -Infinity
    if (g < CLOSET_PREFER) score -= 2
  }

  // the access space of what already stands there is off limits, unless the two belong together
  for (const z of arr.zones) {
    if (z.host && (z.host === ignore || accessAllows(z.host, item))) continue
    if (!z.host && z.allow?.includes(item.kind)) continue
    if (!hits(rect, z)) continue
    if (z.hard) return -Infinity
    // a bed's side strip: taking the whole strip costs half as much again as brushing a corner of it
    score += z.area ? z.penalty * (0.5 + overlapArea(rect, z.rect) / z.area) : z.penalty
  }
  // a bed beside the door leaf's sweep has the sweep as its way in and out: never. Anything else
  // keeps at least the margin from the sweep and the open leaf's line, and would rather keep more.
  {
    const g = doorSwingGap(room, rect)
    if (item.kind === 'bed') { if (g < MIN_GAP) return -Infinity }
    else if (g < DOOR_MARGIN) return -Infinity
    else if (g < DOOR_PREFER) score -= 4
  }
  // its own drawers, doors or chair need free floor in front: never facing a wall or another piece
  const rule = accessRuleFor(item)
  if (rule) {
    const zones = zoneRects(item, spot, rule)
    let clear = 0
    for (const z of zones) {
      if (rule.mode === 'all' ? !insideRoom(room, z) : fractionInRoom(room, z) < SIDE_FREE) continue
      if (arr.solids.some((s) => s.item !== ignore && !accessAllows(item, s.item) && hits(z, s))) continue
      clear++
    }
    if (rule.mode === 'all' ? clear < zones.length : clear === 0) return -Infinity
  }

  const touched = wallsTouched(room, rect)
  if (onWall(room, { ...item, rot: spot.rot }, rect)) score += 3 + (touched.length > 1 ? 1 : 0)
  if (touched.some((w) => ctx.doorWalls.has(w))) score -= 1

  for (const w of ctx.windows) {
    if (intersects(rect, w.rect) && spanOverlap(spanOf(rect, w.wall), w) >= 20) {
      if (item.h > w.sill) score -= Math.min(item.h - w.sill, w.height) / w.height > 0.7 ? 8 : 5
      else score += item.kind === 'desk' ? 4 : 0.5
    } else if (item.kind === 'desk' && rectDistance(rect, w.rect) <= 80) {
      score += 2
    }
  }
  for (const r of ctx.radiators) if (intersects(rect, r)) score -= 3
  for (const a of ctx.approaches) if (intersects(rect, a)) score -= 3

  // breathing room: anything that does not belong right next to this piece should be a walking gap
  // away — and when something has to give, it should not be the bed or the seating
  for (const s of arr.solids) {
    if (s.item === ignore || areCompanions(item, s.item)) continue
    const g = gapTo(rect, s)
    if (g < MIN_GAP) score -= gapWeight(item, s.item) * (3 + 5 * (1 - g / MIN_GAP))
  }
  // a nightstand belongs right by the bed, a chair near the desk, a side table by the sofa
  if (item.kind === 'nightstand' && arr.solids.some((s) => s.item.kind === 'bed' && rectDistance(rect, s.rect) <= 5)) score += 3
  if (item.kind === 'chair' && arr.solids.some((s) => s.item.kind === 'desk' && rectDistance(rect, s.rect) <= 30)) score += 3
  if (isSideTable(item) && arr.solids.some((s) => s.item.kind === 'sofa' && rectDistance(rect, s.rect) <= 5)) score += 3
  // the chair in front of a desk must not end up in the door swing or in someone else's access space,
  // and wants its own breathing room from the neighbours too
  if (item.kind === 'desk') {
    const chairArea = polygonBounds(frontZone(at(item, spot), accessRuleFor(item)?.depth ?? 60))
    if (doorBlocks(room, chairArea) || doorSwingGap(room, chairArea, DOOR_MARGIN) < DOOR_MARGIN) score -= 5
    if (arr.zones.some((z) => z.hard && z.host && !accessAllows(z.host, { kind: 'chair', w: 50, d: 50, h: 90 }) && hits(chairArea, z))) score -= 6
    const seat = polygonBounds(frontZone(at(item, spot), 40))
    for (const s of arr.solids) {
      if (s.item === ignore || s.item.kind === 'chair') continue
      const g = gapTo(seat, s)
      if (g < MIN_GAP) score -= 3 + 5 * (1 - g / MIN_GAP)
    }
  }
  // a sofa with a side table to come should leave room for it at one end
  if (item.kind === 'sofa' && ctx.wantsSideTables && !sideSlotFree(ctx, arr, at(item, spot), ignore)) score -= 5

  return score
}

/** Would a 50 × 50 side table fit at either end of this sofa (inside the room, on nothing, out of every hard zone)? */
function sideSlotFree(ctx: Ctx, arr: Arrangement, sofa: Item, ignore?: Item) {
  const table: Item = { ...sofa, id: `${sofa.id}-side`, kind: 'table', w: 50, d: 50, h: 55 }
  return sofaSideSpots(ctx.room, sofa, table).some((s) => {
    const r = spotRect(table, s)
    if (!insideRoom(ctx.room, r) || doorBlocks(ctx.room, r)) return false
    if (arr.solids.some((o) => o.item !== ignore && o.item !== sofa && hits(r, o))) return false
    if (ctx.closets.some((c) => intersects(r, c))) return false
    return !arr.zones.some((z) => z.hard && z.host && z.host !== ignore && !accessAllows(z.host, table) && hits(r, z))
  })
}

/* ---------- building one arrangement ---------- */

/** An empty arrangement with the locked pieces already standing where they are. */
function newArrangement(ctx: Ctx): Arrangement {
  const arr: Arrangement = { placed: new Map(), solids: [], zones: [] }
  for (const it of ctx.locked) commit(ctx, arr, it, { x: it.x, y: it.y, rot: it.rot })
  return arr
}

function commit(ctx: Ctx, arr: Arrangement, item: Item, spot: Spot) {
  const placed = at(item, spot)
  arr.placed.set(item.id, placed)
  if (!isRugKind(item.kind)) {
    const square = isAxisAligned(placed.rot)
    const solid: Solid = { item: placed, rect: rectOf(placed) }
    if (!square) solid.poly = polygonOf(placed)
    arr.solids.push(solid)
    const access = accessZones(placed)
    if (access) {
      // every strip a dresser, wardrobe, desk or dining table needs is a hard no-go; a bed's or a small
      // table's sides only need to be mostly free (one of them), so they are soft — strongly so when
      // just one is left inside the room
      const hard = access.rule.mode === 'all'
      const zones = hard ? access.zones : access.zones.filter((z) => fractionInRoom(ctx.room, z.rect) >= SIDE_FREE)
      const penalty = hard ? -4 : zones.length <= 1 ? -6 : -4
      for (const z of zones) {
        const area = hard ? undefined : (z.rect.x1 - z.rect.x0) * (z.rect.y1 - z.rect.y0)
        arr.zones.push({ rect: z.rect, poly: square ? undefined : z.poly, penalty, hard, host: placed, area })
      }
      // a bed with a single usable side (a crib against the wall) keeps a full walking gap all round:
      // whatever has to be squeezed in this room, it is not squeezed against the bed
      if (placed.kind === 'bed' && zones.length <= 1) arr.zones.push({ rect: grow(solid.rect, MIN_GAP), penalty: 0, hard: true, host: placed })
    }
  }
  return placed
}

/** The strip past a bed's foot, and the slots for nightstands at its head. */
function bedZones(bed: Item, spot: Spot, wantNightstands: boolean): Zone[] {
  const r = spotRect(bed, spot)
  const zones: Zone[] = []
  zones.push({ rect: polygonBounds(frontZone(at(bed, spot), 50)), penalty: -2, hard: false })
  if (wantNightstands) {
    // 50 cm beside each end of the headboard, against the same wall
    const head = HEAD_WALL[snap90(spot.rot)]
    const depth = 45
    const slot = (side: -1 | 1): Rect => {
      switch (head) {
        case 'top': return side < 0 ? { x0: r.x0 - 50, y0: 0, x1: r.x0, y1: depth } : { x0: r.x1, y0: 0, x1: r.x1 + 50, y1: depth }
        case 'bottom': return side < 0 ? { x0: r.x0 - 50, y0: r.y1 - depth, x1: r.x0, y1: r.y1 } : { x0: r.x1, y0: r.y1 - depth, x1: r.x1 + 50, y1: r.y1 }
        case 'left': return side < 0 ? { x0: 0, y0: r.y0 - 50, x1: depth, y1: r.y0 } : { x0: 0, y0: r.y1, x1: depth, y1: r.y1 + 50 }
        case 'right': return side < 0 ? { x0: r.x1 - depth, y0: r.y0 - 50, x1: r.x1, y1: r.y0 } : { x0: r.x1 - depth, y0: r.y1, x1: r.x1, y1: r.y1 + 50 }
      }
    }
    zones.push({ rect: slot(-1), penalty: -3, hard: false, allow: ['nightstand'] }, { rect: slot(1), penalty: -3, hard: false, allow: ['nightstand'] })
  }
  return zones
}

/** The two spots beside a bed's head for a nightstand, back to the same wall as the headboard. */
function nightstandSpots(room: Room, bed: Item, ns: Item): Spot[] {
  const head = HEAD_WALL[snap90(bed.rot)]
  const b = footprint(bed)
  const n = footprint({ w: ns.w, d: ns.d, rot: bed.rot })
  const out: Spot[] = []
  for (const side of [-1, 1]) {
    if (head === 'top' || head === 'bottom') {
      const x = bed.x + side * (b.fw / 2 + n.fw / 2)
      const y = head === 'top' ? n.fd / 2 : room.d - n.fd / 2
      out.push(snapInside(room, ns, { x, y, rot: bed.rot }))
    } else {
      const y = bed.y + side * (b.fd / 2 + n.fd / 2)
      const x = head === 'left' ? n.fw / 2 : room.w - n.fw / 2
      out.push(snapInside(room, ns, { x, y, rot: bed.rot }))
    }
  }
  return out
}

/** The two spots at the ends of a sofa for a side table, its back in line with the sofa's, facing the same way. */
function sofaSideSpots(room: Room, sofa: Item, table: Item): Spot[] {
  const out: Spot[] = []
  for (const side of [-1, 1]) {
    const [x, y] = localToRoom(sofa, side * (sofa.w / 2 + table.w / 2), -(sofa.d / 2 - table.d / 2))
    out.push(snapInside(room, table, { x, y, rot: sofa.rot }))
  }
  return out
}

/** Where a chair goes to be tucked in front of a desk, facing it. */
function chairSpot(room: Room, desk: Item, chair: Item): Spot {
  const [nx, ny] = FRONT[snap90(desk.rot)]
  const tuck = Math.min(20, chair.d * 0.35)
  const dist = desk.d / 2 + chair.d / 2 - tuck
  return snapInside(room, chair, { x: desk.x + nx * dist, y: desk.y + ny * dist, rot: (snap90(desk.rot) + 180) % 360 })
}

/** Best free spot for an item: along a wall (any of `walls`) if any wall spot is allowed, else on a coarse grid. */
function bestSpot(ctx: Ctx, arr: Arrangement, item: Item, walls: Wall[] = WALLS, packed = false): Spot | null {
  let best: Spot | null = null
  let bestScore = -Infinity
  const consider = (spots: Iterable<Spot>) => {
    for (const spot of spots) {
      const s = evaluate(ctx, arr, item, spot)
      if (s > bestScore) { bestScore = s; best = spot }
    }
  }
  consider(wallSpots(ctx, arr, item, walls, packed))
  // storage, desks, seating and beds belong against a wall: when no wall has room they stay out
  // rather than stand in the open; anything else may take a spot on the floor grid
  if (!best && !WALL_KINDS.has(item.kind) && walls === WALLS) consider(gridSpots(ctx.room, item))
  return best
}

/** The wall a standing piece's back is against (or any wall it touches); none when it stands in the open. */
function wallBehind(room: Room, item: Item): Wall | null {
  const r = rectOf(item)
  if (hasBack(item)) return touchesWall(room, r, HEAD_WALL[snap90(item.rot)]) ? HEAD_WALL[snap90(item.rot)] : null
  return wallsTouched(room, r)[0] ?? null
}

/** Rugs go where the floor is most open, centred in that open area. */
function rugSpot(ctx: Ctx, arr: Arrangement, rug: Item): Spot | null {
  const room = ctx.room
  const blocked = arr.solids.map((s) => s.rect)
  for (const p of arr.placed.values()) if (isRugKind(p.kind)) blocked.push(rectOf(p))
  const occ = new Occupancy(room, blocked)
  // a rug under the door leaf or the closet doors is only mildly annoying, so it counts for a third
  const swing = new Occupancy(room, [...room.doors.map((d) => wallStripRect(room, d.wall, d.offset, d.width, Math.min(d.width, 90))), ...ctx.closets])
  // centroid of the free floor
  let fx = 0, fy = 0, free = 0
  for (let j = 0; j < occ.ny; j++) for (let i = 0; i < occ.nx; i++) {
    const cell: Rect = { x0: i * GRID, y0: j * GRID, x1: (i + 1) * GRID, y1: (j + 1) * GRID }
    if (occ.count(cell) === 0) { fx += (i + 0.5) * GRID; fy += (j + 0.5) * GRID; free++ }
  }
  if (free) { fx /= free; fy /= free } else { fx = room.w / 2; fy = room.d / 2 }
  let best: Spot | null = null
  let bestCovered = Infinity
  let bestDist = Infinity
  for (const spot of gridSpots(room, rug, GRID)) {
    ctx.budget--
    const r = spotRect(rug, spot)
    const covered = occ.count(r) * 3 + swing.count(r)
    const dist = (spot.x - fx) ** 2 + (spot.y - fy) ** 2
    if (covered < bestCovered || (covered === bestCovered && dist < bestDist)) { best = spot; bestCovered = covered; bestDist = dist }
  }
  return best
}

const byPriority = (a: Item, b: Item) => PRIORITY[a.kind] - PRIORITY[b.kind] || b.w * b.d - a.w * a.d || a.id.localeCompare(b.id)
/** Biggest first, rugs and chairs still last: another order each anchor position is tried with. */
const bySize = (a: Item, b: Item) => Math.max(PRIORITY[a.kind], 6) - Math.max(PRIORITY[b.kind], 6) || b.w * b.d - a.w * a.d || a.id.localeCompare(b.id)
/** Tallest first (the pieces that must keep off the window), then biggest: the third order tried. */
const byHeight = (a: Item, b: Item) => Math.max(PRIORITY[a.kind], 6) - Math.max(PRIORITY[b.kind], 6) || b.h - a.h || b.w * b.d - a.w * a.d || a.id.localeCompare(b.id)

/** The nightstands (up to two) that go beside the anchor's head — only when the anchor is a bed people climb into. */
function bedsideNightstands(anchor: Item, items: Item[]): Item[] {
  if (!isRealBed(anchor)) return []
  return items.filter((i) => i.kind === 'nightstand').sort(byPriority).slice(0, 2)
}

/**
 * Everything but the anchor, in placement order: the bed's nightstands first, then by priority
 * (or by size); each desk is followed by a chair and each sofa by up to two side tables when there are any.
 */
function placementOrder(anchor: Item, items: Item[], by: (a: Item, b: Item) => number = byPriority): Item[] {
  const sorted = [...items].sort(by)
  const chairs = sorted.filter((i) => i.kind === 'chair')
  const bedside = bedsideNightstands(anchor, sorted)
  const spare = sorted.filter((i) => isSideTable(i) && !bedside.includes(i))
  const followers = new Set([...bedside, ...spare])
  const out: Item[] = [...bedside]
  if (anchor.kind === 'sofa') out.push(...spare.splice(0, 2))
  for (const it of sorted) {
    if (it.kind === 'chair' || followers.has(it)) continue
    out.push(it)
    if (it.kind === 'desk' && chairs.length) out.push(chairs.shift()!)
    if (it.kind === 'sofa') out.push(...spare.splice(0, 2))
  }
  return [...out, ...spare, ...chairs]
}

function pickAnchor(items: Item[]): Item | null {
  const area = (i: Item) => i.w * i.d
  const solid = items.filter((i) => !isRugKind(i.kind))
  const beds = solid.filter((i) => i.kind === 'bed')
  const pool = beds.length ? beds : solid
  return pool.reduce<Item | null>((best, i) => (!best || area(i) > area(best) ? i : best), null)
}

/**
 * Place everything but the anchor, in order, then the rugs. With `repair` a wall piece that finds
 * no spot may trade places with one already standing (swapIn) — the slower pass, kept for the
 * anchor spots where the plain greedy fill left something out.
 */
function buildArrangement(ctx: Ctx, anchor: Item, anchorSpot: Spot, rest: Item[], rugs: Item[], repair = false): Arrangement {
  const arr = newArrangement(ctx)
  const bed = commit(ctx, arr, anchor, anchorSpot)
  const bedside = new Set(bedsideNightstands(anchor, rest).map((i) => i.id))
  if (anchor.kind === 'bed') arr.zones.push(...bedZones(anchor, anchorSpot, bedside.size > 0))
  let nsCandidates: Spot[] = []
  let lastDesk: Item | null = null
  let lastSofa: Item | null = anchor.kind === 'sofa' ? bed : null
  let sideSlots: Spot[] = []
  for (const item of rest) {
    let spot: Spot | null = null
    if (item.kind === 'chair' && lastDesk) {
      const s = chairSpot(ctx.room, lastDesk, item)
      if (evaluate(ctx, arr, item, s, lastDesk) > -Infinity) spot = s
      lastDesk = null
    } else if (bedside.has(item.id)) {
      if (!nsCandidates.length) nsCandidates = nightstandSpots(ctx.room, bed, item)
      const idx = nsCandidates.findIndex((s) => evaluate(ctx, arr, item, s) > -Infinity)
      if (idx >= 0) spot = nsCandidates.splice(idx, 1)[0]
    } else if (isSideTable(item) && lastSofa) {
      if (!sideSlots.length) sideSlots = sofaSideSpots(ctx.room, lastSofa, item)
      const idx = sideSlots.findIndex((s) => evaluate(ctx, arr, item, s) > -Infinity)
      if (idx >= 0) spot = sideSlots.splice(idx, 1)[0]
    }
    if (!spot) spot = bestSpot(ctx, arr, item)
    // a wall piece with nowhere left to go: see whether moving one of the pieces already standing makes room for both
    const placed = spot ? commit(ctx, arr, item, spot) : repair && WALL_KINDS.has(item.kind) ? swapIn(ctx, arr, bed, item) : null
    if (placed) {
      if (item.kind === 'desk') lastDesk = placed
      if (item.kind === 'sofa') { lastSofa = placed; sideSlots = [] }
    }
  }
  finishArrangement(ctx, arr, bed, rugs)
  return arr
}

/** The way from the door repaired if a loose piece cut it off, then the rugs. */
function finishArrangement(ctx: Ctx, arr: Arrangement, anchor: Item, rugs: Item[]) {
  repairPath(ctx, arr, anchor)
  for (const rug of rugs) {
    const spot = rugSpot(ctx, arr, rug)
    if (spot) commit(ctx, arr, rug, spot)
  }
}

/** how many partial arrangements the packed search may build for one anchor spot, and how many spots it tries per piece */
const PACK_NODES = 120
const PACK_BRANCH = 6

/**
 * The tight fit a person finds when the greedy fill leaves a piece with nowhere to go: every
 * piece tried only on the spots against something (a corner, a neighbour, the margin of the door
 * sweep or the closet doors), the best few for each, backtracking when a later piece does not fit.
 * Bounded by `nodes` (shared across the orders tried for one anchor spot); null when nothing
 * complete turns up within it. Chairs, nightstands and side tables take their usual slots.
 */
function packArrangement(ctx: Ctx, anchor: Item, anchorSpot: Spot, rest: Item[], rugs: Item[], nodes: { left: number }): Arrangement | null {
  const start = newArrangement(ctx)
  const bed = commit(ctx, start, anchor, anchorSpot)
  const bedside = new Set(bedsideNightstands(anchor, rest).map((i) => i.id))
  if (anchor.kind === 'bed') start.zones.push(...bedZones(anchor, anchorSpot, bedside.size > 0))
  const clone = (a: Arrangement): Arrangement => ({ placed: new Map(a.placed), solids: [...a.solids], zones: [...a.zones] })
  interface State { lastDesk: Item | null; lastSofa: Item | null; nsSlots: Spot[] | null; sideSlots: Spot[] | null }
  const place = (arr: Arrangement, i: number, st: State): Arrangement | null => {
    if (i === rest.length) return arr
    if (nodes.left-- <= 0 || ctx.budget <= 0) return null
    const item = rest[i]
    const next: State = { ...st }
    let choices: Spot[] = []
    if (item.kind === 'chair' && st.lastDesk) {
      const s = chairSpot(ctx.room, st.lastDesk, item)
      if (evaluate(ctx, arr, item, s, st.lastDesk) > -Infinity) choices = [s]
      next.lastDesk = null
    } else if (bedside.has(item.id)) {
      const slots = st.nsSlots ?? nightstandSpots(ctx.room, bed, item)
      const idx = slots.findIndex((s) => evaluate(ctx, arr, item, s) > -Infinity)
      if (idx >= 0) { choices = [slots[idx]]; next.nsSlots = slots.filter((_, k) => k !== idx) }
    } else if (isSideTable(item) && st.lastSofa) {
      const slots = st.sideSlots ?? sofaSideSpots(ctx.room, st.lastSofa, item)
      const idx = slots.findIndex((s) => evaluate(ctx, arr, item, s) > -Infinity)
      if (idx >= 0) { choices = [slots[idx]]; next.sideSlots = slots.filter((_, k) => k !== idx) }
    }
    if (!choices.length) choices = packedSpots(ctx, arr, item)
    for (const spot of choices) {
      const trial = clone(arr)
      const placed = commit(ctx, trial, item, spot)
      const after: State = { ...next }
      if (item.kind === 'desk') after.lastDesk = placed
      if (item.kind === 'sofa') { after.lastSofa = placed; after.sideSlots = null }
      const done = place(trial, i + 1, after)
      if (done) return done
      if (nodes.left <= 0 || ctx.budget <= 0) return null
    }
    return null
  }
  const arr = place(start, 0, { lastDesk: null, lastSofa: anchor.kind === 'sofa' ? bed : null, nsSlots: null, sideSlots: null })
  if (!arr) return null
  finishArrangement(ctx, arr, bed, rugs)
  return arr
}

/** The best few spots against something for a piece (its walls first; a loose piece may take the best floor spot when no wall has room). */
function packedSpots(ctx: Ctx, arr: Arrangement, item: Item): Spot[] {
  const ranked: { spot: Spot; score: number; n: number }[] = []
  let n = 0
  for (const spot of wallSpots(ctx, arr, item, WALLS, true)) {
    const score = evaluate(ctx, arr, item, spot)
    if (score > -Infinity) ranked.push({ spot, score, n: n++ })
  }
  if (!ranked.length && !WALL_KINDS.has(item.kind)) {
    const spot = bestSpot(ctx, arr, item)
    return spot ? [spot] : []
  }
  ranked.sort((a, b) => b.score - a.score || a.n - b.n)
  return ranked.slice(0, PACK_BRANCH).map((r) => r.spot)
}

/** The arrangement without one piece (its outline and its access space). */
function without(arr: Arrangement, id: string): Arrangement {
  const placed = new Map(arr.placed)
  placed.delete(id)
  return { placed, solids: arr.solids.filter((s) => s.item.id !== id), zones: arr.zones.filter((z) => z.host?.id !== id) }
}

/** Small pieces (a hamper, a plant, a spare chair) that are free to move: not sitting with a desk, sofa or bed. */
function loosePieces(arr: Arrangement): Item[] {
  const solids = arr.solids.map((s) => s.item)
  return solids.filter((i) => {
    if (WALL_KINDS.has(i.kind) || i.locked) return false
    const near = (kind: ItemKind, reach: number) => solids.some((o) => o.kind === kind && rectDistance(rectOf(i), rectOf(o)) <= reach)
    if (i.kind === 'chair' && (near('desk', 30) || near('table', 30))) return false
    if (isSideTable(i) && (near('sofa', 5) || near('bed', 5))) return false
    return true
  })
}

/**
 * When a small piece has cut off the way from the door to the anchor (a hamper squeezed into the
 * only gap, say), move it to the best other spot that opens the way again.
 */
function repairPath(ctx: Ctx, arr: Arrangement, anchor: Item) {
  const room = ctx.room
  if (!room.doors.length) return
  const items = () => [...arr.placed.values()]
  if (walkablePath(room, items(), anchor)) return
  for (const piece of loosePieces(arr)) {
    const rest = without(arr, piece.id)
    // no point moving this one when the way is blocked without it too
    if (!walkablePath(room, [...rest.placed.values()], anchor)) continue
    let best: Spot | null = null
    let bestScore = -Infinity
    for (const spot of wallSpots(ctx, rest, piece)) {
      const s = evaluate(ctx, rest, piece, spot)
      if (s <= bestScore) continue
      if (!walkablePath(room, [...rest.placed.values(), at(piece, spot)], anchor)) continue
      best = spot
      bestScore = s
    }
    if (best) {
      arr.placed = rest.placed
      arr.solids = rest.solids
      arr.zones = rest.zones
      commit(ctx, arr, piece, best)
      return
    }
  }
  // no small piece could open the way: try moving a wall piece, its chair or side tables going with it
  for (const piece of wallPieces(arr, anchor)) {
    const followers = attachedTo(arr, piece)
    let rest = without(arr, piece.id)
    for (const f of followers) rest = without(rest, f.id)
    if (!walkablePath(room, [...rest.placed.values()], anchor)) continue
    // the best few spots by score (path checks cost real time), the first that opens the way wins
    const ranked: { spot: Spot; score: number }[] = []
    for (const spot of wallSpots(ctx, rest, piece)) {
      const s = evaluate(ctx, rest, piece, spot)
      if (s > -Infinity) ranked.push({ spot, score: s })
    }
    ranked.sort((a, b) => b.score - a.score)
    for (const { spot } of ranked.slice(0, REPAIR_TRIES)) {
      ctx.budget -= REPAIR_COST
      const trial: Arrangement = { placed: new Map(rest.placed), solids: [...rest.solids], zones: [...rest.zones] }
      const moved = commit(ctx, trial, piece, spot)
      if (!seatFollowers(ctx, trial, moved, followers)) continue
      if (!walkablePath(room, [...trial.placed.values()], anchor)) continue
      arr.placed = trial.placed
      arr.solids = trial.solids
      arr.zones = trial.zones
      return
    }
    if (ctx.budget <= 0) return
  }
}

/**
 * A piece that found no spot: take one of the wall pieces already standing (smallest first) off the
 * floor, put the new piece on its best spot, then put the other back on its best spot (its chair or
 * side tables with it). The first swap that lands both wins; null when none does. Greedy filling is
 * short-sighted in a tight room — the first pieces take the roomy spots and leave slivers — and this
 * one step of looking back finds most of what a person would.
 */
function swapIn(ctx: Ctx, arr: Arrangement, anchor: Item, item: Item): Item | null {
  for (const other of wallPieces(arr, anchor).slice(0, SWAP_TRIES)) {
    if (ctx.budget <= 0) return null
    // the room this frees is along the other piece's wall, so that is where the new piece is tried
    const wall = wallBehind(ctx.room, other)
    if (!wall) continue
    const followers = attachedTo(arr, other)
    let rest = without(arr, other.id)
    for (const f of followers) rest = without(rest, f.id)
    const spot = bestSpot(ctx, rest, item, [wall])
    if (!spot) continue
    const trial: Arrangement = { placed: new Map(rest.placed), solids: [...rest.solids], zones: [...rest.zones] }
    const placed = commit(ctx, trial, item, spot)
    const back = bestSpot(ctx, trial, other)
    if (!back) continue
    const moved = commit(ctx, trial, other, back)
    if (!seatFollowers(ctx, trial, moved, followers)) continue
    arr.placed = trial.placed
    arr.solids = trial.solids
    arr.zones = trial.zones
    return placed
  }
  return null
}

/** how many standing pieces swapIn tries to trade places with (the smallest ones) */
const SWAP_TRIES = 4
/** how many spots of a wall piece repairPath tries with a path check, and what each costs of the budget */
const REPAIR_TRIES = 6
const REPAIR_COST = 40

/** Wall pieces that may be moved to open the way: not the anchor, not locked; smallest first. */
function wallPieces(arr: Arrangement, anchor: Item): Item[] {
  return arr.solids
    .map((s) => s.item)
    .filter((i) => WALL_KINDS.has(i.kind) && !i.locked && i.id !== anchor.id)
    .sort((a, b) => a.w * a.d - b.w * b.d || a.id.localeCompare(b.id))
}

/** The chair tucked at a desk, the side tables at a sofa's ends, the nightstands by a bed: they move with it. */
function attachedTo(arr: Arrangement, host: Item): Item[] {
  const hr = rectOf(host)
  return arr.solids
    .map((s) => s.item)
    .filter((i) => {
      if (i.locked || i.id === host.id) return false
      if (host.kind === 'desk') return i.kind === 'chair' && rectDistance(rectOf(i), hr) <= 30
      if (host.kind === 'sofa') return isSideTable(i) && rectDistance(rectOf(i), hr) <= 5
      if (host.kind === 'bed') return i.kind === 'nightstand' && rectDistance(rectOf(i), hr) <= 5
      return false
    })
}

/** Put a moved piece's followers back at its side (or on the best free spot); false when one has nowhere to go. */
function seatFollowers(ctx: Ctx, arr: Arrangement, host: Item, followers: Item[]): boolean {
  let slots: Spot[] = host.kind === 'sofa' ? sofaSideSpots(ctx.room, host, followers[0] ?? host) : host.kind === 'bed' ? nightstandSpots(ctx.room, host, followers[0] ?? host) : []
  for (const f of followers) {
    let spot: Spot | null = null
    if (host.kind === 'desk') {
      const s = chairSpot(ctx.room, host, f)
      if (evaluate(ctx, arr, f, s, host) > -Infinity) spot = s
    } else {
      const idx = slots.findIndex((s) => evaluate(ctx, arr, f, s) > -Infinity)
      if (idx >= 0) spot = slots.splice(idx, 1)[0]
    }
    if (!spot) spot = bestSpot(ctx, arr, f)
    if (!spot) return false
    commit(ctx, arr, f, spot)
  }
  return true
}

/* ---------- scoring a whole arrangement ---------- */

function headSide(ctx: Ctx, bed: Item): Scored['head'] {
  const wall = HEAD_WALL[snap90(bed.rot)]
  const r = rectOf(bed)
  const corner = wallsTouched(ctx.room, r).find((w) => w !== wall)
  if (ctx.windows.some((w) => w.wall === wall && spanOverlap(spanOf(r, wall), w) >= 20)) return corner ? { wall, side: 'window', corner } : { wall, side: 'window' }
  if (corner) return { wall, side: corner, corner }
  return { wall, side: 'middle' }
}

/** The green checks that say something about the room: a piece fitting under the window, a clear entry. */
function okWorthAPoint(c: Check) {
  return c.level === 'ok' && (/ fits under /.test(c.text) || /[Cc]lear entry/.test(c.text))
}

/** The checks warn about anything closer than 60 cm to the bed — a nightstand is meant to be. */
function nightstandPassage(items: Item[], c: Check) {
  return c.level === 'warn' && c.text.startsWith('Passage between') && c.itemIds.some((id) => items.find((i) => i.id === id)?.kind === 'nightstand')
}

function deskNearWindow(ctx: Ctx, items: Item[]) {
  return items.some((i) => i.inRoom && i.kind === 'desk' && ctx.windows.some((w) => rectDistance(rectOf(i), w.rect) <= 80))
}

/**
 * How many of a bed's long sides can be used to get in: a side counts while most of its
 * 60 cm strip is inside the room and not taken by anything but a nightstand.
 */
export function usableBedSides(room: Room, bed: Item, items: Item[]): number {
  const access = accessZones(bed)
  if (!access) return 0
  let usable = 0
  for (const z of access.zones) {
    const area = (z.rect.x1 - z.rect.x0) * (z.rect.y1 - z.rect.y0)
    const inRoom = fractionInRoom(room, z.rect)
    const covered = items
      .filter((o) => o !== bed && o.id !== bed.id && o.inRoom && !isRugKind(o.kind) && !accessAllows(bed, o))
      .reduce((sum, o) => sum + overlapArea(rectOf(o), z.rect), 0) / Math.max(1, area)
    // at least 45 of the 60 cm must exist inside the room, and most of the strip must be free
    if (inRoom >= 0.75 && inRoom - covered >= SIDE_FREE) usable++
  }
  return usable
}

/**
 * Pairs of solid pieces that do not belong together and stand closer than MIN_GAP, closest first,
 * and what they cost: 3 points for a pair just under the gap rising to 8 for one touching, a pair
 * with a bed counting double and one with seating one and a half times. The most open of the
 * layouts that pass everything else is the one to recommend, so this weighs more than any single
 * amber check.
 */
function crowding(solid: Item[]): { penalty: number; pairs: TightPair[] } {
  let penalty = 0
  const pairs: TightPair[] = []
  for (let a = 0; a < solid.length; a++) {
    for (let b = a + 1; b < solid.length; b++) {
      if (areCompanions(solid[a], solid[b])) continue
      const g = itemsGap(solid[a], solid[b])
      if (g >= MIN_GAP) continue
      penalty += gapWeight(solid[a], solid[b]) * (3 + 5 * (1 - Math.max(0, g) / MIN_GAP))
      pairs.push({ a: solid[a], b: solid[b], gap: g })
    }
  }
  pairs.sort((p, q) => p.gap - q.gap || p.a.id.localeCompare(q.a.id) || p.b.id.localeCompare(q.b.id))
  return { penalty, pairs }
}

/**
 * The doorway a bed's head end meets when the headboard is on the door wall: the bed itself, or a
 * nightstand at its head, within HEAD_DOOR_REACH of the door. Walking in should not meet a headboard.
 */
function headboardByDoor(ctx: Ctx, bed: Item, solid: Item[]): boolean {
  if (bed.kind !== 'bed') return false
  const wall = HEAD_WALL[snap90(bed.rot)]
  const r = rectOf(bed)
  if (!ctx.doorWalls.has(wall) || !touchesWall(ctx.room, r, wall)) return false
  const head = [r, ...solid.filter((i) => i.kind === 'nightstand' && rectDistance(rectOf(i), r) <= 5).map(rectOf)]
  return ctx.room.doors.some((d) => d.wall === wall && head.some((h) => rectDistance(h, wallStripRect(ctx.room, d.wall, d.offset, d.width, DOORWAY_DEPTH)) < HEAD_DOOR_REACH))
}

/** Nothing left out, everyone reachable, no crowding, no red or access check: another placement order cannot beat this. */
function flawless(s: Scored) {
  return isClean(s) && !s.crowded
}

function scoreArrangement(ctx: Ctx, anchor: Item, all: Item[], order: number, parts?: string[]): Scored {
  const note = (label: string, v: number) => { if (parts && v) parts.push(`${label} ${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}`); return v }
  const room = ctx.room
  const placed = all.filter((i) => i.inRoom)
  const solid = placed.filter((i) => !isRugKind(i.kind))
  const leftOut = all.filter((i) => !i.inRoom)
  const checks = runChecks(room, all).filter((c) => !nightstandPassage(all, c))
  let score = 0
  // red and amber checks cost; the only green lines worth a point are a clear window and a clear
  // way in (a "passage ok" line only exists for pieces near the bed, so it would reward crowding it)
  for (const c of checks) score += note(`check "${c.text}"`, c.level === 'bad' ? -12 : c.level === 'warn' ? -3 : okWorthAPoint(c) ? 1 : 0)

  const bed = placed.find((i) => i.id === anchor.id) ?? null
  const head = bed ? headSide(ctx, bed) : { wall: 'top' as Wall, side: 'middle' as const }
  if (bed && bed.kind === 'bed' && !underWindow(ctx, rectOf(bed))) score += note('bed off the window', 3)
  // the anchor crowding the way in from the door is as bad as any other piece doing so
  if (bed && ctx.approaches.some((a) => intersects(rectOf(bed), a))) score += note('anchor in the door approach', -3)
  // a headboard on the door wall right by the door: you walk in and meet the bed. Only when no other wall works.
  if (bed && headboardByDoor(ctx, bed, solid)) score += note('headboard by the door', -10)
  // a nightstand that could not go beside the bed head is a nightstand in the wrong place
  if (bed) for (const ns of bedsideNightstands(anchor, solid)) if (rectDistance(rectOf(ns), rectOf(bed)) > 5) score += note(`${ns.id} away from the bed`, -8)

  const deskByWindow = deskNearWindow(ctx, placed)
  if (deskByWindow) score += note('desk by the window', 3)

  // the bed people sleep in: reachable from both sides is best, from neither is bad
  const mainBed = solid.filter(isRealBed).sort((a, b) => b.w * b.d - a.w * a.d)[0] ?? null
  if (mainBed) {
    const sides = usableBedSides(room, mainBed, solid)
    // a double bed wants both sides; a single is fine along a wall
    const double = Math.min(mainBed.w, mainBed.d) >= 120
    score += note(`${sides} bed sides usable`, double ? (sides === 2 ? 6 : sides === 1 ? -3 : -6) : sides === 2 ? 2 : sides === 1 ? 1 : -3)
  }

  const occ = new Occupancy(room, solid.map(rectOf))
  const walk = walkable(occ)
  let pathsOk = true
  // the way in must reach the bed (a crib too), else whatever the room is arranged around
  const target = solid.filter((i) => i.kind === 'bed').sort((a, b) => b.w * b.d - a.w * a.d)[0] ?? bed
  if (target) {
    const t = rectOf(target)
    const near: Rect = { x0: t.x0 - 15, y0: t.y0 - 15, x1: t.x1 + 15, y1: t.y1 + 15 }
    for (const door of room.doors) {
      if (!pathExists(occ, walk.cells, wallStripRect(room, door.wall, door.offset, door.width, DOORWAY_DEPTH), near)) pathsOk = false
    }
  }
  if (pathsOk) score += note('path from the door', 5)

  score += note('pieces on walls', Math.min(8, solid.filter((i) => onWall(room, i, rectOf(i))).length))
  // storage, desks, seating and beds belong with their back against a wall; one left standing in the open spoils the room
  score += note('wall pieces in the open', -10 * solid.filter((i) => WALL_KINDS.has(i.kind) && !onWall(room, i, rectOf(i))).length)
  // a hamper, plant or box adrift in the middle of the floor is untidy too (chairs and side tables sit with their host)
  const adrift = solid.filter((i) => !WALL_KINDS.has(i.kind) && i.kind !== 'chair' && !isSideTable(i) && !onWall(room, i, rectOf(i))).length
  score += note('loose pieces adrift', -6 * adrift)
  // a side table that did not make it to the end of a sofa
  if (solid.some((i) => i.kind === 'sofa')) {
    const bedside = new Set(bedsideNightstands(anchor, solid).map((i) => i.id))
    for (const t of solid.filter((i) => isSideTable(i) && !bedside.has(i.id))) {
      if (!solid.some((s) => s.kind === 'sofa' && rectDistance(rectOf(t), rectOf(s)) <= 5)) score += note(`${t.id} away from the sofa`, -5)
    }
  }
  score += note('wasted slivers', -sliverArea(occ, walk.sat) * 3)
  const crowd = crowding(solid)
  score += note('crowding', -crowd.penalty)
  // companions that did not make it to their host count as crowding too: another order may do better
  const stranded = (bed ? bedsideNightstands(anchor, solid).some((ns) => rectDistance(rectOf(ns), rectOf(bed)) > 5) : false) ||
    solid.some((t) => isSideTable(t) && !bedsideNightstands(anchor, solid).includes(t) && solid.some((o) => o.kind === 'sofa') && !solid.some((o) => o.kind === 'sofa' && rectDistance(rectOf(t), rectOf(o)) <= 5))
  const crowded = crowd.pairs.length > 0 || stranded
  // a piece that could not be placed is worse than any single check: the room is supposed to hold it
  score += note('left out', -20 * leftOut.length)

  return { items: all, score, checks, head, deskByWindow, pathsOk, leftOut, crowded, tight: crowd.pairs, stranded: stranded || adrift > 0, order }
}

/* ---------- words ---------- */

function shortName(item: Item) {
  return item.kind === 'box' ? item.name.toLowerCase() : item.name.length <= 16 ? item.name.toLowerCase() : KIND_LABEL[item.kind]
}

function cornerName(walls: Wall[]) {
  const v = walls.includes('top') ? 'back' : 'front'
  const h = walls.includes('left') ? 'left' : 'right'
  return `${v}-${h}`
}

function whereIs(ctx: Ctx, item: Item) {
  const r = rectOf(item)
  if (underWindow(ctx, r)) return 'under the window'
  const touched = wallsTouched(ctx.room, r)
  if (touched.length >= 2) return `in the ${cornerName(touched)} corner`
  if (touched.length === 1) return `against the ${WALL_NAME[touched[0]]}`
  return 'in the middle of the room'
}

function bedWhere(ctx: Ctx, bed: Item, s: Scored) {
  const { wall, side, corner } = s.head
  const at = wall === 'top' ? '' : ` on the ${WALL_NAME[wall]}`
  const off = touchesWall(ctx.room, rectOf(bed), wall) ? '' : `, its head ${HEAD_INSET} cm off the wall to clear the window sill`
  if (side === 'window') return `stands under the window${at}${corner ? `, along the ${WALL_NAME[corner]}` : ''}${off}`
  if (side === 'middle') return `stands against the ${WALL_NAME[wall]}${off}`
  return `runs along the ${WALL_NAME[side]} with its head to the ${WALL_NAME[wall]}${off}`
}

const capitalise = (text: string) => text.replace(/^./, (c) => c.toUpperCase())

/** The biggest solid piece standing in the room apart from the anchor, if any. */
function largestPlaced(anchor: Item, s: Scored): Item | null {
  return s.items
    .filter((i) => i.inRoom && !isRugKind(i.kind) && i.id !== anchor.id)
    .reduce<Item | null>((best, i) => (!best || i.w * i.d > best.w * best.d ? i : best), null)
}

function titleOf(ctx: Ctx, anchor: Item, s: Scored) {
  const placed = s.items.find((i) => i.id === anchor.id)?.inRoom ?? false
  let title: string
  if (!placed) {
    // the anchor did not fit: name the layout after the biggest piece that did
    const big = largestPlaced(anchor, s)
    title = big ? `${capitalise(shortName(big))} ${whereIs(ctx, big)}` : `Without the ${shortName(anchor)}`
  } else if (anchor.kind !== 'bed') {
    const piece = capitalise(shortName(anchor))
    const { wall, side, corner } = s.head
    const at = wall === 'top' ? '' : ` on the ${WALL_NAME[wall]}`
    if (side === 'window') title = `${piece} under the window${at}${corner ? `, ${cornerName([wall, corner])} corner` : ''}`
    else if (side === 'middle') title = `${piece} against the ${WALL_NAME[wall]}`
    else title = `${piece} in the ${cornerName([wall, side])} corner`
  } else {
    const piece = 'Bed'
    const { wall, side } = s.head
    if (side === 'window') title = `${piece} under the window${wall === 'top' ? '' : ` on the ${WALL_NAME[wall]}`}${s.head.corner ? `, along the ${WALL_NAME[s.head.corner]}` : ''}`
    else if (side === 'middle') title = `${piece} against the ${WALL_NAME[wall]}`
    else if (wall === 'top') title = `${piece} along the ${WALL_NAME[side]}`
    else if (wall === 'bottom') title = `${piece} along the ${WALL_NAME[side]}, head to the front`
    else title = `${piece} head against the ${WALL_NAME[wall]}, ${side === 'top' ? 'back' : 'front'} corner`
  }
  if (s.deskByWindow && s.items.some((i) => i.inRoom && i.kind === 'desk') && anchor.kind !== 'desk') title += ', desk by the window'
  return title
}

function listNames(items: Item[]) {
  const names = items.map((i) => shortName(i))
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

function joinPhrases(phrases: string[]) {
  if (phrases.length <= 1) return phrases.join('')
  return `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`
}

/** "Drawers face the room and the wardrobe can open." — only when every piece's access space is free. */
function accessNote(s: Scored) {
  if (s.checks.some(isAccessCheck)) return ''
  const placed = s.items.filter((i) => i.inRoom && !isRugKind(i.kind))
  const phrases: string[] = []
  if (placed.some((i) => i.kind === 'dresser' || i.kind === 'nightstand')) phrases.push('the drawers face the room')
  const wardrobe = placed.find((i) => i.kind === 'wardrobe')
  if (wardrobe) phrases.push(`the ${shortName(wardrobe)} can open`)
  if (!phrases.length && placed.some((i) => i.kind === 'desk')) phrases.push('there is room to pull up to the desk')
  if (!phrases.length && placed.some((i) => i.kind === 'sofa')) phrases.push('there is legroom in front of the seating')
  return phrases.length ? ` ${capitalise(joinPhrases(phrases.slice(0, 2)))}.` : ''
}

/** "the changing table stands right beside the tall cabinet and the side table 22 cm from the hamper (and 1 more)" */
function tightNote(pairs: TightPair[]) {
  const phrase = (p: TightPair, i: number) => {
    const verb = i === 0 ? 'stands ' : ''
    return p.gap <= 0.5 ? `the ${shortName(p.a)} ${verb}right beside the ${shortName(p.b)}` : `the ${shortName(p.a)} ${verb}${Math.round(p.gap)} cm from the ${shortName(p.b)}`
  }
  const shown = pairs.slice(0, 2).map(phrase)
  return `${shown.join(' and ')}${pairs.length > 2 ? ` (and ${pairs.length - 2} more)` : ''}`
}

function describe(ctx: Ctx, anchor: Item, s: Scored) {
  const placed = s.items.filter((i) => i.inRoom && !isRugKind(i.kind) && i.id !== anchor.id)
  const big = placed
    .filter((i) => !['chair', 'nightstand'].includes(i.kind))
    .sort((a, b) => b.w * b.d - a.w * a.d)
    .slice(0, 3)
  const bed = s.items.find((i) => i.id === anchor.id)!
  // without the anchor the layout is named after the biggest piece that did fit, even a chair: say where it went
  if (!bed.inRoom && !big.length) { const b = largestPlaced(anchor, s); if (b) big.push(b) }
  const anchorSentence = !bed.inRoom
    ? `The ${shortName(anchor)} does not fit in this room`
    : anchor.kind === 'bed' ? `The bed ${bedWhere(ctx, bed, s)}` : `The ${shortName(anchor)} stands ${whereIs(ctx, bed)}`
  const others = big.map((i) => `the ${shortName(i)} ${i.kind === 'desk' ? 'sits' : 'stands'} ${whereIs(ctx, i)}`)
  const first = others.length ? `${anchorSentence}; ${others.length > 1 ? `${others.slice(0, -1).join(', ')} and ${others[others.length - 1]}` : others[0]}.` : `${anchorSentence}.`
  const bad = s.checks.filter((c) => c.level === 'bad')
  const warn = s.checks.filter((c) => c.level === 'warn')
  let second: string
  if (bad.length) second = `Watch out: ${bad[0].text}${bad.length > 1 ? ` (and ${bad.length - 1} more)` : ''}.`
  else if (warn.length) second = `Trade-off: ${warn[0].text}${warn.length > 1 ? ` (and ${warn.length - 1} more)` : ''}.`
  else if (ctx.room.doors.length && !s.pathsOk) second = `Trade-off: no clear ${PATH} cm walkway from the door to the ${shortName(anchor)}.`
  else if (s.tight.length) second = `Tight fit: ${tightNote(s.tight)}.`
  else second = ctx.room.doors.length && s.pathsOk ? 'Nothing is in the way and the door opens fully.' : 'Nothing is in the way.'
  // a room too small for a walking gap everywhere: say where it was given up
  if ((bad.length || warn.length || (ctx.room.doors.length && !s.pathsOk)) && s.tight.length) second += ` Tight fit: ${tightNote(s.tight)}.`
  const adrift = strandedNote(ctx, anchor, s)
  const locked = s.items.filter((i) => i.inRoom && ctx.locked.some((l) => l.id === i.id))
  const kept = locked.length ? ` ${capitalise(listNames(locked))} ${locked.length > 1 ? 'stay' : 'stays'} where you locked ${locked.length > 1 ? 'them' : 'it'}.` : ''
  // the anchor's own absence is already the first sentence
  const leftOut = s.leftOut.filter((i) => i.id !== anchor.id)
  const out = leftOut.length ? ` ${capitalise(listNames(leftOut))} did not fit and ${leftOut.length > 1 ? 'stay' : 'stays'} out of the room.` : ''
  return `${first} ${second}${accessNote(s)}${adrift}${kept}${out}`
}

/** " The side table could not go beside the recliner, and the hamper stands in the open." — the pieces that did not land where they belong. */
function strandedNote(ctx: Ctx, anchor: Item, s: Scored) {
  const solid = s.items.filter((i) => i.inRoom && !isRugKind(i.kind))
  const phrases: string[] = []
  const bed = solid.find((i) => i.id === anchor.id)
  const bedside = bed ? bedsideNightstands(anchor, solid) : []
  for (const ns of bedside) if (bed && rectDistance(rectOf(ns), rectOf(bed)) > 5) phrases.push(`the ${shortName(ns)} could not go beside the bed`)
  const sofas = solid.filter((i) => i.kind === 'sofa')
  if (sofas.length) {
    for (const t of solid.filter((i) => isSideTable(i) && !bedside.includes(i))) {
      if (!sofas.some((o) => rectDistance(rectOf(t), rectOf(o)) <= 5)) phrases.push(`the ${shortName(t)} could not go beside the ${shortName(sofas[0])}`)
    }
  }
  for (const i of solid) {
    if (WALL_KINDS.has(i.kind) || i.kind === 'chair' || isSideTable(i)) continue
    if (!wallsTouched(ctx.room, rectOf(i)).length) phrases.push(`the ${shortName(i)} stands in the open`)
  }
  return phrases.length ? ` ${capitalise(joinPhrases(phrases.slice(0, 2)))}.` : ''
}

/* ---------- public API ---------- */

function toLayout(ctx: Ctx, anchor: Item, s: Scored, parked: Item[], i: number): Layout {
  const letter = LETTERS[i] ?? String(i + 1)
  const placements: Record<string, ItemPlacement> = {}
  for (const it of s.items) placements[it.id] = { x: it.x, y: it.y, rot: it.rot, inRoom: it.inRoom }
  for (const it of parked) placements[it.id] = { x: it.x, y: it.y, rot: it.rot, inRoom: false }
  const layout: Layout = {
    id: `sug-${letter.toLowerCase()}`,
    name: `${letter} · ${titleOf(ctx, anchor, s)}`,
    description: describe(ctx, anchor, s),
    placements,
  }
  if (i === 0) layout.recommended = true
  return layout
}

/**
 * A few good arrangements of `items` in `room`, best first; the best one is marked recommended.
 * Every item id gets a placement: what could not be placed keeps its position with inRoom false,
 * what was already out of the room (parked below the plan) stays out, where it is, and a locked
 * piece keeps its exact position and angle in every layout (unless `respectLocks` is false).
 */
export function suggestLayouts(room: Room, items: Item[], opts: SuggestOptions = {}): Layout[] {
  const max = Math.max(1, opts.max ?? 3)
  const respectLocks = opts.respectLocks ?? true
  const active = items.filter((i) => i.inRoom)
  const parked = items.filter((i) => !i.inRoom)
  const locked = respectLocks ? active.filter((i) => i.locked) : []
  const free = active.filter((i) => !locked.includes(i))
  const ctx = makeCtx(room, locked)
  const anchor = pickAnchor(free)
  if (!anchor) {
    if (!locked.length) return []
    // everything in the room is locked: the one layout is the room as it stands
    const keep = pickAnchor(locked)!
    const s = scoreArrangement(ctx, keep, active.map((i) => ({ ...i })), 0)
    const layout = toLayout(ctx, keep, s, parked, 0)
    return [{ ...layout, name: 'A · Everything stays where it is' }]
  }
  const rugs = free.filter((i) => isRugKind(i.kind))
  const others = free.filter((i) => i !== anchor && !isRugKind(i.kind))
  const rest = placementOrder(anchor, others)
  // each anchor position is also tried placing the biggest pieces first, which helps in tight rooms
  const sameOrder = (o: Item[], i: number, all: Item[][]) => all.findIndex((p) => p.map((x) => x.id).join() === o.map((x) => x.id).join()) === i
  const orders = [rest, placementOrder(anchor, others, bySize), placementOrder(anchor, others, byHeight)].filter(sameOrder)
  // and, when those leave something out or the way to the bed blocked, once more with the single biggest
  // piece (the sofa, say) before everything and the swap-in repair switched on
  const biggest = others.filter((i) => i.kind !== 'chair' && !isSideTable(i)).sort((a, b) => b.w * b.d - a.w * a.d || a.id.localeCompare(b.id))[0]
  const bigFirst = biggest ? placementOrder(anchor, others, (a, b) => (a === biggest ? -1 : b === biggest ? 1 : byPriority(a, b))) : rest
  const repairOrders = [bigFirst, ...orders].filter(sameOrder)
  const bedside = new Set(bedsideNightstands(anchor, rest).map((i) => i.id))
  ctx.wantsSideTables = rest.some((i) => isSideTable(i) && !bedside.has(i.id))

  const results: Scored[] = []
  const toRepair: AnchorTrial[] = []
  let order = 0
  const base = newArrangement(ctx)
  /** two results put the anchor at much the same place (same wall and window / corner / middle, or close together) */
  const anchorOf = (r: Scored) => r.items.find((i) => i.id === anchor.id)!
  const similar = (a: Scored, b: Scored) => {
    if (`${a.head.wall}/${a.head.side}/${a.head.corner ?? ''}` === `${b.head.wall}/${b.head.side}/${b.head.corner ?? ''}`) return true
    const A = anchorOf(a), B = anchorOf(b)
    if (A.rot !== B.rot || !A.inRoom || !B.inRoom) return false
    return Math.hypot(A.x - B.x, A.y - B.y) < Math.max(PATH, 0.25 * wallLength(room, a.head.wall))
  }
  for (const wall of WALLS) {
    const { fw, fd } = footprint({ w: anchor.w, d: anchor.d, rot: BACK_TO_WALL[wall] })
    const horizontal = wall === 'top' || wall === 'bottom'
    const along = horizontal ? fw : fd
    const depth = horizontal ? fd : fw
    const L = wallLength(room, wall)
    if (along > L || depth > (horizontal ? room.d : room.w)) continue
    const span = L - along
    const step = Math.max(GRID, Math.ceil(span / ANCHOR_STEPS / GRID) * GRID)
    for (const t of wallPositions(ctx, base, wall, along, depth, step)) {
      if (ctx.budget <= 0) break
      const spot = wallSpot(room, wall, t, anchor)
      const variants = [spot]
      // a tall headboard under a window: also try it pulled a little off the wall, as people do
      const rect = spotRect(anchor, spot)
      if (ctx.windows.some((w) => w.wall === wall && anchor.h > w.sill && spanOverlap(spanOf(rect, wall), w) >= 20)) {
        const [nx, ny] = FRONT[snap90(spot.rot)]
        variants.push({ x: spot.x + nx * HEAD_INSET, y: spot.y + ny * HEAD_INSET, rot: spot.rot })
      }
      for (const v of variants) {
        // the anchor itself must be allowed there: clear of the door, the closets, the locked pieces and their access space
        if (evaluate(ctx, base, anchor, v) === -Infinity) continue
        const trial = new AnchorTrial(ctx, anchor, v, rugs, active, order++)
        trial.run(orders, false)
        if (trial.best) results.push(trial.best)
        // a piece left out or the way to the bed blocked: worth the slower repair pass, for the best few such spots
        if (trial.best && (trial.best.leftOut.length || !trial.best.pathsOk)) toRepair.push(trial)
      }
    }
  }
  // the repair pass goes to the most promising failed spots, one per distinct anchor position first
  // so the slots are not all spent on near-identical spots along one wall
  toRepair.sort((a, b) => b.rank - a.rank || a.order - b.order)
  const repairs: AnchorTrial[] = []
  for (const pass of [true, false]) {
    for (const t of toRepair) {
      if (repairs.length >= REPAIR_SPOTS) break
      if (repairs.includes(t) || (pass && repairs.some((o) => similar(o.best!, t.best!)))) continue
      repairs.push(t)
    }
  }
  for (const trial of repairs) {
    if (ctx.budget <= 0) break
    const before = trial.best!
    trial.run(repairOrders, true)
    if (trial.best !== before) results[results.indexOf(before)] = trial.best!
  }

  if (!results.length) {
    // nothing fits against a wall (the anchor is too big for the room): leave it out, place the rest
    const arr = newArrangement(ctx)
    for (const item of rest) { const spot = bestSpot(ctx, arr, item); if (spot) commit(ctx, arr, item, spot) }
    for (const rug of rugs) { const spot = rugSpot(ctx, arr, rug); if (spot) commit(ctx, arr, rug, spot) }
    const all = active.map((i) => arr.placed.get(i.id) ?? { ...i, inRoom: false })
    results.push(scoreArrangement(ctx, anchor, all, 0))
  }

  results.sort((a, b) => b.score - a.score || a.order - b.order)
  // keep the best few that put the anchor somewhere meaningfully different
  const chosen: Scored[] = []
  const pick = (pool: Scored[], limit = max, ok: (r: Scored) => boolean = () => true) => {
    for (const r of pool) {
      if (chosen.length >= limit) break
      if (chosen.some((c) => similar(c, r)) || !ok(r)) continue
      chosen.push(r)
    }
  }
  // layouts with nothing to apologise for (no red check, every drawer and door can open, every piece
  // in, a way from the door to the bed, nothing adrift) come first. When they leave tabs free, up to
  // two "trade-off" layouts that still pass every hard rule but put the anchor on another wall fill
  // in — the description says what the trade-off is. Only when nothing passes the hard rules at all
  // do the best of the rest stand in, so the room still gets an answer.
  pick(results.filter(isClean))
  pick(results.filter((r) => hardClean(r) && !isClean(r)), Math.min(max, chosen.length + TRADE_OFFS), (r) => !chosen.some((c) => c.head.wall === r.head.wall))
  if (!chosen.length) pick(results.filter((r) => !hardClean(r)))

  return chosen.map((s, i) => toLayout(ctx, anchor, s, parked, i))
}

/** how many layouts that pass the hard rules but not the soft ones may join the clean ones */
const TRADE_OFFS = 2

/** how many of the anchor spots the plain fill could not complete get the slower repair pass (the best-scoring ones) */
const REPAIR_SPOTS = 8

/** One anchor spot: the best arrangement found for it so far over the placement orders tried. */
class AnchorTrial {
  best: Scored | null = null
  readonly order: number
  private readonly ctx: Ctx
  private readonly anchor: Item
  private readonly spot: Spot
  private readonly rugs: Item[]
  private readonly active: Item[]
  private readonly seen = new Set<string>()
  private readonly tried = new Set<Item[]>()
  /** the orders that left a piece out: the only ones a repair pass can improve on */
  private readonly failed = new Set<Item[]>()

  constructor(ctx: Ctx, anchor: Item, spot: Spot, rugs: Item[], active: Item[], order: number) {
    this.ctx = ctx
    this.anchor = anchor
    this.spot = spot
    this.rugs = rugs
    this.active = active
    this.order = order
  }

  /**
   * How promising a repair pass is: the score with most of the left-out penalty forgiven (that is
   * what the pass is for) — most, so that a spot that lost one piece still ranks above one that lost two.
   */
  get rank() {
    return this.best ? this.best.score + 15 * this.best.leftOut.length : -Infinity
  }

  /**
   * Build and score the arrangement for each order; stops early at one that no other order could
   * beat. The repair pass runs the orders with the swap-in switched on and, when that still leaves
   * something out or in the way, searches the packed fits (every piece against something, with
   * backtracking) for each order.
   */
  run(orders: Item[][], repair: boolean) {
    for (const o of orders) {
      // without a swap-in, an order that placed everything builds the same arrangement again
      if (repair && this.seen.size && !this.failed.has(o) && this.tried.has(o)) continue
      this.tried.add(o)
      const arr = buildArrangement(this.ctx, this.anchor, this.spot, o, this.rugs, repair)
      if (arr.placed.size < this.active.length) this.failed.add(o)
      if (this.consider(arr, repair)) return
    }
    // still something left out or in the way: the packed fits, with backtracking
    if (repair && this.best && !isClean(this.best)) {
      const nodes = { left: PACK_NODES }
      for (const o of orders) {
        const arr = packArrangement(this.ctx, this.anchor, this.spot, o, this.rugs, nodes)
        if (arr && this.consider(arr, true)) return
        if (nodes.left <= 0) break
      }
    }
  }

  /** Score an arrangement (once: two orders often end in the same one) and keep it when it is the best so far; true when no further order could improve on it. */
  private consider(arr: Arrangement, repair: boolean): boolean {
    const all = this.active.map((i) => arr.placed.get(i.id) ?? { ...i, inRoom: false })
    const key = all.map((i) => `${i.id}:${i.inRoom ? `${i.x},${i.y},${i.rot}` : 'out'}`).join(';')
    if (this.seen.has(key)) return false
    this.seen.add(key)
    const scored = scoreArrangement(this.ctx, this.anchor, all, this.order)
    if (!this.best || betterResult(scored, this.best)) this.best = scored
    // the other orders are for tight rooms: an arrangement with nothing wrong is not going to improve
    // (and in the repair pass, one with nothing to apologise for is all that is asked)
    return flawless(scored) || (repair && isClean(scored))
  }
}

/** Is `a` the better result for one anchor spot: it passes the hard rules when `b` does not, is clean when `b` is not, else scores higher. */
function betterResult(a: Scored, b: Scored) {
  const tier = (r: Scored) => (hardClean(r) ? 1 : 0) + (isClean(r) ? 1 : 0)
  return tier(a) !== tier(b) ? tier(a) > tier(b) : a.score > b.score
}

/**
 * The hard rules: every piece in, a way from the door to the bed, no red check, every drawer and
 * door can open. A layout that fails one of these is never offered while any layout passes them.
 */
function hardClean(r: Scored) {
  return r.pathsOk && !r.leftOut.length && !r.checks.some((c) => c.level === 'bad' || isAccessCheck(c))
}

/**
 * Nothing to apologise for: the hard rules, and every side table with its sofa, every nightstand
 * with its bed and nothing adrift in the open.
 */
function isClean(r: Scored) {
  return hardClean(r) && !r.stranded
}

/** Plain-English summary of a layout applied to these items (what the suggestions use as their description). */
export function describeLayout(room: Room, items: Item[], layout: Layout): string {
  const ctx = makeCtx(room)
  // what was out of the room and stays out took no part in the layout, so it did not "fail to fit"
  const all = items
    .filter((i) => i.inRoom || (layout.placements[i.id]?.inRoom ?? false))
    .map((i) => (layout.placements[i.id] ? { ...i, ...layout.placements[i.id] } : i))
  const anchor = pickAnchor(all.filter((i) => i.inRoom)) ?? pickAnchor(all)
  if (!anchor) return layout.description
  return describe(ctx, anchor, scoreArrangement(ctx, anchor, all, 0))
}

/** The score a layout gets from the suggestion engine, with what made it (for tests and tuning). */
export function explainScore(room: Room, items: Item[], opts: Pick<SuggestOptions, 'respectLocks'> = {}): { score: number; parts: string[] } {
  const active = items.filter((i) => i.inRoom)
  const locked = (opts.respectLocks ?? true) ? active.filter((i) => i.locked) : []
  const ctx = makeCtx(room, locked)
  const anchor = pickAnchor(active.filter((i) => !locked.includes(i))) ?? pickAnchor(active)
  if (!anchor) return { score: 0, parts: [] }
  const parts: string[] = []
  const { score } = scoreArrangement(ctx, anchor, active, 0, parts)
  return { score, parts }
}
