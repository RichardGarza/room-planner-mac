import { defaultRoom } from './data'
import { edgeWall, wallPoint } from './geometry'
import { normalizeOutline, placeByPoints } from './outline'
import type { AnyWall, Closet, Door, Item, ItemKind, ItemPlacement, Layout, Opening, Radiator, Room, RoomDoc, Rot, Wall } from './types'

export const DOC_VERSION = 2

const WALLS: Wall[] = ['top', 'bottom', 'left', 'right']

function freeId(prefix: string, used: Set<string>): string {
  for (let n = 1; ; n++) {
    const id = `${prefix}${n}`
    if (!used.has(id)) return id
  }
}

/** Next free id with the given prefix ("w1", "w2", …) that none of `existing` uses. */
export function nextOpeningId(prefix: string, existing: { id: string }[]): string {
  return freeId(prefix, new Set(existing.map((o) => o.id)))
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
/** A side, an outline wall ("e3"), or one of the old angled-corner walls (converted in withShape). */
const LEGACY_CORNERS = ['backLeft', 'backRight', 'frontLeft', 'frontRight'] as const
type LegacyCorner = (typeof LEGACY_CORNERS)[number]
const anyWallOf = (v: unknown, fallback: AnyWall): AnyWall =>
  typeof v === 'string' && (WALLS.includes(v as Wall) || /^e\d{1,2}$/.test(v) || LEGACY_CORNERS.includes(v as LegacyCorner)) ? (v as AnyWall) : fallback
const idOf = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null)

type Unkeyed<T> = Omit<T, 'id'> & { id: string | null }

function fixWindow(raw: unknown, base: Opening): Unkeyed<Opening> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Opening>
  return {
    id: idOf(o.id),
    wall: anyWallOf(o.wall, base.wall),
    offset: num(o.offset, base.offset),
    width: num(o.width, base.width),
    height: num(o.height, base.height),
    sill: num(o.sill, base.sill),
  }
}

function fixDoor(raw: unknown, base: Door): Unkeyed<Door> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Door>
  return {
    ...fixWindow(raw, base),
    sill: 0,
    hinge: o.hinge === 'left' || o.hinge === 'right' ? o.hinge : base.hinge,
    swing: o.swing === 'out' ? 'out' : 'in',
  }
}

function fixRadiator(raw: unknown, base: Radiator): Unkeyed<Radiator> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Radiator>
  return {
    id: idOf(o.id),
    wall: anyWallOf(o.wall, base.wall),
    offset: num(o.offset, base.offset),
    width: num(o.width, base.width),
    depth: num(o.depth, base.depth),
    height: num(o.height, base.height),
  }
}

const CLOSET_DOORS: Closet['doors'][] = ['none', 'hinged', 'bifold', 'sliding']

function fixCloset(raw: unknown, base: Closet): Unkeyed<Closet> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Closet>
  const closet: Unkeyed<Closet> = {
    id: idOf(o.id),
    wall: anyWallOf(o.wall, base.wall),
    offset: num(o.offset, base.offset),
    width: num(o.width, base.width),
    depth: num(o.depth, base.depth),
    doors: CLOSET_DOORS.includes(o.doors as Closet['doors']) ? (o.doors as Closet['doors']) : base.doors,
  }
  if (typeof o.height === 'number' && Number.isFinite(o.height)) closet.height = o.height
  const inside = o.inside as { offset?: unknown; width?: unknown } | undefined
  if (inside && typeof inside === 'object' && typeof inside.offset === 'number' && typeof inside.width === 'number' && Number.isFinite(inside.offset) && inside.width > 0) {
    closet.inside = { offset: inside.offset, width: inside.width }
  }
  return closet
}

/** Give every entry a unique id, keeping the ones that are already there (first one wins on a duplicate). */
function withIds<T extends { id: string | null }>(list: T[], prefix: string): (T & { id: string })[] {
  const used = new Set<string>()
  const kept = list.map((entry) => {
    if (!entry.id || used.has(entry.id)) return null
    used.add(entry.id)
    return entry.id
  })
  return list.map((entry, i) => {
    const id = kept[i] ?? freeId(prefix, used)
    used.add(id)
    return { ...entry, id }
  })
}

/**
 * Bring a room from any older saved shape up to the current one.
 * Older rooms had a single `window`, `door` and `radiator`; they become one-entry arrays.
 * Missing ids are generated, a missing door swing becomes "in", a radiator of width 0 is dropped,
 * and anything else missing is filled from the defaults so old documents keep loading.
 */
