import { create } from 'zustand'
import { floorBounds } from './geometry'
import { HOUSE_VERSION, WALL_GAP, type HouseDoc, type HouseRoom } from './house'
import { libraryStorage, seedKey } from './library'
import { migrateDoc } from './migrate'
import type { RoomDoc } from './types'

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
}))
