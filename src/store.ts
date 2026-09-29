import { create } from 'zustand'
import { defaultItems, defaultRoom, presetLayouts } from './data'
import { CLOSET_HEIGHT, clamp, distanceToWalls, edgeIndex, footprint, frontRecessPad, isRugKind, isSide, normalizeRot, pointInRoom, rectOf, roomWalls, wallFacing, wallFrame, wallLength, wallPoint, wallSpan } from './geometry'
import { normalizeOutline, placeByPoints, withOutline } from './outline'
import { migrateRoom, nextOpeningId } from './migrate'
import { suggestLayouts } from './suggest'
import type { AnyWall, Closet, Door, Item, ItemPlacement, Layout, Opening, Radiator, Room, RoomDoc, Wall } from './types'

export type ViewMode = 'outside' | 'walk'
export type OutsideAngle = 'corner' | 'above' | 'window' | 'door'
export type WalkPreset = 'door' | 'window'

export interface WalkPose { x: number; y: number; yaw: number; pitch: number }

export type OpeningKind = 'window' | 'door' | 'radiator' | 'closet'
type OpeningOf<K extends OpeningKind> = K extends 'window' ? Opening : K extends 'door' ? Door : K extends 'radiator' ? Radiator : Closet
const LIST_KEY = { window: 'windows', door: 'doors', radiator: 'radiators', closet: 'closets' } as const

interface Settings {
  daytime: boolean
  doorAngle: number // degrees, 0..90
  blinds: number // 0..100 (% closed)
  bedding: boolean
  walkHeight: 'adult' | 'child'
  quality: 'best' | 'fast'
  /** walk-mode mouse look multiplier (1 = default) */
  lookSensitivity: number
}

export interface NewItemSpec {
  name: string
  kind: Item['kind']
  w: number
  d: number
  h: number
  color: string
  note?: string
}

interface State extends Settings {
  room: Room
  items: Item[]
  selectedId: string | null
  activeLayoutId: string | null
  savedLayouts: Layout[]
  /** "try this" arrangements from src/suggest.ts, made on demand */
  suggestions: Layout[]
  /** the furniture or room changed since the suggestions were made */
  suggestionsStale: boolean
  view: ViewMode
  outsideAngle: OutsideAngle
  walkPose: WalkPose
  history: Item[][]
  future: Item[][]

  select: (id: string | null) => void
  moveItem: (id: string, x: number, y: number) => void
  /** Drag helper: dropping below the room parks the item, dropping inside puts it back. */
  dragTo: (id: string, x: number, y: number) => void
  /** Push the current items onto the undo stack (call before a drag starts). */
  snapshot: () => void
  /** Turns an item by any number of degrees (clockwise on the plan); the result is normalised to [0, 360). */
  rotateItem: (id: string, delta: number) => void
  /** Sets an item's angle outright (degrees, any value; normalised to [0, 360)). */
  setRotation: (id: string, deg: number) => void
  resizeItem: (id: string, size: Partial<Pick<Item, 'w' | 'd' | 'h'>>) => void
  updateItem: (id: string, patch: Partial<Pick<Item, 'name' | 'color' | 'kind' | 'note' | 'locked'>>) => void
  /** Lock or unlock a piece (locked pieces cannot be dragged or rotated). */
  toggleLock: (id: string) => void
  /** Adds an item (at the given centre, else the room centre) and returns its id. */
  addItem: (spec: NewItemSpec, at?: { x: number; y: number }) => string
  removeItem: (id: string) => void
  toggleInRoom: (id: string) => void
  setRoom: (patch: Partial<Room>) => void
  /** Give the room a drawn shape (see src/outline.ts); openings keep their place on the plan where a wall still runs there. The wall editor's Cancel is the way back. */
  setOutline: (points: [number, number][]) => void
  /** Adds a window / door / radiator / closet with sensible defaults on a wall with free space; returns its id. */
  addOpening: (kind: OpeningKind) => string
  updateOpening: <K extends OpeningKind>(kind: K, id: string, patch: Partial<OpeningOf<K>>) => void
  removeOpening: (kind: OpeningKind, id: string) => void
  applyLayout: (layout: Layout) => void
  saveLayout: (name: string) => void
  deleteLayout: (id: string) => void
  /** Work out a few good arrangements of the current furniture and keep them as suggestions. */
  generateSuggestions: () => void
  undo: () => void
  redo: () => void
  setView: (v: ViewMode) => void
  setOutsideAngle: (a: OutsideAngle) => void
  setWalkPose: (p: Partial<WalkPose>) => void
  walkTo: (preset: WalkPreset) => void
  setSetting: <K extends keyof Settings>(k: K, v: Settings[K]) => void
  shareUrl: () => string
  /** Replace the whole planner state with a stored document (used by the room library). */
  hydrate: (doc: RoomDoc) => void
  /** The parts of the planner state that belong in the stored document. */
  docState: () => Pick<RoomDoc, 'room' | 'items' | 'layouts' | 'settings'>
}