export function migrateRoom(raw: unknown): Room {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const baseWin = defaultRoom.windows[0]
  const baseDoor = defaultRoom.doors[0]
  const baseRad: Radiator = defaultRoom.radiators[0] ?? { id: 'r1', wall: 'top', offset: 0, width: 100, depth: 10, height: 60 }

  // A room that carries no opening fields at all gets the default set; one that has some keeps what it has.
  const bare = !['windows', 'window', 'doors', 'door', 'radiators', 'radiator'].some((k) => k in r)
  const winRaw: unknown[] = Array.isArray(r.windows) ? r.windows : r.window ? [r.window] : bare ? defaultRoom.windows : []
  const doorRaw: unknown[] = Array.isArray(r.doors) ? r.doors : r.door ? [r.door] : bare ? defaultRoom.doors : []
  const radRaw: unknown[] = Array.isArray(r.radiators) ? r.radiators : r.radiator ? [r.radiator] : bare ? defaultRoom.radiators : []

  const windows = withIds(winRaw.map((o) => fixWindow(o, baseWin)), 'w')
  const doors = withIds(doorRaw.map((o) => fixDoor(o, baseDoor)), 'd')
  const radiators = withIds(radRaw.map((o) => fixRadiator(o, baseRad)), 'r').filter((o) => o.width > 0)
  // closets are newer than the rest: a room without any simply has none
  const baseCloset: Closet = { id: 'c1', wall: 'right', offset: 0, width: 150, depth: 60, doors: 'bifold' }
  const closetRaw: unknown[] = Array.isArray(r.closets) ? r.closets : []
  const closets = withIds(closetRaw.map((o) => fixCloset(o, baseCloset)), 'c').filter((o) => o.width > 0)

  const colors = (r.wallColors && typeof r.wallColors === 'object' ? r.wallColors : {}) as Partial<Room['wallColors']>
  const room: Room = {
    name: typeof r.name === 'string' ? r.name : defaultRoom.name,
    subtitle: typeof r.subtitle === 'string' ? r.subtitle : defaultRoom.subtitle,
    w: num(r.w, defaultRoom.w),
    d: num(r.d, defaultRoom.d),
    h: num(r.h, defaultRoom.h),
    windows,
    doors,
    radiators,
    closets,
    wallColors: { ...defaultRoom.wallColors, ...colors },
    floorColor: typeof r.floorColor === 'string' ? r.floorColor : defaultRoom.floorColor,
  }
  return withShape(room, r.outline, r.corners)
}

/** Points of a saved outline, or null when it is not a usable shape. */
function savedOutline(raw: unknown): [number, number][] | null {
  if (!Array.isArray(raw)) return null
  const pts = raw.filter((p): p is [number, number] => Array.isArray(p) && p.length === 2 && p.every((v) => typeof v === 'number' && Number.isFinite(v)))
  if (pts.length !== raw.length) return null
  const out = normalizeOutline(pts.map(([x, y]): [number, number] => [x, y]))
  return 'error' in out ? null : out.points
}

/** Angled corners saved by the version before drawn outlines: legs in cm, each at most half its wall. */
function legacyCuts(raw: unknown, W: number, D: number): Partial<Record<LegacyCorner, { x: number; y: number }>> {
  const out: Partial<Record<LegacyCorner, { x: number; y: number }>> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const c of LEGACY_CORNERS) {
    const v = (raw as Record<string, unknown>)[c] as { x?: unknown; y?: unknown } | undefined
    const x = Math.min(num(v?.x, 0), W / 2), y = Math.min(num(v?.y, 0), D / 2)
    if (x >= 10 && y >= 10) out[c] = { x, y }
  }
  return out
}

const isLegacy = (wall: string): boolean => LEGACY_CORNERS.includes(wall as LegacyCorner)
const isEdgeId = (wall: string) => /^e\d+$/.test(wall)

/**
 * The room's shape: a saved outline; or the angled corners the version before drawn outlines cut
 * off the rectangle, turned into an outline here; or the plain rectangle. On an outline every
 * opening ends up on a wall "e<i>", at the same spot on the plan as before.
 */
