import { create } from 'zustand'
import { floorBounds, normalizeRot, polygonBounds } from './geometry'
import { HOUSE_VERSION, WALL_GAP, houseBounds, levelOf, migrateHouse, onLevel, roomAt, roomOnPlan, toRoom, type HouseDoc, type HouseRoom, type QuarterTurn } from './house'
import { makeEmptyRoom } from './data'
import { libraryStorage, newId, seedKey, useLibrary } from './library'
import { migrateDoc } from './migrate'
import { resizeRoom as resize } from './resize'
import type { Item, Room, RoomDoc, Wall } from './types'

/*
 * The houses in the library and the one on screen (the house map). A house only places rooms; the
 * rooms themselves are loaded from their own files each time the map opens, so what the map shows
 * is always what was last saved in the planner. See docs/HOUSE_ROADMAP.md.
 */

/** The house every library starts with: Forest's Room and Bedroom 2 side by side. */
export const HOME_ID = 'house-home'
const HOME_ROOMS = ['room-forest', 'room-bedroom-2']

interface HousesState {
  houses: HouseDoc[]
  /** the house on screen (the map), or null; kept while a room of it is open, so "House" goes back */
  currentId: string | null
  /** the current house's rooms, by id, as last saved (a room whose file is gone is missing here) */
  rooms: Record<string, RoomDoc>
  status: 'idle' | 'loading' | 'error'
  error: string | null
  /** List the houses, adding "Home" the first time (never again once it has been added, even if deleted). */
  refresh: () => Promise<void>
  /** Show a house on the map, loading its rooms. */
  open: (id: string) => Promise<void>
  /** Leave the house map for the library. */
  close: () => void
  /** Arranging the current house (each saved straight away): */
  moveRoom: (roomId: string, x: number, y: number) => Promise<void>
  /** a quarter turn clockwise, about the room's middle so it turns in place */
  turnRoom: (roomId: string) => Promise<void>
  /** a room from the library, placed to the right of the rooms on that floor (the ground floor by default) */
  addRoom: (roomId: string, level?: number) => Promise<void>
  /** move a room to another floor, where it stands on the plan */
  setLevel: (roomId: string, level: number) => Promise<void>
  /**
   * Move one wall of a plain room out by `amount` cm (in when negative; see src/resize.ts): the
   * room's file (its size, and its contents shifted when the back or left wall moves) is saved,
   * then its place in the house. Everything but that wall stays where it is on the plan.
   */
  resizeRoom: (roomId: string, side: Wall, amount: number) => Promise<void>
  /** take a room out of the house (the room itself stays in the library) */
  removeRoom: (roomId: string) => Promise<void>
  /**
   * Move a piece of furniture on the house plan: its middle to house point (x, y), turned `turn`
   * degrees more (clockwise). Dropped in its own room it just moves; dropped in another room it moves
   * into that room's file (written there before it leaves the first, so a failed save can only ever
   * leave two, never none). Outside every room nothing changes. Returns the room it ended up in and
   * its id there (new when that room already had one like it), or null.
   */
  moveItem: (fromRoomId: string, itemId: string, x: number, y: number, turn?: number) => Promise<{ roomId: string; itemId: string } | null>
  /**
   * A new empty room for a hallway or an open area (120 × 300 cm, one door, no window), saved with
   * the other rooms and added to the house; returns its id.
   */
  addHallway: (level?: number) => Promise<string | null>
  /** Save a house and all its rooms (layouts included) as one file, through the save dialog / a download. */
  exportHouse: (id: string) => Promise<void>
  /**
   * Add a house from an exported file: its rooms join the library (as copies with new ids when one
   * with the same id is already there, so nothing is ever overwritten) and the house points at them.
   * Returns the new house's id, or null when the file is not a house.
   */
  importHouse: (raw: unknown) => Promise<string | null>
}

/** What an exported house file holds. */
export interface HouseBundle {
  kind: typeof BUNDLE_KIND
  version: 1
  house: HouseDoc
  rooms: RoomDoc[]
}
export const BUNDLE_KIND = 'room-planner-house'

export function isHouseBundle(raw: unknown): raw is HouseBundle {
  return !!raw && typeof raw === 'object' && (raw as { kind?: unknown }).kind === BUNDLE_KIND
}