/** Placements applied to the items; a locked piece keeps its own position, angle and in/out state. */
function applyPlacements(items: Item[], placements: Record<string, ItemPlacement>): Item[] {
  return items.map((it) => (placements[it.id] && !it.locked ? { ...it, ...placements[it.id] } : it))
}

/** A saved layout's full item list, with every piece that is locked right now kept exactly where it is. */
function keepLocked(current: Item[], saved: Item[]): Item[] {
  const locked = new Map(current.filter((i) => i.locked).map((i) => [i.id, i]))
  return saved.map((it) => {
    const l = locked.get(it.id)
    return l ? { ...it, x: l.x, y: l.y, rot: l.rot, inRoom: l.inRoom, locked: true } : it
  })
}

/** Items that are out of the room sit in a parking strip below the plan (pushed down past a front-wall closet). */
export const PARK_Y = 90
export function park(room: Room, items: Item[]): Item[] {
  let slot = 0
  const pad = frontRecessPad(room)
  return items.map((it) => {
    if (it.inRoom) return it
    if (it.y > room.d + 15 + pad) return it
    const { fw } = footprint(it)
    const x = 20 + slot * 70 + fw / 2
    slot += 1
    return { ...it, x, y: room.d + PARK_Y + pad }
  })
}

function placementsOf(items: Item[]): Record<string, ItemPlacement> {
  return Object.fromEntries(items.map((i) => [i.id, { x: i.x, y: i.y, rot: i.rot, inRoom: i.inRoom }]))
}

function clampToRoom(room: Room, item: Item, x: number, y: number) {
  const { fw, fd } = footprint(item)
  return { x: clamp(x, fw / 2, room.w - fw / 2), y: clamp(y, fd / 2, room.d - fd / 2) }
}

function fitAll(room: Room, items: Item[]): Item[] {
  return park(room, items.map((i) => (i.inRoom ? { ...i, ...clampToRoom(room, i, i.x, i.y) } : i)))
}

