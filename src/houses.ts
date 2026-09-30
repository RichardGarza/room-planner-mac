import { create } from 'zustand'
import { floorBounds, normalizeRot, polygonBounds } from './geometry'
import { HOUSE_VERSION, WALL_GAP, houseBounds, roomAt, roomOnPlan, toRoom, type HouseDoc, type HouseRoom, type QuarterTurn } from './house'
import { libraryStorage, seedKey, useLibrary } from './library'
import { migrateDoc } from './migrate'
import type { Item, Room, RoomDoc } from './types'

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
  /** a room from the library, placed to the right of the house */
  addRoom: (roomId: string) => Promise<void>
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

  addRoom: async (roomId) => {
    const house = currentHouse()
    if (!house || house.rooms.some((p) => p.roomId === roomId)) return
    const s = await libraryStorage()
    const raw = await s.load(roomId).catch(() => null)
    const doc = raw ? migrateDoc(raw) : null
    if (!doc) return set({ error: 'That room could not be found.' })
    set({ rooms: { ...get().rooms, [roomId]: doc } })
    // to the right of everything already there, tops lined up
    const b = houseBounds(house, new Map(Object.entries(get().rooms).map(([id, d]) => [id, d.room] as [string, Room])))
    const f = floorBounds(doc.room)
    const x = b ? b.x1 + WALL_GAP - f.x0 : -f.x0
    const y = b ? b.y0 - f.y0 : -f.y0
    await update((h) => ({ ...h, rooms: [...h.rooms, { roomId, x: Math.round(x), y: Math.round(y), rot: 0 }] }))
  },

  moveItem: async (fromRoomId, itemId, x, y, turn = 0) => {
    const house = currentHouse()
    const docs = get().rooms
    const from = docs[fromRoomId]
    const fromPlace = house?.rooms.find((p) => p.roomId === fromRoomId)
    const item = from?.items.find((i) => i.id === itemId)
    if (!house || !from || !fromPlace || !item || item.locked) return null
    const roomMap = new Map(Object.entries(docs).map(([id, d]) => [id, d.room] as [string, Room]))
    const target = roomAt(house, roomMap, [x, y])
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
