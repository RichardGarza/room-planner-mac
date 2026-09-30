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
import { WALL_GAP, itemOnPlan, roomOnPlan, type HouseDoc, type HouseRoom } from '../house'
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

  it('moves, turns, adds and takes out rooms, saving each change straight away', async () => {
    const extra = { ...forestsRoom(), id: 'room-study', name: 'Study' }
    storage.docs.set(extra.id, extra)
    await useHouses.getState().refresh()
    await useHouses.getState().open(HOME_ID)
    const saved = () => storage.houses.get(HOME_ID)!

    await useHouses.getState().moveRoom('room-bedroom-2', 1000.4, 20.6)
    expect(saved().rooms[1]).toMatchObject({ roomId: 'room-bedroom-2', x: 1000, y: 21 })

    // a quarter turn about its middle: the middle stays put
    const middle = (p: HouseRoom) => { const b = polygonBounds(roomOnPlan(storage.docs.get(p.roomId)!.room, p)); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2] }
    const before = middle(saved().rooms[0])
    await useHouses.getState().turnRoom('room-forest')
    expect(saved().rooms[0].rot).toBe(90)
    const after = middle(saved().rooms[0])
    expect(after[0]).toBeCloseTo(before[0], -0.5)
    expect(after[1]).toBeCloseTo(before[1], -0.5)

    // added to the right of the house, a wall's thickness past it
    await useHouses.getState().addRoom('room-study')
    const study = saved().rooms.find((p) => p.roomId === 'room-study')!
    const others = saved().rooms.filter((p) => p.roomId !== 'room-study')
    const right = Math.max(...others.map((p) => polygonBounds(roomOnPlan(storage.docs.get(p.roomId)!.room, p)).x1))
    expect(polygonBounds(roomOnPlan(extra.room, study)).x0 - (right + 0)).toBeGreaterThanOrEqual(WALL_GAP - 1)
    expect(useHouses.getState().rooms['room-study']).toBeTruthy()

    // taken out of the house; the room itself stays
    await useHouses.getState().removeRoom('room-study')
    expect(saved().rooms.map((p) => p.roomId)).toEqual(['room-forest', 'room-bedroom-2'])
    expect(storage.docs.has('room-study')).toBe(true)
  })

  describe('moving furniture on the map', () => {
    const planOf = (roomId: string, itemId: string) => {
      const st = useHouses.getState()
      const house = st.houses.find((h) => h.id === HOME_ID)!
      const p = house.rooms.find((r) => r.roomId === roomId)!
      const item = st.rooms[roomId].items.find((i) => i.id === itemId)!
      return polygonBounds(itemOnPlan(item, p))
    }
    const middleOf = (b: { x0: number; y0: number; x1: number; y1: number }) => [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2]

    beforeEach(async () => {
      await useHouses.getState().refresh()
      await useHouses.getState().open(HOME_ID)
    })

    it('moves a piece into another room, keeping how it looks on the plan, and saves the new room first', async () => {
      const order: string[] = []
      const save = storage.save.bind(storage)
      storage.save = async (d) => { order.push(d.id); await save(d) }
      const before = planOf('room-forest', 'forest-dresser')
      // into the middle of Bedroom 2
      const house = useHouses.getState().houses[0]
      const b2 = house.rooms[1]
      const b2box = polygonBounds(roomOnPlan(storage.docs.get('room-bedroom-2')!.room, b2))
      const [mx, my] = middleOf(b2box)
      const landed = await useHouses.getState().moveItem('room-forest', 'forest-dresser', mx, my)
      expect(landed).toBe('room-bedroom-2')
      expect(order).toEqual(['room-bedroom-2', 'room-forest'])
      expect(storage.docs.get('room-forest')!.items.some((i) => i.id === 'forest-dresser')).toBe(false)
      const after = planOf('room-bedroom-2', 'forest-dresser')
      // same size and turn on the plan, now centred where it was dropped
      expect(after.x1 - after.x0).toBeCloseTo(before.x1 - before.x0, 0)
      expect(after.y1 - after.y0).toBeCloseTo(before.y1 - before.y0, 0)
      expect(middleOf(after)[0]).toBeCloseTo(mx, -0.5)
      expect(middleOf(after)[1]).toBeCloseTo(my, -0.5)
    })

    it('moves a piece within its own room', async () => {
      const house = useHouses.getState().houses[0]
      const box = polygonBounds(roomOnPlan(storage.docs.get('room-forest')!.room, house.rooms[0]))
      const x = box.x0 + 150, y = box.y0 + 150
      expect(await useHouses.getState().moveItem('room-forest', 'forest-side', x, y)).toBe('room-forest')
      const side = storage.docs.get('room-forest')!.items.find((i) => i.id === 'forest-side')!
      expect(side.x).toBe(Math.round(x - house.rooms[0].x))
      expect(side.y).toBe(Math.round(y - house.rooms[0].y))
    })

    it('leaves a piece where it is when dropped outside every room, or when it is locked', async () => {
      const before = JSON.stringify(storage.docs.get('room-forest'))
      expect(await useHouses.getState().moveItem('room-forest', 'forest-dresser', -5000, -5000)).toBeNull()
      const forest = storage.docs.get('room-forest')!
      storage.docs.set('room-forest', { ...forest, items: forest.items.map((i) => (i.id === 'forest-dresser' ? { ...i, locked: true } : i)) })
      await useHouses.getState().open(HOME_ID)
      const house = useHouses.getState().houses[0]
      const [mx, my] = middleOf(polygonBounds(roomOnPlan(storage.docs.get('room-bedroom-2')!.room, house.rooms[1])))
      expect(await useHouses.getState().moveItem('room-forest', 'forest-dresser', mx, my)).toBeNull()
      expect(JSON.parse(before).items.length).toBe(storage.docs.get('room-forest')!.items.length)
    })

    it('gives a piece a fresh id when the other room already has one like it', async () => {
      const b2 = storage.docs.get('room-bedroom-2')!
      storage.docs.set('room-bedroom-2', { ...b2, items: [...b2.items, { ...b2.items[0], id: 'forest-side', inRoom: false }] })
      await useHouses.getState().open(HOME_ID)
      const house = useHouses.getState().houses[0]
      const [mx, my] = middleOf(polygonBounds(roomOnPlan(storage.docs.get('room-bedroom-2')!.room, house.rooms[1])))
      await useHouses.getState().moveItem('room-forest', 'forest-side', mx, my)
      const ids = storage.docs.get('room-bedroom-2')!.items.map((i) => i.id)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.filter((i) => i.startsWith('nightstand-'))).toHaveLength(1)
    })
  })
})