/** Keep every opening on its wall and within the room height after the room or the opening changes. */
export function sanitizeRoom(room: Room): Room {
  const h = clamp(Math.round(room.h), 200, 400)
  let r: Room
  const outline = room.outline ? normalizeOutline(room.outline) : null
  if (outline && !('error' in outline)) {
    // a drawn room: its box follows the outline
    const pts = outline.points
    r = { ...room, h, outline: pts, w: Math.max(...pts.map((p) => p[0])), d: Math.max(...pts.map((p) => p[1])) }
  } else {
    const { outline: _dropped, ...plain } = room
    r = { ...plain, w: clamp(Math.round(room.w), 150, 1200), d: clamp(Math.round(room.d), 150, 1200), h }
  }
  const walls = roomWalls(r)
  // every opening sits on a wall the room has: in a drawn room a side becomes the outline wall
  // along it (or the first wall), in a plain room an outline wall becomes the back wall
  const onWall = (o: { wall: AnyWall; offset: number; width: number }): AnyWall => {
    if (walls.includes(o.wall)) return o.wall
    if (r.outline && isSide(o.wall)) return placeByPoints(r, wallPoint({ w: r.w, d: r.d }, o.wall, o.offset), wallPoint({ w: r.w, d: r.d }, o.wall, o.offset + o.width))?.wall ?? walls[0]
    if (r.outline) return walls[Math.min(edgeIndex(o.wall), walls.length - 1)] ?? walls[0]
    return 'top'
  }
  const fixOpening = <T extends { wall: AnyWall; offset: number; width: number }>(o: T, minWidth: number): T => {
    const wall = onWall(o)
    const len = wallLength(r, wall)
    const width = clamp(Math.round(o.width), Math.min(minWidth, Math.floor(len)), Math.floor(len))
    return { ...o, wall, width, offset: clamp(Math.round(o.offset), 0, Math.floor(len - width)) }
  }
  const windows = (r.windows ?? []).map((o) => {
    const win = fixOpening(o, 30)
    const height = clamp(Math.round(win.height), 30, h - 10)
    return { ...win, height, sill: clamp(Math.round(win.sill), 0, h - height) }
  })
  const doors = (r.doors ?? []).map((o) => {
    const door = fixOpening(o, 30)
    return { ...door, height: clamp(Math.round(door.height), 150, h - 5), sill: 0, swing: door.swing === 'out' ? 'out' as const : 'in' as const }
  })
  const radiators = (r.radiators ?? []).map((o) => {
    const rad = fixOpening(o, 20)
    return { ...rad, depth: clamp(Math.round(rad.depth), 4, 40), height: clamp(Math.round(rad.height), 20, h - 10) }
  })
  const closets = (r.closets ?? []).map((o) => {
    const closet = fixOpening(o, 40)
    const out: Closet = { ...closet, depth: clamp(Math.round(closet.depth), 30, 120) }
    if (out.height !== undefined) out.height = clamp(Math.round(out.height), 100, h - 5)
    return out
  })
  return { ...r, windows, doors, radiators, closets }
}

/* ---------- placing new openings ---------- */

const NEW_OPENING = {
  window: { width: 100, height: 120, sill: 90 },
  door: { width: 80, height: 205 },
  radiator: { width: 80, depth: 10, height: 60 },
  closet: { width: 150, depth: 60 },
} as const

/** Everything already occupying a wall, as spans along it. Radiators may sit under windows. */
function occupied(room: Room, wall: AnyWall, kind: OpeningKind): { offset: number; width: number }[] {
  const closets = room.closets ?? []
  const list: { wall: AnyWall; offset: number; width: number }[] =
    kind === 'radiator' ? [...room.doors, ...room.radiators, ...closets] : [...room.windows, ...room.doors, ...room.radiators, ...closets]
  return list.filter((o) => o.wall === wall).sort((a, b) => a.offset - b.offset)
}

/** The widest free stretch on a wall, or null when nothing fits `width` (+ margins). */
function freeRun(room: Room, wall: AnyWall, kind: OpeningKind, width: number): { start: number; size: number } | null {
  const [s0, len] = wallSpan(room, wall)
  const margin = 10
  let cursor = s0
  let best: { start: number; size: number } | null = null
  const consider = (start: number, end: number) => {
    const size = end - start
    if (size >= width + margin * 2 && (!best || size > best.size)) best = { start, size }
  }
  for (const o of occupied(room, wall, kind)) {
    consider(cursor, o.offset)
    cursor = Math.max(cursor, o.offset + o.width)
  }
  consider(cursor, len)
  return best
}

/** Centre of the widest free stretch on a wall that fits `width` (+ margins), or null. */
function freeSpot(room: Room, wall: AnyWall, kind: OpeningKind, width: number): number | null {
  const b = freeRun(room, wall, kind, width)
  return b ? Math.round(b.start + (b.size - width) / 2) : null
}

const OPPOSITE: Record<Wall, Wall> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' }

/** A closet goes on the wall with the longest free run, opposite the door wall when that one has room. */
function closetSpot(room: Room): { wall: AnyWall; offset: number; width: number } {
  const walls: AnyWall[] = room.outline ? roomWalls(room) : ['right', 'left', 'top', 'bottom']
  const doorWall = room.doors[0]?.wall
  const opposite = doorWall && isSide(doorWall) ? OPPOSITE[doorWall] : null
  for (const width of [NEW_OPENING.closet.width, 120, 90, 60]) {
    if (opposite) {
      const run = freeRun(room, opposite, 'closet', width)
      if (run) return { wall: opposite, offset: Math.round(run.start + (run.size - width) / 2), width }
    }
    let best: { wall: AnyWall; run: { start: number; size: number } } | null = null
    for (const wall of walls) {
      const run = freeRun(room, wall, 'closet', width)
      if (run && (!best || run.size > best.run.size)) best = { wall, run }
    }
    if (best) return { wall: best.wall, offset: Math.round(best.run.start + (best.run.size - width) / 2), width }
  }
  return { wall: opposite ?? walls[0], offset: 0, width: 60 }
}

