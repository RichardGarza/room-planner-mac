import { create } from 'zustand'
import { findPreset } from './catalog'
import { defaultItems, defaultRoom, makeEmptyRoom, presetLayouts } from './data'
import { doorClearance, doorwayRect, intersects, isRugKind, rectOf } from './geometry'
import { migrateDoc } from './migrate'
import { findFreeSpot, type PlacementOptions, type Spot } from './placement'
import { bedroomTwo, forestsRoom } from './seeds'
import { getStorage, isTauri, summarize, type RoomStorage } from './storage'
import { park, useStore } from './store'
import type { CatalogEntry, Door, Item, Opening, Room, RoomDoc, RoomSummary } from './types'
import type { Unit } from './units'

/*
 * The room library: a list of saved room documents (one per real room or
 * renovation idea), which one is open in the planner, and autosave while it is.
 */

export type LibraryStatus = 'idle' | 'loading' | 'saved' | 'saving' | 'dirty' | 'error'

/** What a new room starts with: starter furniture, nothing, or a copy of the example room. */
export type StartWith = 'basics' | 'empty' | 'example'

export interface CreateInput {
  name: string
  group?: string
  w?: number
  d?: number
  h?: number
  /**
   * 'basics' (default): the shell plus a bed, dresser, desk and rug from the catalogue;
   * 'empty': just the shell with its window and door; 'example': a copy of Mila's room.
   */
  start?: StartWith
  /** older alias for start: 'example' */
  fromExample?: boolean
}

export type CopyMode = 'copy' | 'move'

export interface CopyResult {
  /** true when it landed on a free spot in the target room; false when it is parked beside that plan */
  placed: boolean
  targetName: string
  /** where it landed when placed, e.g. "against the left wall" */
  where?: string
}

interface LibraryState {
  rooms: RoomSummary[]
  /** distinct non-empty group names, sorted */
  groups: string[]
  currentId: string | null
  status: LibraryStatus
  error: string | null
  /** human-readable place where the rooms are kept, from the storage backend */
  location: string

  /** Test hook / override: use a different storage backend. */
  configure: (opts: { storage?: RoomStorage | null }) => void
  /** First call on app start: refresh the list, seed the example, open a shared link. */
  start: () => Promise<void>
  refresh: () => Promise<void>
  create: (input: CreateInput) => Promise<string>
  open: (id: string) => Promise<void>
  close: () => Promise<void>
  duplicate: (id: string) => Promise<string | null>
  rename: (id: string, name: string) => Promise<void>
  setGroup: (id: string, group: string) => Promise<void>
  setNotes: (id: string, notes: string) => Promise<void>
  remove: (id: string) => Promise<void>
  exportDoc: (id: string) => Promise<void>
  importDoc: () => Promise<string | null>
  /** Add a room from a file's contents (already picked and parsed) and open it; null when it is not a room. */
  importRoom: (raw: unknown) => Promise<string | null>
  saveNow: () => Promise<void>
  /**
   * Copy (or move) one of the open room's items into another saved room, on a free spot there
   * or parked beside its plan when nothing fits. Rejects with a readable message.
   */
  copyItemToRoom: (itemId: string, targetId: string, mode: CopyMode) => Promise<CopyResult>
}

/** The one flag older versions set after seeding the example room; see seedKey. */
export const SEEDED_KEY = 'room-planner.seeded'
/** The example room's id in the library (copies made with start: 'example' get fresh ids). */
export const EXAMPLE_ID = 'room-example'
/** Per-document flag: this seed was added once. It stays after the room is deleted. */
export const seedKey = (id: string) => `${SEEDED_KEY}.${id}`
/**
 * A change is written as soon as the burst of updates it came in is done (0 ms: the next tick).
 * While a pointer is held down (a drag, a slider) it waits and is written the moment it is released,
 * so nothing is ever left unsaved for long: quitting the app cannot lose an edit.
 */
export const AUTOSAVE_MS = 0

/* ---------- helpers ---------- */

export const newId = () => `room-${Math.random().toString(36).slice(2, 10)}`