function withShape(room: Room, rawOutline: unknown, rawCorners: unknown): Room {
  const W = room.w, D = room.d
  const saved = savedOutline(rawOutline)
  const cuts = saved ? {} : legacyCuts(rawCorners, W, D)
  let outline = saved
  if (!outline && Object.keys(cuts).length) {
    const bl = cuts.backLeft, br = cuts.backRight, fr = cuts.frontRight, fl = cuts.frontLeft
    const pts: [number, number][] = []
    if (bl) pts.push([0, bl.y], [bl.x, 0]); else pts.push([0, 0])
    if (br) pts.push([W - br.x, 0], [W, br.y]); else pts.push([W, 0])
    if (fr) pts.push([W, D - fr.y], [W - fr.x, D]); else pts.push([W, D])
    if (fl) pts.push([fl.x, D], [0, D - fl.y]); else pts.push([0, D])
    outline = pts
  }
  const all = [...room.windows, ...room.doors, ...room.radiators, ...(room.closets ?? [])]
  if (!outline) {
    // a plain room: an opening left on a corner that is square again moves to that corner's back or
    // front wall, and one on an outline wall (the outline was lost) to the back wall
    if (!all.some((o) => isLegacy(o.wall) || isEdgeId(o.wall))) return room
    const fix = <T extends { wall: AnyWall }>(o: T): T => (isLegacy(o.wall) ? { ...o, wall: (o.wall as string).startsWith('back') ? 'top' : 'bottom' } : isEdgeId(o.wall) ? { ...o, wall: 'top' } : o)
    return { ...room, windows: room.windows.map(fix), doors: room.doors.map(fix), radiators: room.radiators.map(fix), closets: (room.closets ?? []).map(fix) }
  }
  const shape = { w: Math.max(...outline.map((p) => p[0])), d: Math.max(...outline.map((p) => p[1])), outline }
  /** an opening's end on the plan, in the frame it was saved in (the old rectangle and its corners) */
  const point = (wall: AnyWall, t: number): [number, number] => {
    if (isLegacy(wall)) {
      const c = wall as string as LegacyCorner
      const k = cuts[c] ?? { x: 10, y: 10 }
      const back = c.startsWith('back'), left = c.endsWith('Left')
      const onAcross: [number, number] = [left ? k.x : W - k.x, back ? 0 : D]
      const onSide: [number, number] = [left ? 0 : W, back ? k.y : D - k.y]
      // the old angled wall started at its end with the smaller x
      const [a, b] = onAcross[0] < onSide[0] ? [onAcross, onSide] : [onSide, onAcross]
      const len = Math.hypot(b[0] - a[0], b[1] - a[1])
      return [a[0] + ((b[0] - a[0]) / len) * t, a[1] + ((b[1] - a[1]) / len) * t]
    }
    return wallPoint({ w: W, d: D }, wall, t)
  }
  const move = <T extends { wall: AnyWall; offset: number; width: number }>(o: T, flip: (o: T) => T = (x) => x): T => {
    // already on a wall of the saved outline: it stays (sanitizeRoom keeps it on that wall)
    if (isEdgeId(o.wall)) return { ...o, wall: edgeWall(Math.min(Number(o.wall.slice(1)), outline.length - 1)) }
    const m = placeByPoints(shape, point(o.wall, o.offset), point(o.wall, o.offset + o.width))
    if (!m) return { ...o, wall: edgeWall(0), offset: 0 }
    const moved = { ...o, wall: m.wall, offset: Math.round(m.offset * 10) / 10 }
    return m.flipped ? flip(moved) : moved
  }
  return {
    ...room,
    w: shape.w,
    d: shape.d,
    outline,
    windows: room.windows.map((o) => move(o)),
    doors: room.doors.map((o) => move(o, (x) => ({ ...x, hinge: x.hinge === 'left' ? 'right' : 'left' }))),
    radiators: room.radiators.map((o) => move(o)),
    closets: (room.closets ?? []).map((o) => move(o)),
  }
}
/* ---------- items and layouts ---------- */

const KINDS: ItemKind[] = ['bed', 'chair', 'desk', 'shelf', 'dresser', 'wardrobe', 'bookcase', 'rug', 'rugRect', 'nightstand', 'sofa', 'table', 'box']
const FALLBACK_COLOR = '#c9c2b8'
/** Furniture sizes are kept within what the planner's own inputs allow. */
const SIZE = { min: 5, max: 600 } as const
const HEIGHT = { min: 1, max: 400 } as const
/** Positions may lie outside the room (parked items sit below the plan), but not absurdly far. */
const POS = { min: -2000, max: 5000 } as const

const clampNum = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const strOf = (v: unknown, fallback: string) => (typeof v === 'string' ? v : fallback)
const boolOf = (v: unknown, fallback: boolean) => (typeof v === 'boolean' ? v : fallback)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Any finite angle is kept (normalised to 0..360); anything else is 0. */
function rotOf(v: unknown): Rot {
  if (!finite(v)) return 0
  return (((v % 360) + 360) % 360) as Rot
}

/**
 * Repair one stored item: string id and name, finite clamped sizes and position, a known kind
 * (else "box"), a valid rotation, boolean inRoom, optional string note, a colour string and the
 * locked flag when it is set. Returns null when it is not an object at all. `at` is the fallback
 * position (the room centre).
 */