function makeOpening(room: Room, kind: OpeningKind): Opening | Door | Radiator | Closet {
  if (kind === 'closet') {
    const { wall, offset, width } = closetSpot(room)
    return { id: nextOpeningId('c', room.closets ?? []), wall, offset, width, depth: NEW_OPENING.closet.depth, doors: 'bifold', height: CLOSET_HEIGHT }
  }
  // a drawn room: the longest walls first (a door prefers one facing the back of the room)
  const drawn = room.outline ? [...roomWalls(room)].sort((a, b) => wallLength(room, b) - wallLength(room, a)) : null
  const preferred: AnyWall[] = drawn
    ? (kind === 'door' ? [...drawn.filter((w) => wallFacing(room, w) === 'bottom'), ...drawn.filter((w) => wallFacing(room, w) !== 'bottom')] : drawn)
    : kind === 'door' ? ['bottom', 'left', 'right', 'top'] : ['top', 'left', 'right', 'bottom']
  const width = NEW_OPENING[kind].width
  let wall = preferred[0]
  let offset = 0
  for (const w of preferred) {
    const spot = freeSpot(room, w, kind, width)
    if (spot !== null) { wall = w; offset = spot; break }
  }
  switch (kind) {
    case 'window':
      return { id: nextOpeningId('w', room.windows), wall, offset, width, height: NEW_OPENING.window.height, sill: NEW_OPENING.window.sill }
    case 'door':
      return { id: nextOpeningId('d', room.doors), wall, offset, width, height: NEW_OPENING.door.height, sill: 0, hinge: 'left', swing: 'in' }
    case 'radiator':
      return { id: nextOpeningId('r', room.radiators), wall, offset, width, depth: NEW_OPENING.radiator.depth, height: NEW_OPENING.radiator.height }
  }
}

/** Walking: how close the eye may get to a wall and to a solid piece of furniture (WalkControls uses the same). */
export const WALK_WALL_GAP = 20
export const WALK_ITEM_GAP = 12

/** True when a standing point is inside a wall margin or within the item gap of a solid in-room piece. */
export function walkBlocked(room: Room, items: Item[], px: number, py: number): boolean {
  if (px < WALK_WALL_GAP || px > room.w - WALK_WALL_GAP || py < WALK_WALL_GAP || py > room.d - WALK_WALL_GAP) return true
  if (room.outline && (!pointInRoom(room, px, py) || distanceToWalls(room, px, py) < WALK_WALL_GAP)) return true
  return items.some((it) => {
    if (!it.inRoom || isRugKind(it.kind)) return false
    const r = rectOf(it)
    return px > r.x0 - WALK_ITEM_GAP && px < r.x1 + WALK_ITEM_GAP && py > r.y0 - WALK_ITEM_GAP && py < r.y1 + WALK_ITEM_GAP
  })
}

/**
 * The pose itself when nothing stands there; otherwise the nearest free cell of a 10 cm grid
 * within 1.5 m (same yaw and pitch), so a walk preset never starts inside the furniture.
 */
export function freeWalkPose(room: Room, items: Item[], pose: WalkPose): WalkPose {
  if (!walkBlocked(room, items, pose.x, pose.y)) return pose
  const step = 10
  const reach = 150
  const cells: { x: number; y: number; dist: number }[] = []
  for (let dy = -reach; dy <= reach; dy += step) {
    for (let dx = -reach; dx <= reach; dx += step) {
      if (dx === 0 && dy === 0) continue
      const dist = Math.hypot(dx, dy)
      if (dist <= reach) cells.push({ x: pose.x + dx, y: pose.y + dy, dist })
    }
  }
  cells.sort((a, b) => a.dist - b.dist)
  const free = cells.find((c) => !walkBlocked(room, items, c.x, c.y))
  return free ? { ...pose, x: free.x, y: free.y } : pose
}