/** What the new-room form starts with: 10 × 12 ft, 8 ft ceiling in inches, else 300 × 400 × 260 cm. */
export function defaultRoomSize(unit: Unit): { w: number; d: number; h: number } {
  return unit === 'in' ? { w: 305, d: 366, h: 244 } : { w: 300, d: 400, h: 260 }
}
const now = () => new Date().toISOString()

let storageOverride: RoomStorage | null = null
/** Where rooms (and houses) are kept: the configured backend, or the test override. */
export function libraryStorage(): Promise<RoomStorage> {
  return storage()
}
function storage(): Promise<RoomStorage> {
  return storageOverride ? Promise.resolve(storageOverride) : getStorage()
}

function flagGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function flagSet(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode etc. */ }
}

function groupsOf(rooms: RoomSummary[]): string[] {
  return [...new Set(rooms.map((r) => r.group).filter(Boolean))].sort((a, b) => a.localeCompare(b))
}

function applyPlacements(items: Item[], placements: Record<string, Partial<Item>>): Item[] {
  return items.map((it) => (placements[it.id] ? { ...it, ...placements[it.id] } : it))
}

/** Mila's room with layout A applied, as a fresh document. */
export function exampleDoc(name = defaultRoom.name, group = 'Examples'): RoomDoc {
  const ts = now()
  return migrateDoc({
    id: newId(),
    name,
    group,
    notes: '',
    createdAt: ts,
    updatedAt: ts,
    room: { ...defaultRoom, name },
    items: applyPlacements(defaultItems, presetLayouts[0].placements).map((i) => ({ ...i })),
    layouts: presetLayouts.map((l) => ({ ...l, placements: { ...l.placements } })),
  })!
}

/* ---------- seeds ---------- */

/**
 * Rooms every library starts with: the example room and Forest's nursery. On every refresh a seed
 * whose id is missing and whose flag is unset is saved and flagged, so each appears once per browser
 * and deleting it never brings it back. The flags live in localStorage and, where the backend keeps
 * them (the rooms folder), next to the rooms, so a fresh copy of the app does not bring one back.
 */
/** Bump when the example room's contents change so unedited seeded copies are refreshed. */
const EXAMPLE_SEED_TIME = '2026-09-25T00:00:00.000Z'
const seedBuilders: (() => RoomDoc)[] = [
  () => ({ ...exampleDoc(), id: EXAMPLE_ID, createdAt: EXAMPLE_SEED_TIME, updatedAt: EXAMPLE_SEED_TIME }),
  forestsRoom,
  bedroomTwo,
]

/** Ids the storage backend has recorded as seeded; empty when it keeps none or cannot be read. */
async function sharedSeeds(s: RoomStorage): Promise<Set<string>> {
  if (!s.seededIds) return new Set()
  try {
    return new Set(await s.seededIds())
  } catch (e) {
    console.warn('Could not read the seeded-rooms record', e)
    return new Set()
  }
}

/** Add the seeds that are missing and not yet flagged; true when something was saved. */
async function seedMissing(s: RoomStorage, list: RoomSummary[]): Promise<boolean> {
  // before per-document flags there was a single flag, set once the example had been seeded
  if (flagGet(SEEDED_KEY) && !flagGet(seedKey(EXAMPLE_ID))) flagSet(seedKey(EXAMPLE_ID), '1')
  const shared = await sharedSeeds(s)
  const record: string[] = []
  let added = false
  for (const build of seedBuilders) {
    const doc = build()
    const existing = list.find((r) => r.id === doc.id)
    // a seeded room the person never edited is refreshed when the seed itself changes
    if (existing && existing.updatedAt === existing.createdAt && existing.updatedAt !== doc.updatedAt) {
      await s.save(doc)
      added = true
    }
    if (!shared.has(doc.id)) record.push(doc.id)
    if (flagGet(seedKey(doc.id)) || shared.has(doc.id)) {
      flagSet(seedKey(doc.id), '1')
      continue
    }
    if (!existing) {
      await s.save(doc)
      added = true
    }
    flagSet(seedKey(doc.id), '1')
  }
  if (record.length && s.markSeeded) {
    try {
      await s.markSeeded(record)
    } catch (e) {
      console.warn('Could not update the seeded-rooms record', e)
    }
  }
  return added
}

/* ---------- starter furniture ---------- */

