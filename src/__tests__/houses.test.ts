import { beforeEach, describe, expect, it } from 'vitest'

class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage()

import { floorBounds } from '../geometry'
import { WALL_GAP, roomOnPlan, type HouseDoc } from '../house'
import { HOME_ID, useHouses } from '../houses'
import { useLibrary } from '../library'
import { bedroomTwo, forestsRoom } from '../seeds'
import { summarize, type RoomStorage } from '../storage/types'
import type { RoomDoc } from '../types'
import { polygonBounds } from '../geometry'

class FakeStorage implements RoomStorage {
  readonly location = 'a test'
  docs = new Map<string, RoomDoc>()
  houses = new Map<string, HouseDoc>()
  seeded = new Set<string>()
  async list() { return [...this.docs.values()].map(summarize) }
  async load(id: string) { return this.docs.get(id) ?? null }
  async save(doc: RoomDoc) { this.docs.set(doc.id, doc) }
  async remove(id: string) { this.docs.delete(id) }
  async listHouses() { return [...this.houses.values()] }
  async saveHouse(h: HouseDoc) { this.houses.set(h.id, h) }
  async removeHouse(id: string) { this.houses.delete(id) }
  async seededIds() { return [...this.seeded] }
  async markSeeded(ids: string[]) { ids.forEach((i) => this.seeded.add(i)) }
}

let storage: FakeStorage
beforeEach(() => {
  localStorage.clear()
  storage = new FakeStorage()
  for (const d of [forestsRoom(), bedroomTwo()]) storage.docs.set(d.id, d)
  useLibrary.getState().configure({ storage })
  useHouses.setState({ houses: [], currentId: null, rooms: {}, status: 'idle', error: null })
})

describe('houses', () => {
  it('adds "Home" once, with Forest\'s Room and Bedroom 2 side by side and not overlapping', async () => {
    await useHouses.getState().refresh()
    const home = useHouses.getState().houses.find((h) => h.id === HOME_ID)!
    expect(home.name).toBe('Home')
    expect(home.rooms.map((r) => r.roomId)).toEqual(['room-forest', 'room-bedroom-2'])
    // a wall's thickness apart, closets included, tops lined up
    const [a, b] = home.rooms.map((p) => polygonBounds(roomOnPlan(storage.docs.get(p.roomId)!.room, p)))
    const forestFloor = floorBounds(forestsRoom().room)
    expect(b.x0 - (home.rooms[0].x + forestFloor.x1)).toBeCloseTo(WALL_GAP)
    expect(a.y0).toBe(0)
    expect(b.y0).toBeCloseTo(-floorBounds(bedroomTwo().room).y0)
    expect(storage.seeded.has(HOME_ID)).toBe(true)

    // not again
    await useHouses.getState().refresh()
    expect(storage.houses.size).toBe(1)
  })

  it('never brings a deleted "Home" back, even in a fresh copy of the app', async () => {
    await useHouses.getState().refresh()
    storage.houses.clear()
    localStorage.clear()
    await useHouses.getState().refresh()
    expect(useHouses.getState().houses).toEqual([])
  })

  it('opens a house with its rooms as saved, and skips a room whose file is gone', async () => {
    await useHouses.getState().refresh()
    storage.docs.delete('room-forest')
    await useHouses.getState().open(HOME_ID)
    const st = useHouses.getState()
    expect(st.currentId).toBe(HOME_ID)
    expect(Object.keys(st.rooms)).toEqual(['room-bedroom-2'])
    st.close()
    expect(useHouses.getState().currentId).toBeNull()
  })

  it('makes no "Home" when neither room is in the library', async () => {
    storage.docs.clear()
    await useHouses.getState().refresh()
    expect(useHouses.getState().houses).toEqual([])
    expect(storage.seeded.has(HOME_ID)).toBe(false)
  })

  it('adds "Home" once even when two refreshes start together (the app starts twice in development)', async () => {
    let saves = 0
    const save = storage.saveHouse.bind(storage)
    storage.saveHouse = async (h) => { saves += 1; await save(h) }
    await Promise.all([useHouses.getState().refresh(), useHouses.getState().refresh()])
    expect(saves).toBe(1)
    expect(useHouses.getState().houses.map((h) => h.id)).toEqual([HOME_ID])
  })
})