export function migrateItem(raw: unknown, at: { x: number; y: number }): Unkeyed<Item> | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const kind: ItemKind = KINDS.includes(o.kind as ItemKind) ? (o.kind as ItemKind) : 'box'
  const item: Unkeyed<Item> = {
    id: idOf(o.id),
    name: strOf(o.name, '').trim() || (kind === 'rugRect' ? 'Rug' : kind.charAt(0).toUpperCase() + kind.slice(1)),
    kind,
    w: clampNum(Math.round(num(o.w, 60)), SIZE.min, SIZE.max),
    d: clampNum(Math.round(num(o.d, 60)), SIZE.min, SIZE.max),
    h: clampNum(Math.round(num(o.h, 60)), HEIGHT.min, HEIGHT.max),
    x: clampNum(num(o.x, at.x), POS.min, POS.max),
    y: clampNum(num(o.y, at.y), POS.min, POS.max),
    rot: rotOf(o.rot),
    color: strOf(o.color, '').trim() || FALLBACK_COLOR,
    inRoom: boolOf(o.inRoom, true),
  }
  if (typeof o.note === 'string' && o.note) item.note = o.note
  if (o.locked === true) item.locked = true
  return item
}

/** Every repairable item with a unique id (a missing or duplicate id becomes "item-1", "item-2", …). */
export function migrateItems(raw: unknown, room: Pick<Room, 'w' | 'd'>): Item[] {
  if (!Array.isArray(raw)) return []
  const at = { x: room.w / 2, y: room.d / 2 }
  const fixed = raw.map((r) => migrateItem(r, at)).filter((i): i is Unkeyed<Item> => i !== null)
  return withIds(fixed, 'item-')
}

function migratePlacement(raw: unknown): ItemPlacement | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (!finite(o.x) || !finite(o.y)) return null
  return { x: clampNum(o.x, POS.min, POS.max), y: clampNum(o.y, POS.min, POS.max), rot: rotOf(o.rot), inRoom: boolOf(o.inRoom, true) }
}

/** Layouts that have a string id and name and a placements object; broken placements are dropped, ids deduped. */
export function migrateLayouts(raw: unknown, room: Pick<Room, 'w' | 'd'>): Layout[] {
  if (!Array.isArray(raw)) return []
  const used = new Set<string>()
  const out: Layout[] = []
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue
    const o = entry as Record<string, unknown>
    const id = idOf(o.id)
    if (!id || used.has(id) || typeof o.name !== 'string') continue
    if (!o.placements || typeof o.placements !== 'object' || Array.isArray(o.placements)) continue
    const placements: Record<string, ItemPlacement> = {}
    for (const [itemId, p] of Object.entries(o.placements as Record<string, unknown>)) {
      const fixed = migratePlacement(p)
      if (fixed) placements[itemId] = fixed
    }
    used.add(id)
    const layout: Layout = { id, name: o.name, description: strOf(o.description, ''), placements }
    if (o.recommended === true) layout.recommended = true
    if (Array.isArray(o.items)) layout.items = migrateItems(o.items, room)
    out.push(layout)
  }
  return out
}

const DEFAULT_SETTINGS: RoomDoc['settings'] = { daytime: true, doorAngle: 70, blinds: 40, bedding: true, walkHeight: 'adult', quality: 'best', lookSensitivity: 1 }

function migrateSettings(raw: unknown): RoomDoc['settings'] {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  return {
    daytime: boolOf(o.daytime, DEFAULT_SETTINGS.daytime),
    doorAngle: clampNum(num(o.doorAngle, DEFAULT_SETTINGS.doorAngle), 0, 90),
    blinds: clampNum(num(o.blinds, DEFAULT_SETTINGS.blinds), 0, 100),
    bedding: boolOf(o.bedding, DEFAULT_SETTINGS.bedding),
    walkHeight: o.walkHeight === 'child' ? 'child' : 'adult',
    quality: o.quality === 'fast' ? 'fast' : 'best',
    lookSensitivity: clampNum(num(o.lookSensitivity, 1), 0.25, 2),
  }
}

/**
 * Same for a whole stored document. Returns null if it is not a room document at all.
 * Items and layouts are validated too, so an imported or shared file can never leave the
 * planner with an item that has no name or a NaN position.
 */
export function migrateDoc(raw: unknown): RoomDoc | null {
  if (!raw || typeof raw !== 'object') return null
  const d = raw as Record<string, unknown>
  if (!d.room || typeof d.room !== 'object' || !Array.isArray(d.items)) return null
  const room = migrateRoom(d.room)
  const ts = new Date().toISOString()
  return {
    id: idOf(d.id) ?? `room-${Math.random().toString(36).slice(2, 10)}`,
    name: strOf(d.name, '').trim() || 'Untitled room',
    group: strOf(d.group, ''),
    notes: strOf(d.notes, ''),
    createdAt: strOf(d.createdAt, ts),
    updatedAt: strOf(d.updatedAt, ts),
    room,
    items: migrateItems(d.items, room),
    layouts: migrateLayouts(d.layouts, room),
    settings: migrateSettings(d.settings),
    version: DOC_VERSION,
  }
}