/** Catalogue presets by id, in the given order, skipping any id that does not exist. */
const presets = (ids: string[]) => ids.map(findPreset).filter((p): p is CatalogEntry => p !== undefined)

function itemFrom(p: CatalogEntry, key: string, spot: Spot): Item {
  const item: Item = {
    id: `item-${key}-1`, name: p.name, kind: p.kind, w: p.w, d: p.d, h: p.h,
    x: spot.x, y: spot.y, rot: spot.rot, color: p.color, inRoom: true,
  }
  return p.note ? { ...item, note: p.note } : item
}

/** True when the piece lies inside the room and clear of every solid item already placed (rugs go under things). */
function clearOfFurniture(room: Room, items: Item[], item: Item): boolean {
  const r = rectOf(item)
  if (r.x0 < -0.01 || r.y0 < -0.01 || r.x1 > room.w + 0.01 || r.y1 > room.d + 0.01) return false
  return !items.some((o) => o.inRoom && !isRugKind(o.kind) && intersects(r, rectOf(o)))
}

/** True when the piece lies inside the room, clear of the door and of every solid item already placed. */
function fitsAt(room: Room, items: Item[], item: Item): boolean {
  if (!clearOfFurniture(room, items, item)) return false
  if (isRugKind(item.kind)) return true
  const r = rectOf(item)
  return doorClearance(room, [item]).maxAngle === 90 && !room.doors.some((door) => intersects(r, doorwayRect(room, door)))
}

/** Touches one of the four walls. */
function againstWall(room: Room, item: Item): boolean {
  const r = rectOf(item)
  return r.x0 <= 0.5 || r.y0 <= 0.5 || r.x1 >= room.w - 0.5 || r.y1 >= room.d - 0.5
}

/**
 * "The basics" for a fresh room: a double bed, a wide dresser, a desk and a round rug from the
 * catalogue, each dropped on a free spot in that order (the rug last, working out from the
 * middle). A piece that does not fit is swapped for a smaller one or left out. The ids are
 * fresh (item-bed-1, …) so the example room's preset layouts never apply to these.
 */
export function starterItems(room: Room): Item[] {
  const items: Item[] = []
  const place = (key: string, candidates: CatalogEntry[], opts: PlacementOptions = {}) => {
    const fitting = candidates
      .map((p) => itemFrom(p, key, findFreeSpot(room, items, p.w, p.d, { h: p.h, ...opts })))
      .filter((it) => fitsAt(room, items, it))
    // a bed, dresser or desk belongs against a wall: the biggest that gets one, else the biggest that fits at all
    const pick = opts.prefer === 'centre' ? fitting[0] : (fitting.find((it) => againstWall(room, it)) ?? fitting[0])
    if (pick) items.push(pick)
  }
  place('bed', presets(['double-bed', 'single-bed-frame']))
  place('dresser', presets(['dresser-wide-6', 'dresser-short-3', 'chest-tall']))
  place('desk', presets(['desk-small', 'desk-kids']))
  place('rug', presets([room.w < 250 ? 'rug-round-120' : 'rug-round-160']), { prefer: 'centre' })
  return items
}

/* ---------- copying an item to another room ---------- */

/** A fresh copy of an item for another room, dropped on a free spot there (findFreeSpot's centre fallback when there is none). */
function cloneInto(target: RoomDoc, item: Item): Item {
  const taken = new Set(target.items.map((i) => i.id))
  let id = ''
  do id = `${item.kind}-${Math.random().toString(36).slice(2, 8)}`
  while (taken.has(id))
  const spot = findFreeSpot(target.room, target.items, item.w, item.d, { h: item.h })
  const clone: Item = {
    id, name: item.name, kind: item.kind, w: item.w, d: item.d, h: item.h,
    x: spot.x, y: spot.y, rot: spot.rot, color: item.color, inRoom: true,
  }
  return item.note ? { ...clone, note: item.note } : clone
}

/** Where a placed item sits, for the "Copied to…" message: "against the left wall", "in the back-right corner", … */
function describeSpot(room: Room, item: Item): string {
  const r = rectOf(item)
  const near = 1
  const x = r.x0 <= near ? 'left' : r.x1 >= room.w - near ? 'right' : ''
  const y = r.y0 <= near ? 'back' : r.y1 >= room.d - near ? 'front' : ''
  if (x && y) return `in the ${y}-${x} corner`
  if (x) return `against the ${x} wall`
  if (y) return `against the ${y} wall`
  return 'in the middle of the room'
}