function walkStart(room: Room, items: Item[], preset: WalkPreset): WalkPose {
  // stand just inside the opening, facing away from it
  const o = preset === 'door' ? room.doors[0] : room.windows[0]
  if (!o) return freeWalkPose(room, items, { x: room.w / 2, y: room.d / 2, yaw: 0, pitch: -0.05 })
  const t = o.offset + o.width / 2
  // stand past the swing of an inward door leaf so it is not filling the view
  const inset = preset === 'door' && (o as Door).swing !== 'out' ? Math.min(o.width + 20, room.d / 3) : 45
  // step `inset` in along the wall's inward normal and face that way (yaw 0 looks toward the back wall)
  const { start, along, normal } = wallFrame(room, o.wall)
  const pose: WalkPose = {
    x: start[0] + along[0] * t + normal[0] * inset,
    y: start[1] + along[1] * t + normal[1] * inset,
    yaw: Math.atan2(0 - normal[0], 0 - normal[1]), // 0 - n keeps a +0 (atan2(-0, -1) is -π)
    pitch: -0.05,
  }
  return freeWalkPose(room, items, pose)
}

/* ---------- URL sharing ---------- */
interface Shared { room: Room; items: Item[]; s: Partial<Settings> }

function readHash(): Shared | null {
  try {
    const h = location.hash.replace(/^#/, '')
    if (!h) return null
    const parsed = JSON.parse(decodeURIComponent(atob(h))) as Shared
    if (!parsed.room || !Array.isArray(parsed.items)) return null
    return { ...parsed, room: migrateRoom(parsed.room) }
  } catch {
    return null
  }
}

function initialState(): { room: Room; items: Item[]; layoutId: string | null; settings: Partial<Settings> } {
  const shared = readHash()
  const A = presetLayouts[0]
  if (!shared) return { room: defaultRoom, items: park(defaultRoom, applyPlacements(defaultItems, A.placements)), layoutId: A.id, settings: {} }
  const room = sanitizeRoom(shared.room)
  return { room, items: fitAll(room, shared.items), layoutId: null, settings: shared.s ?? {} }
}

const init = initialState()

const pushHistory = (s: State) => ({ history: [...s.history.slice(-49), s.items], future: [] as Item[][] })

export const useStore = create<State>((set, get) => ({
  room: init.room,
  items: init.items,
  selectedId: null,
  activeLayoutId: init.layoutId,
  savedLayouts: [],
  suggestions: [],
  suggestionsStale: false,
  view: 'outside',
  outsideAngle: 'corner',
  walkPose: walkStart(init.room, init.items, 'door'),
  history: [],
  future: [],
  daytime: true,
  doorAngle: 70,
  blinds: 40,
  bedding: true,
  walkHeight: 'adult',
  quality: 'best',
  lookSensitivity: 1,
  ...init.settings,

  select: (id) => set({ selectedId: id }),

  moveItem: (id, x, y) =>
    set((s) => {
      const it = s.items.find((i) => i.id === id)
      if (!it || it.locked) return s
      const pos = it.inRoom ? clampToRoom(s.room, it, x, y) : { x, y }
      const items = s.items.map((i) => (i.id === id ? { ...i, x: Math.round(pos.x), y: Math.round(pos.y) } : i))
      return { items, activeLayoutId: null }
    }),

  dragTo: (id, x, y) =>
    set((s) => {
      const it = s.items.find((i) => i.id === id)
      if (!it || it.locked) return s
      const inRoom = y <= s.room.d + 15
      const pad = frontRecessPad(s.room)
      const pos = inRoom ? clampToRoom(s.room, it, x, y) : { x: clamp(x, 0, s.room.w), y: clamp(y, s.room.d + 30 + pad, s.room.d + 150 + pad) }
      const items = s.items.map((i) => (i.id === id ? { ...i, inRoom, x: Math.round(pos.x), y: Math.round(pos.y) } : i))
      return { items, activeLayoutId: null }
    }),

  snapshot: () => set((s) => pushHistory(s)),

  rotateItem: (id, delta) =>
    set((s) => {
      if (s.items.find((i) => i.id === id)?.locked) return s
      const items = s.items.map((i) => {
        if (i.id !== id) return i
        const next = { ...i, rot: normalizeRot(i.rot + delta) }
        return { ...next, ...(i.inRoom ? clampToRoom(s.room, next, i.x, i.y) : {}) }
      })
      return { items, activeLayoutId: null, ...pushHistory(s) }
    }),

  setRotation: (id, deg) =>
    set((s) => {
      if (s.items.find((i) => i.id === id)?.locked) return s
      const items = s.items.map((i) => {
        if (i.id !== id) return i
        const next = { ...i, rot: normalizeRot(deg) }
        return { ...next, ...(i.inRoom ? clampToRoom(s.room, next, i.x, i.y) : {}) }
      })
      return { items, activeLayoutId: null }
    }),

  resizeItem: (id, size) =>
    set((s) => {
      const items = s.items.map((i) => {
        if (i.id !== id) return i
        const next = { ...i, ...size }
        return { ...next, ...(i.inRoom ? clampToRoom(s.room, next, i.x, i.y) : {}) }
      })
      return { items, activeLayoutId: null, suggestionsStale: true, ...pushHistory(s) }
    }),

  toggleLock: (id) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, locked: !i.locked } : i)), suggestionsStale: true, ...pushHistory(s) })),

  updateItem: (id, patch) =>
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...patch } : i)), activeLayoutId: null, ...pushHistory(s) })),

  addItem: (spec, at) => {
    const id = `item-${Math.random().toString(36).slice(2, 8)}`
    set((s) => {
      const item: Item = {
        id,
        name: spec.name.trim() || 'New item',
        kind: spec.kind,
        w: clamp(Math.round(spec.w) || 60, 5, 600),
        d: clamp(Math.round(spec.d) || 60, 5, 600),
        h: clamp(Math.round(spec.h) || 60, 1, 400),
        x: at?.x ?? s.room.w / 2,
        y: at?.y ?? s.room.d / 2,
        rot: 0,
        color: spec.color,
        inRoom: true,
        note: spec.note,
      }
      const placed = { ...item, ...clampToRoom(s.room, item, item.x, item.y) }
      return { items: [...s.items, placed], selectedId: id, activeLayoutId: null, suggestionsStale: true, ...pushHistory(s) }
    })
    return id
  },

  removeItem: (id) =>
    set((s) => ({ items: s.items.filter((i) => i.id !== id), selectedId: s.selectedId === id ? null : s.selectedId, activeLayoutId: null, suggestionsStale: true, ...pushHistory(s) })),

  toggleInRoom: (id) =>
    set((s) => {
      const items = s.items.map((i) => {
        if (i.id !== id) return i
        const inRoom = !i.inRoom
        const next = { ...i, inRoom }
        return inRoom ? { ...next, ...clampToRoom(s.room, next, i.x, Math.min(i.y, s.room.d)) } : next
      })
      return { items: park(s.room, items), activeLayoutId: null, suggestionsStale: true, ...pushHistory(s) }
    }),

  setRoom: (patch) =>
    set((s) => {
      const room = sanitizeRoom({ ...s.room, ...patch })
      const items = fitAll(room, s.items)
      return { room, items, activeLayoutId: null, suggestionsStale: true, walkPose: walkStart(room, items, 'door') }
    }),

  setOutline: (points) => {
    const s = get()
    s.setRoom(withOutline(s.room, points))
  },

  addOpening: (kind) => {
    const s = get()
    const opening = makeOpening(s.room, kind)
    const key = LIST_KEY[kind]
    const list = [...((s.room[key] ?? []) as { id: string }[]), opening]
    s.setRoom({ [key]: list } as Partial<Room>)
    return opening.id
  },

  updateOpening: (kind, id, patch) => {
    const s = get()
    const key = LIST_KEY[kind]
    const list = ((s.room[key] ?? []) as { id: string }[]).map((o) => (o.id === id ? { ...o, ...patch } : o))
    s.setRoom({ [key]: list } as Partial<Room>)
  },

  removeOpening: (kind, id) => {
    const s = get()
    const key = LIST_KEY[kind]
    const list = ((s.room[key] ?? []) as { id: string }[]).filter((o) => o.id !== id)
    s.setRoom({ [key]: list } as Partial<Room>)
  },

  applyLayout: (layout) =>
    set((s) => ({
      items: layout.items ? fitAll(s.room, keepLocked(s.items, layout.items)) : park(s.room, applyPlacements(s.items, layout.placements)),
      activeLayoutId: layout.id,
      selectedId: null,
      ...pushHistory(s),
    })),

  saveLayout: (name) =>
    set((s) => {
      const id = `saved-${Date.now()}`
      const layout: Layout = {
        id,
        name: name.trim() || `Layout ${s.savedLayouts.length + 1}`,
        description: 'Saved by you.',
        placements: placementsOf(s.items),
        items: s.items.map((i) => ({ ...i })),
      }
      const savedLayouts = [...s.savedLayouts, layout]
      return { savedLayouts, activeLayoutId: id }
    }),

  deleteLayout: (id) =>
    set((s) => {
      const savedLayouts = s.savedLayouts.filter((l) => l.id !== id)
      return { savedLayouts, activeLayoutId: s.activeLayoutId === id ? null : s.activeLayoutId }
    }),

  generateSuggestions: () =>
    set((s) => ({ suggestions: suggestLayouts(s.room, s.items), suggestionsStale: false })),

  undo: () =>
    set((s) => {
      const prev = s.history[s.history.length - 1]
      if (!prev) return s
      // the room may have shrunk since that snapshot: keep everything inside the walls
      return { items: fitAll(s.room, prev), history: s.history.slice(0, -1), future: [s.items, ...s.future], activeLayoutId: null }
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0]
      if (!next) return s
      return { items: fitAll(s.room, next), future: s.future.slice(1), history: [...s.history, s.items], activeLayoutId: null }
    }),

  setView: (view) => set({ view }),
  setOutsideAngle: (outsideAngle) => set({ outsideAngle, view: 'outside' }),
  setWalkPose: (p) => set((s) => ({ walkPose: { ...s.walkPose, ...p } })),
  walkTo: (preset) => set((s) => ({ walkPose: walkStart(s.room, s.items, preset), view: 'walk' })),
  setSetting: (k, v) => set({ [k]: v } as Pick<Settings, typeof k>),

  shareUrl: () => {
    const s = get()
    const shared: Shared = {
      room: s.room,
      items: s.items,
      s: { daytime: s.daytime, doorAngle: s.doorAngle, blinds: s.blinds, bedding: s.bedding, walkHeight: s.walkHeight },
    }
    const hash = btoa(encodeURIComponent(JSON.stringify(shared)))
    return `${location.origin}${location.pathname}#${hash}`
  },

  hydrate: (doc) => {
    const room = sanitizeRoom({ ...defaultRoom, ...doc.room })
    const items = fitAll(room, doc.items)
    // if the furniture sits exactly where a preset puts it, light up that tab
    // (park() rewrites the x/y of anything out of the room, so for those only "out" has to match)
    const matches = (l: Layout) => items.every((i) => {
      const p = l.placements[i.id]
      if (!p || p.inRoom !== i.inRoom) return false
      return !i.inRoom || (p.x === i.x && p.y === i.y && p.rot === i.rot)
    })
    const preset = items.length ? presetLayouts.find(matches) : undefined
    set({
      room,
      items,
      savedLayouts: doc.layouts ?? [],
      suggestions: [],
      suggestionsStale: false,
      ...doc.settings,
      selectedId: null,
      activeLayoutId: preset?.id ?? null,
      history: [],
      future: [],
      view: 'outside',
      walkPose: walkStart(room, items, 'door'),
    })
  },

  docState: () => {
    const s = get()
    return {
      room: s.room,
      items: s.items,
      layouts: s.savedLayouts,
      settings: { daytime: s.daytime, doorAngle: s.doorAngle, blinds: s.blinds, bedding: s.bedding, walkHeight: s.walkHeight, quality: s.quality, lookSensitivity: s.lookSensitivity },
    }
  },
}))
