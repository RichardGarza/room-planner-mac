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
      expect(landed).toEqual({ roomId: 'room-bedroom-2', itemId: 'forest-dresser' })
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
      expect(await useHouses.getState().moveItem('room-forest', 'forest-side', x, y)).toEqual({ roomId: 'room-forest', itemId: 'forest-side' })
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
      const landed = await useHouses.getState().moveItem('room-forest', 'forest-side', mx, my)
      const ids = storage.docs.get('room-bedroom-2')!.items.map((i) => i.id)
      expect(landed?.itemId).toMatch(/^nightstand-/)
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids.filter((i) => i.startsWith('nightstand-'))).toHaveLength(1)
    })
  })

  it('walks through a connected door into the next room, just inside its door, facing in', async () => {
    const { walkThrough, connectedDoors } = await import('../walkThrough')
    const { useStore } = await import('../store')
    const { makeEmptyRoom } = await import('../data')
    const { migrateDoc } = await import('../migrate')
    const doc = (id: string, w: number, d: number, door: RoomDoc['room']['doors'][number]): RoomDoc => migrateDoc({
      id, name: id, group: '', notes: '', createdAt: '', updatedAt: '', items: [], layouts: [],
      room: { ...makeEmptyRoom(id, w, d), windows: [], doors: [door] },
    })!
    storage.docs.set('room-a', doc('room-a', 300, 400, { id: 'd1', wall: 'right', offset: 50, width: 80, height: 205, sill: 0, hinge: 'left', swing: 'in' }))
    storage.docs.set('room-b', doc('room-b', 200, 200, { id: 'd9', wall: 'left', offset: 50, width: 80, height: 205, sill: 0, hinge: 'left', swing: 'in' }))
    storage.houses.set('house-2', { id: 'house-2', name: 'Flat', createdAt: '', updatedAt: '', version: 1, rooms: [{ roomId: 'room-a', x: 0, y: 0, rot: 0 }, { roomId: 'room-b', x: 300 + WALL_GAP, y: 0, rot: 0 }] })
    await useHouses.getState().refresh()
    await useHouses.getState().open('house-2')
    await useLibrary.getState().refresh()
    await useLibrary.getState().open('room-a')
    expect(connectedDoors('room-a')).toEqual([{ doorId: 'd1', to: { roomId: 'room-b', doorId: 'd9' } }])
    expect(await walkThrough('room-a', 'd1')).toBe(true)
    expect(useLibrary.getState().currentId).toBe('room-b')
    const st = useStore.getState()
    expect(st.view).toBe('walk')
    // 45 cm in from the left wall, in the middle of the door, looking into the room (toward +x)
    expect(st.walkPose.x).toBe(45)
    expect(st.walkPose.y).toBe(90)
    expect(-Math.sin(st.walkPose.yaw)).toBeCloseTo(1)
    await useLibrary.getState().close()
  })

  it('adds a hallway: a new empty room, saved with the others and placed in the house', async () => {
    await useHouses.getState().refresh()
    await useHouses.getState().open(HOME_ID)
    const id = (await useHouses.getState().addHallway())!
    const doc = storage.docs.get(id)!
    expect(doc.name).toBe('Hallway')
    expect(doc.items).toEqual([])
    expect(doc.room.windows).toEqual([])
    expect(doc.room.doors).toHaveLength(1)
    expect(storage.houses.get(HOME_ID)!.rooms.map((p) => p.roomId)).toContain(id)
    // a second one gets its own name
    const id2 = (await useHouses.getState().addHallway())!
    expect(storage.docs.get(id2)!.name).toBe('Hallway 2')
  })

  it('exports a house with its rooms, and imports it without overwriting anything', async () => {
    let file: { name: string; text: string } | null = null
    ;(storage as unknown as { saveFile: RoomStorage['saveFile'] }).saveFile = async (name, data) => { file = { name, text: new TextDecoder().decode(data) } }
    await useHouses.getState().refresh()
    await useHouses.getState().exportHouse(HOME_ID)
    expect(file!.name).toBe('home.house.json')
    const bundle = JSON.parse(file!.text)
    expect(bundle.kind).toBe('room-planner-house')
    expect(bundle.rooms.map((r: RoomDoc) => r.id)).toEqual(['room-forest', 'room-bedroom-2'])

    // into the same library: the rooms come in as copies, the house as "Home (2)"
    const before = JSON.stringify([...storage.docs.values()])
    const id = (await useHouses.getState().importHouse(bundle))!
    const imported = storage.houses.get(id)!
    expect(imported.name).toBe('Home (2)')
    expect(imported.id).not.toBe(HOME_ID)
    expect(imported.rooms.map((p) => p.roomId).some((r) => r === 'room-forest' || r === 'room-bedroom-2')).toBe(false)
    for (const p of imported.rooms) expect(storage.docs.has(p.roomId)).toBe(true)
    // the originals are untouched
    expect(JSON.stringify([...storage.docs.values()].filter((d) => d.id === 'room-forest' || d.id === 'room-bedroom-2'))).toBe(JSON.stringify(JSON.parse(before)))
    // layouts travel with the rooms
    const copy = storage.docs.get(imported.rooms[0].roomId)!
    expect(copy.layouts).toEqual(storage.docs.get('room-forest')!.layouts)

    // into an empty library the ids are kept
    const empty = new FakeStorage()
    useLibrary.getState().configure({ storage: empty })
    const id2 = (await useHouses.getState().importHouse(bundle))!
    expect(id2).toBe(HOME_ID)
    expect([...empty.docs.keys()]).toEqual(['room-forest', 'room-bedroom-2'])
    expect(await useHouses.getState().importHouse({ kind: 'something else' })).toBeNull()
  })

  it('moves rooms between floors, adds rooms to a floor, and keeps furniture on its floor', async () => {
    const extra = { ...forestsRoom(), id: 'room-attic', name: 'Attic' }
    storage.docs.set(extra.id, extra)
    await useHouses.getState().refresh()
    await useHouses.getState().open(HOME_ID)
    await useHouses.getState().setLevel('room-bedroom-2', 1)
    expect(storage.houses.get(HOME_ID)!.rooms[1].level).toBe(1)
    // added to the first floor, it goes beside the rooms there, not beside the ground floor's
    await useHouses.getState().addRoom('room-attic', 1)
    const attic = storage.houses.get(HOME_ID)!.rooms.find((p) => p.roomId === 'room-attic')!
    expect(attic.level).toBe(1)
    const b2 = storage.houses.get(HOME_ID)!.rooms[1]
    expect(polygonBounds(roomOnPlan(extra.room, attic)).x0).toBeGreaterThan(polygonBounds(roomOnPlan(storage.docs.get('room-bedroom-2')!.room, b2)).x1)
    // a piece dropped where only a room on another floor is: it stays put
    const onB2 = polygonBounds(roomOnPlan(storage.docs.get('room-bedroom-2')!.room, b2))
    const forest = storage.houses.get(HOME_ID)!.rooms[0]
    const forestBox = polygonBounds(roomOnPlan(storage.docs.get('room-forest')!.room, forest))
    const clear = [onB2.x1 - 20, onB2.y0 + 20] as const
    const overForest = clear[0] > forestBox.x0 && clear[0] < forestBox.x1 && clear[1] > forestBox.y0 && clear[1] < forestBox.y1
    if (!overForest) expect(await useHouses.getState().moveItem('room-forest', 'forest-side', clear[0], clear[1])).toBeNull()
    // back to the ground floor
    await useHouses.getState().setLevel('room-bedroom-2', 0)
    expect(storage.houses.get(HOME_ID)!.rooms[1].level).toBeUndefined()
  })
})