function flagGet(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}
function flagSet(key: string) {
  try { localStorage.setItem(key, '1') } catch { /* private mode: the shared record still holds it */ }
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * "Home" with the seed rooms that are in the library, left to right in that order, each a wall's
 * thickness past the last one's floor (closets included), tops lined up.
 */
async function homeHouse(load: (id: string) => Promise<RoomDoc | null>): Promise<HouseDoc | null> {
  const placed: HouseRoom[] = []
  let x = 0
  for (const id of HOME_ROOMS) {
    const doc = await load(id)
    if (!doc) continue
    const b = floorBounds(doc.room)
    placed.push({ roomId: id, x: x - b.x0, y: -b.y0, rot: 0 })
    x += b.x1 - b.x0 + WALL_GAP
  }
  if (!placed.length) return null
  const ts = new Date().toISOString()
  return { id: HOME_ID, name: 'Home', createdAt: ts, updatedAt: ts, version: HOUSE_VERSION, rooms: placed }
}

/** the refresh under way, if any: a second call waits for it instead of running alongside (and seeding "Home" twice) */
let refreshing: Promise<void> | null = null

/** List the houses and add "Home" the first time (see HousesState.refresh). */
async function doRefresh(): Promise<void> {
  const set = useHouses.setState
  try {
    const s = await libraryStorage()
    if (!s.listHouses || !s.saveHouse) return set({ houses: [] })
    let houses = await s.listHouses()
    const shared = new Set(s.seededIds ? await s.seededIds().catch(() => []) : [])
    if (!houses.some((h) => h.id === HOME_ID) && !shared.has(HOME_ID) && !flagGet(seedKey(HOME_ID))) {
      const load = async (id: string) => { const raw = await s.load(id); return raw ? migrateDoc(raw) : null }
      const home = await homeHouse(load)
      if (home) {
        await s.saveHouse(home)
        houses = [...houses, home]
        flagSet(seedKey(HOME_ID))
        await s.markSeeded?.([HOME_ID]).catch((err: unknown) => console.warn('Could not record the seeded house', err))
      }
    }
    set({ houses: houses.sort((a, b) => a.name.localeCompare(b.name)), error: null })
  } catch (e) {
    set({ status: 'error', error: `Could not read the houses: ${errorText(e)}` })
  }
}

export const useHouses = create<HousesState>((set, get) => ({
  houses: [],
  currentId: null,
  rooms: {},
  status: 'idle',
  error: null,

  refresh: () => {
    refreshing ??= doRefresh().finally(() => { refreshing = null })
    return refreshing
  },

  open: async (id) => {
    set({ currentId: id, status: 'loading', error: null })
    try {
      const s = await libraryStorage()
      const house = get().houses.find((h) => h.id === id)
      if (!house) throw new Error('That house could not be found.')
      const rooms: Record<string, RoomDoc> = {}
      for (const p of house.rooms) {
        const raw = await s.load(p.roomId).catch(() => null)
        const doc = raw ? migrateDoc(raw) : null
        if (doc) rooms[p.roomId] = doc
      }
      if (get().currentId === id) set({ rooms, status: 'idle' })
    } catch (e) {
      set({ status: 'error', error: `Could not open the house: ${errorText(e)}` })
    }
  },

  close: () => set({ currentId: null, rooms: {}, status: 'idle', error: null }),

  moveRoom: (roomId, x, y) => update((h) => ({ ...h, rooms: h.rooms.map((p) => (p.roomId === roomId ? { ...p, x: Math.round(x), y: Math.round(y) } : p)) })),

  turnRoom: (roomId) => update((h) => ({
    ...h,
    rooms: h.rooms.map((p) => {
      const doc = get().rooms[roomId]
      if (p.roomId !== roomId || !doc) return p
      const middle = (q: HouseRoom) => { const b = polygonBounds(roomOnPlan(doc.room, q)); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] }
      const [cx, cy] = middle(p)
      const rot = ((p.rot + 90) % 360) as QuarterTurn
      const [nx, ny] = middle({ ...p, x: 0, y: 0, rot })
      return { ...p, x: Math.round(cx - nx), y: Math.round(cy - ny), rot }
    }),
  })),

  addRoom: async (roomId, level = 0) => {
    const house = currentHouse()
    if (!house || house.rooms.some((p) => p.roomId === roomId)) return
    const s = await libraryStorage()
    const raw = await s.load(roomId).catch(() => null)
    const doc = raw ? migrateDoc(raw) : null
    if (!doc) return set({ error: 'That room could not be found.' })
    set({ rooms: { ...get().rooms, [roomId]: doc } })
    // to the right of everything already on that floor, tops lined up
    const b = houseBounds(onLevel(house, level), new Map(Object.entries(get().rooms).map(([id, d]) => [id, d.room] as [string, Room])))
    const f = floorBounds(doc.room)
    const x = b ? b.x1 + WALL_GAP - f.x0 : -f.x0
    const y = b ? b.y0 - f.y0 : -f.y0
    const place: HouseRoom = { roomId, x: Math.round(x), y: Math.round(y), rot: 0 }
    await update((h) => ({ ...h, rooms: [...h.rooms, level ? { ...place, level } : place] }))
  },

  setLevel: (roomId, level) => update((h) => ({
    ...h,
    rooms: h.rooms.map((p) => {
      if (p.roomId !== roomId) return p
      const { level: _old, ...rest } = p
      return level ? { ...rest, level } : rest
    }),
  })),

  resizeRoom: async (roomId, side, amount) => {
    const house = currentHouse()
    const doc = get().rooms[roomId]
    const place = house?.rooms.find((p) => p.roomId === roomId)
    if (!house || !doc || !place) return
    const r = resize(doc, place, side, amount)
    if (!r.amount) return
    const next: RoomDoc = { ...r.doc, updatedAt: new Date().toISOString() }
    try {
      const s = await libraryStorage()
      await s.save(next)
    } catch (e) {
      set({ status: 'error', error: `Could not resize ${doc.name}: ${errorText(e)}` })
      return
    }
    set({ rooms: { ...get().rooms, [roomId]: next } })
    if (r.place.x !== place.x || r.place.y !== place.y) {
      await update((h) => ({ ...h, rooms: h.rooms.map((p) => (p.roomId === roomId ? { ...p, x: r.place.x, y: r.place.y } : p)) }))
    }
    void useLibrary.getState().refresh()
  },

  moveItem: async (fromRoomId, itemId, x, y, turn = 0) => {
    const house = currentHouse()
    const docs = get().rooms
    const from = docs[fromRoomId]
    const fromPlace = house?.rooms.find((p) => p.roomId === fromRoomId)
    const item = from?.items.find((i) => i.id === itemId)
    if (!house || !from || !fromPlace || !item || item.locked) return null
    const roomMap = new Map(Object.entries(docs).map(([id, d]) => [id, d.room] as [string, Room]))
    // a piece stays on its floor
    const target = roomAt(onLevel(house, levelOf(fromPlace)), roomMap, [x, y])
    if (!target) return null
    const to = docs[target.roomId]
    // the same spot and angle on the plan, in the target room's own coordinates
    const [lx, ly] = toRoom(target, [x, y])
    const rot = normalizeRot(item.rot + fromPlace.rot - target.rot + turn)
    const s = await libraryStorage()
    const ts = new Date().toISOString()
    let landedId = itemId
    try {
      if (target.roomId === fromRoomId) {
        const next: RoomDoc = { ...from, updatedAt: ts, items: from.items.map((i) => (i.id === itemId ? { ...i, x: Math.round(lx), y: Math.round(ly), rot } : i)) }
        await s.save(next)
        set({ rooms: { ...get().rooms, [fromRoomId]: next } })
      } else {
        // a fresh id when the target room already has one like it
        const taken = new Set(to.items.map((i) => i.id))
        let id = item.id
        while (taken.has(id)) id = `${item.kind}-${Math.random().toString(36).slice(2, 8)}`
        landedId = id
        const moved: Item = { ...item, id, x: Math.round(lx), y: Math.round(ly), rot, inRoom: true }
        const nextTo: RoomDoc = { ...to, updatedAt: ts, items: [...to.items, moved] }
        const nextFrom: RoomDoc = { ...from, updatedAt: ts, items: from.items.filter((i) => i.id !== itemId) }
        await s.save(nextTo)
        await s.save(nextFrom)
        set({ rooms: { ...get().rooms, [target.roomId]: nextTo, [fromRoomId]: nextFrom } })
      }
    } catch (e) {
      set({ status: 'error', error: `Could not move the ${item.name.toLowerCase()}: ${errorText(e)}` })
      return null
    }
    void useLibrary.getState().refresh()
    return { roomId: target.roomId, itemId: landedId }
  },

  addHallway: async (level = 0) => {
    const house = currentHouse()
    if (!house) return null
    const taken = new Set(useLibrary.getState().rooms.map((r) => r.name))
    let name = 'Hallway'
    for (let i = 2; taken.has(name); i++) name = `Hallway ${i}`
    const ts = new Date().toISOString()
    const shell = makeEmptyRoom(name, 120, 300)
    const doc = migrateDoc({
      id: newId(), name, group: house.name, notes: 'A hallway or open area of the house: add its doors where the rooms meet it.',
      createdAt: ts, updatedAt: ts, items: [], layouts: [],
      room: { ...shell, windows: [], doors: shell.doors.map((d) => ({ ...d, offset: 20 })) },
    })
    if (!doc) return null
    try {
      const s = await libraryStorage()
      await s.save(doc)
    } catch (e) {
      set({ status: 'error', error: `Could not make the hallway: ${errorText(e)}` })
      return null
    }
    await useLibrary.getState().refresh()
    await get().addRoom(doc.id, level)
    return doc.id
  },

  exportHouse: async (id) => {
    const house = get().houses.find((h) => h.id === id)
    if (!house) return
    try {
      const s = await libraryStorage()
      const rooms: RoomDoc[] = []
      for (const p of house.rooms) {
        const raw = await s.load(p.roomId).catch(() => null)
        const doc = raw ? migrateDoc(raw) : null
        if (doc) rooms.push(doc)
      }
      const bundle: HouseBundle = { kind: BUNDLE_KIND, version: 1, house, rooms }
      const name = `${house.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'house'}.house.json`
      if (!s.saveFile) throw new Error('saving files is not available here')
      await s.saveFile(name, new TextEncoder().encode(JSON.stringify(bundle, null, 2)), 'application/json')
    } catch (e) {
      set({ status: 'error', error: `Could not export the house: ${errorText(e)}` })
    }
  },

  importHouse: async (raw) => {
    if (!isHouseBundle(raw)) return null
    const house = migrateHouse(raw.house)
    if (!house || !Array.isArray(raw.rooms)) return null
    try {
      const s = await libraryStorage()
      const have = new Set((await s.list()).map((r) => r.id))
      const ids = new Map<string, string>()
      const ts = new Date().toISOString()
      for (const r of raw.rooms) {
        const doc = migrateDoc(r)
        if (!doc) continue
        const id = have.has(doc.id) ? newId() : doc.id
        ids.set(doc.id, id)
        have.add(id)
        await s.save({ ...doc, id, updatedAt: ts })
      }
      const houses = s.listHouses ? await s.listHouses() : []
      const taken = houses.some((h) => h.id === house.id)
      const names = new Set(houses.map((h) => h.name))
      let name = house.name
      for (let i = 2; names.has(name); i++) name = `${house.name} (${i})`
      const next: HouseDoc = {
        ...house,
        id: taken ? `house-${Math.random().toString(36).slice(2, 10)}` : house.id,
        name,
        createdAt: ts,
        updatedAt: ts,
        rooms: house.rooms.filter((p) => ids.has(p.roomId)).map((p) => ({ ...p, roomId: ids.get(p.roomId)! })),
      }
      await s.saveHouse?.(next)
      await useLibrary.getState().refresh()
      await get().refresh()
      return next.id
    } catch (e) {
      set({ status: 'error', error: `Could not import the house: ${errorText(e)}` })
      return null
    }
  },

  removeRoom: async (roomId) => {
    const { [roomId]: _gone, ...rest } = get().rooms
    set({ rooms: rest })
    await update((h) => ({ ...h, rooms: h.rooms.filter((p) => p.roomId !== roomId) }))
  },
}))

function currentHouse(): HouseDoc | undefined {
  const st = useHouses.getState()
  return st.houses.find((h) => h.id === st.currentId)
}

/** Change the house on screen and save it straight away (a failed save is shown, the change kept on screen). */
async function update(change: (h: HouseDoc) => HouseDoc) {
  const house = currentHouse()
  if (!house) return
  const next: HouseDoc = { ...change(house), updatedAt: new Date().toISOString() }
  useHouses.setState((st) => ({ houses: st.houses.map((h) => (h.id === next.id ? next : h)) }))
  try {
    const s = await libraryStorage()
    await s.saveHouse?.(next)
  } catch (e) {
    useHouses.setState({ status: 'error', error: `Could not save the house: ${errorText(e)}` })
  }
}