/** A new room of the given size: the shell, plus the starter furniture unless it should stay empty. */
function freshDoc(input: CreateInput, start: StartWith): RoomDoc {
  const ts = now()
  const room = makeEmptyRoom(input.name, input.w ?? 300, input.d ?? 400, input.h ?? 260)
  return migrateDoc({
    id: newId(),
    name: input.name,
    group: input.group ?? '',
    notes: '',
    createdAt: ts,
    updatedAt: ts,
    room,
    items: start === 'basics' ? starterItems(room) : [],
    layouts: [],
  })!
}

/** Openings of a room (older documents are converted by migrateRoom before they get here). */
export function roomOpenings(room: Room): { windows: Opening[]; doors: Door[] } {
  return { windows: room.windows ?? [], doors: room.doors ?? [] }
}

/** The shape a Share link carries in the URL hash (same as store.ts shareUrl). */
interface Shared { room: Room; items: Item[]; s?: Partial<RoomDoc['settings']> }

export function decodeShareHash(hash: string): Shared | null {
  try {
    const h = hash.replace(/^#/, '')
    if (!h) return null
    const parsed = JSON.parse(decodeURIComponent(atob(h))) as Shared
    if (!parsed || !parsed.room || !Array.isArray(parsed.items)) return null
    return parsed
  } catch {
    return null
  }
}

/** Relative time for the library cards, e.g. "just now", "3 hours ago", "2 days ago". */
export function timeAgo(iso: string, from = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((from - t) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} hour${h === 1 ? '' : 's'} ago`
  const d = Math.round(h / 24)
  if (d < 30) return `${d} day${d === 1 ? '' : 's'} ago`
  const mo = Math.round(d / 30)
  if (mo < 12) return `${mo} month${mo === 1 ? '' : 's'} ago`
  const y = Math.round(d / 365)
  return `${y} year${y === 1 ? '' : 's'} ago`
}

/**
 * Nothing waiting to be saved is lost when the app goes away: the Mac app saves before it quits
 * (src/storage/quit.ts), the browser sends the last save as the page is left.
 */
function guardQuit(save: () => Promise<void>) {
  if (isTauri()) {
    import('./storage/quit').then((m) => m.saveBeforeQuit(save)).catch((err) => console.warn('Save-before-quit is not available', err))
  } else if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => { void save() })
  }
}

/** Back the rooms up before the app touches them; a failed backup is reported, never in the way. */
async function backupFirst() {
  try {
    const s = await storage()
    const name = await s.backup?.()
    if (name) console.info(`Rooms backed up to ${s.location}/Backups/${name}`)
  } catch (err) {
    console.warn('Could not back up the rooms', err)
  }
}

/* ---------- autosave plumbing (module-level, one open room at a time) ---------- */

/** Metadata of the open document; the planner store holds room/items/layouts/settings. */
let current: Omit<RoomDoc, 'room' | 'items' | 'layouts' | 'settings'> | null = null
let unsubscribe: (() => void) | null = null
let timer: ReturnType<typeof setTimeout> | null = null
/** bumps on every change; a save only reports "saved" if nothing changed meanwhile */
let changeSeq = 0
/** true from the first edit until a save of everything so far succeeds (a failed autosave keeps it set) */
let unsaved = false
let inFlight: Promise<void> | null = null
/** start() runs once even if React mounts the app twice (StrictMode) */
let started: Promise<void> | null = null
/** bumps on every open/create/close; an open whose token went stale while loading is dropped */
let openSeq = 0

function clearTimer() {
  if (timer) clearTimeout(timer)
  timer = null
}

function buildDoc(): RoomDoc | null {
  if (!current) return null
  return { ...current, ...useStore.getState().docState(), updatedAt: now() }
}

function errorText(e: unknown) {
  return e instanceof Error ? e.message : String(e)
}

export const useLibrary = create<LibraryState>((set, get) => {
  const setRooms = (rooms: RoomSummary[]) => set({ rooms, groups: groupsOf(rooms) })

  const patchSummary = (id: string, patch: Partial<RoomSummary>) =>
    setRooms(get().rooms.map((r) => (r.id === id ? { ...r, ...patch } : r)))

  const upsertSummary = (doc: RoomDoc) =>
    setRooms([...get().rooms.filter((r) => r.id !== doc.id), summarize(doc)])

  /** Save the open document right now. Serialised so two saves never overlap. */
  const flush = async (): Promise<void> => {
    clearTimer()
    if (inFlight) await inFlight
    const doc = buildDoc()
    if (!doc || !current) return
    const seq = changeSeq
    set({ status: 'saving', error: null })
    const p = (async () => {
      try {
        const s = await storage()
        await s.save(doc)
        if (current && current.id === doc.id) {
          current = { ...current, updatedAt: doc.updatedAt }
          upsertSummary(doc)
          if (changeSeq === seq) {
            unsaved = false
            set({ status: 'saved', error: null })
          }
        }
      } catch (e) {
        set({ status: 'error', error: `Could not save: ${errorText(e)}` })
      }
    })()
    inFlight = p
    await p
    if (inFlight === p) inFlight = null
  }

  /** true while a mouse button or finger is down anywhere in the page */
  let pointerDown = false
  const scheduleSave = () => {
    clearTimer()
    timer = setTimeout(() => { void flush() }, AUTOSAVE_MS)
  }
  const markDirty = () => {
    changeSeq += 1
    unsaved = true
    set({ status: 'dirty' })
    // mid-drag: written when the pointer is let go (below)
    if (!pointerDown) scheduleSave()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', () => { pointerDown = true }, true)
    const release = () => {
      pointerDown = false
      if (unsaved && !timer) scheduleSave()
    }
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    window.addEventListener('blur', release)
  }

  /** Write what is waiting to be saved, if anything (an untouched room is not written, so it stays untouched). */
  const savePending = async (): Promise<void> => {
    if (!current) return
    const st = get().status
    if (timer || unsaved || st === 'dirty' || st === 'saving') await flush()
    else if (inFlight) await inFlight
  }

  /**
   * Save whatever is pending and leave the open room. Returns false, with the room still open
   * and the error shown, when the pending edits could not be saved: nothing is ever discarded.
   */
  const closeCurrent = async (): Promise<boolean> => {
    if (!current) return true
    const st = get().status
    if (timer || unsaved || st === 'dirty' || st === 'saving') await flush()
    else if (inFlight) await inFlight
    if (unsaved && current) {
      // the retry failed too: keep the room open so the edits stay in the planner
      const why = get().error ?? 'Could not save'
      set({ status: 'error', error: `${why} — the room stays open so nothing is lost. Try again in a moment.` })
      return false
    }
    unsubscribe?.()
    unsubscribe = null
    clearTimer()
    current = null
    openSeq += 1
    set({ currentId: null, status: 'idle', error: null })
    return true
  }

  const watchPlanner = () => {
    unsubscribe?.()
    unsubscribe = useStore.subscribe((s, prev) => {
      if (
        s.room !== prev.room ||
        s.items !== prev.items ||
        s.savedLayouts !== prev.savedLayouts ||
        s.daytime !== prev.daytime ||
        s.doorAngle !== prev.doorAngle ||
        s.blinds !== prev.blinds ||
        s.bedding !== prev.bedding ||
        s.walkHeight !== prev.walkHeight ||
        s.quality !== prev.quality
      ) {
        markDirty()
      }
    })
  }

  const openDoc = (doc: RoomDoc) => {
    unsubscribe?.()
    unsubscribe = null
    clearTimer()
    const { room: _room, items: _items, layouts: _layouts, settings: _settings, ...meta } = doc
    current = meta
    unsaved = false
    openSeq += 1
    useStore.getState().hydrate(doc)
    watchPlanner()
    set({ currentId: doc.id, status: 'saved', error: null })
  }

  const loadDoc = async (id: string): Promise<RoomDoc | null> => {
    if (current && current.id === id) return buildDoc()
    const s = await storage()
    const raw = await s.load(id)
    return raw ? migrateDoc(raw) : null
  }

  /** A Share link in the URL becomes a document of its own, then the hash is cleared. */
  const openShared = async () => {
    if (typeof location === 'undefined') return
    const shared = decodeShareHash(location.hash)
    if (!shared) return
    const ts = now()
    const doc = migrateDoc({
      id: newId(),
      name: 'Shared room',
      group: 'Shared',
      createdAt: ts,
      updatedAt: ts,
      room: shared.room,
      items: shared.items,
      layouts: [],
      settings: shared.s ?? {},
    })
    if (!doc) return
    try {
      const s = await storage()
      await s.save(doc)
      upsertSummary(doc)
      if (typeof history !== 'undefined') history.replaceState(null, '', location.pathname + location.search)
      openDoc(doc)
    } catch (e) {
      set({ status: 'error', error: `Could not open the shared room: ${errorText(e)}` })
    }
  }

  return {
    rooms: [],
    groups: [],
    currentId: null,
    status: 'loading',
    error: null,
    location: '',

    configure: ({ storage: s }) => {
      storageOverride = s ?? null
    },

    start: () => {
      if (!started) {
        // a copy of every room first (when they changed since the last one), before anything is written
        started = backupFirst().then(() => get().refresh()).then(openShared)
        guardQuit(savePending)
      }
      return started
    },

    refresh: async () => {
      if (!get().currentId) set({ status: 'loading' })
      try {
        const s = await storage()
        let list = await s.list()
        if (await seedMissing(s, list)) list = await s.list()
        setRooms(list)
        set({ location: s.location, error: null, ...(get().currentId ? {} : { status: 'idle' as const }) })
      } catch (e) {
        set({ status: 'error', error: `Could not read the room list: ${errorText(e)}` })
      }
    },

    create: async (input) => {
      const name = input.name.trim() || 'Untitled room'
      const group = input.group?.trim() ?? ''
      const start: StartWith = input.start ?? (input.fromExample ? 'example' : 'basics')
      const doc = start === 'example' ? exampleDoc(name, group) : freshDoc({ ...input, name, group }, start)
      if (!(await closeCurrent())) return doc.id
      try {
        const s = await storage()
        await s.save(doc)
        upsertSummary(doc)
        openDoc(doc)
      } catch (e) {
        set({ status: 'error', error: `Could not create the room: ${errorText(e)}` })
      }
      return doc.id
    },

    open: async (id) => {
      if (get().currentId === id) return
      if (!(await closeCurrent())) return
      // two quick opens: only the latest one may land, whatever order the loads finish in
      const seq = ++openSeq
      set({ status: 'loading', error: null })
      try {
        const doc = await loadDoc(id)
        if (seq !== openSeq) return
        if (!doc) {
          set({ status: 'error', error: 'That room could not be found.' })
          await get().refresh()
          return
        }
        openDoc(doc)
      } catch (e) {
        if (seq !== openSeq) return
        set({ status: 'error', error: `Could not open the room: ${errorText(e)}` })
      }
    },

    close: async () => {
      if (!current) return
      if (!(await closeCurrent())) return
      await get().refresh()
    },

    duplicate: async (id) => {
      try {
        if (current && current.id === id) await flush()
        const src = await loadDoc(id)
        if (!src) return null
        const ts = now()
        const copy: RoomDoc = { ...src, id: newId(), name: `${src.name} (copy)`, createdAt: ts, updatedAt: ts }
        const s = await storage()
        await s.save(copy)
        upsertSummary(copy)
        return copy.id
      } catch (e) {
        set({ status: 'error', error: `Could not duplicate: ${errorText(e)}` })
        return null
      }
    },

    rename: async (id, name) => {
      const n = name.trim()
      if (!n) return
      if (current && current.id === id) {
        current = { ...current, name: n }
        patchSummary(id, { name: n })
        const st = useStore.getState()
        useStore.setState({ room: { ...st.room, name: n } })
        await flush()
        return
      }
      try {
        const doc = await loadDoc(id)
        if (!doc) return
        const next: RoomDoc = { ...doc, name: n, room: { ...doc.room, name: n }, updatedAt: now() }
        const s = await storage()
        await s.save(next)
        upsertSummary(next)
      } catch (e) {
        set({ status: 'error', error: `Could not rename: ${errorText(e)}` })
      }
    },

    setGroup: async (id, group) => {
      const g = group.trim()
      if (current && current.id === id) {
        current = { ...current, group: g }
        patchSummary(id, { group: g })
        await flush()
        return
      }
      try {
        const doc = await loadDoc(id)
        if (!doc) return
        const next: RoomDoc = { ...doc, group: g, updatedAt: now() }
        const s = await storage()
        await s.save(next)
        upsertSummary(next)
      } catch (e) {
        set({ status: 'error', error: `Could not move the room: ${errorText(e)}` })
      }
    },

    setNotes: async (id, notes) => {
      if (current && current.id === id) {
        current = { ...current, notes }
        await flush()
        return
      }
      try {
        const doc = await loadDoc(id)
        if (!doc) return
        const s = await storage()
        await s.save({ ...doc, notes, updatedAt: now() })
      } catch (e) {
        set({ status: 'error', error: `Could not save the notes: ${errorText(e)}` })
      }
    },

    remove: async (id) => {
      if (current && current.id === id) {
        unsubscribe?.()
        unsubscribe = null
        clearTimer()
        if (inFlight) await inFlight
        current = null
        unsaved = false
        openSeq += 1
        set({ currentId: null, status: 'idle' })
      }
      try {
        const s = await storage()
        await s.remove(id)
        setRooms(get().rooms.filter((r) => r.id !== id))
      } catch (e) {
        set({ status: 'error', error: `Could not delete: ${errorText(e)}` })
      }
    },

    exportDoc: async (id) => {
      try {
        if (current && current.id === id) await flush()
        const doc = await loadDoc(id)
        if (!doc) return
        const s = await storage()
        if (!s.exportDoc) {
          set({ error: 'Export is not available here.' })
          return
        }
        await s.exportDoc(doc)
      } catch (e) {
        set({ status: 'error', error: `Could not export: ${errorText(e)}` })
      }
    },

    importDoc: async () => {
      try {
        const s = await storage()
        if (!s.importDoc) {
          set({ error: 'Import is not available here.' })
          return null
        }
        const raw = await s.importDoc()
        if (raw === null) return null
        return await get().importRoom(raw)
      } catch (e) {
        set({ status: 'error', error: `Could not import: ${errorText(e)}` })
        return null
      }
    },

    importRoom: async (raw) => {
      try {
        const s = await storage()
        const doc = migrateDoc(raw)
        if (!doc) {
          set({ error: 'That file is not a Room Planner room.' })
          return null
        }
        // keep the id unless it collides with a room already in the library
        const taken = get().rooms.some((r) => r.id === doc.id) || (current && current.id === doc.id)
        const imported: RoomDoc = { ...doc, id: taken ? newId() : doc.id, updatedAt: now() }
        if (!(await closeCurrent())) return null
        await s.save(imported)
        upsertSummary(imported)
        openDoc(imported)
        return imported.id
      } catch (e) {
        set({ status: 'error', error: `Could not import: ${errorText(e)}` })
        return null
      }
    },

    saveNow: async () => {
      if (!current) return
      await flush()
    },

    copyItemToRoom: async (itemId, targetId, mode) => {
      const source = useStore.getState()
      const item = source.items.find((i) => i.id === itemId)
      if (!item) throw new Error('That item is no longer in this room.')
      // the open room is edited in the planner, never through storage; the UI does not offer it
      if (targetId === get().currentId) return { placed: false, targetName: current?.name ?? source.room.name }
      let target: RoomDoc | null
      try {
        target = await loadDoc(targetId)
      } catch (e) {
        throw new Error(`Could not open that room: ${errorText(e)}`)
      }
      if (!target) throw new Error('That room could not be found.')
      const clone = cloneInto(target, item)
      const placed = clearOfFurniture(target.room, target.items, clone)
      const items = placed ? [...target.items, clone] : park(target.room, [...target.items, { ...clone, inRoom: false }])
      const next: RoomDoc = { ...target, items, updatedAt: now() }
      try {
        const s = await storage()
        await s.save(next)
      } catch (e) {
        throw new Error(`Could not save ${target.name}: ${errorText(e)}`)
      }
      upsertSummary(next)
      if (mode === 'move') useStore.getState().removeItem(itemId)
      return placed
        ? { placed, targetName: target.name, where: describeSpot(target.room, clone) }
        : { placed, targetName: target.name }
    },
  }
})
