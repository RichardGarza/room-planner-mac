import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/* A tiny localStorage so the seed flag and store code that touches it work in node. */
class MemoryStorage {
  private m = new Map<string, string>()
  get length() { return this.m.size }
  clear() { this.m.clear() }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null }
  setItem(k: string, v: string) { this.m.set(k, String(v)) }
  removeItem(k: string) { this.m.delete(k) }
  key(i: number) { return [...this.m.keys()][i] ?? null }
}
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage()

import { AUTOSAVE_MS, EXAMPLE_ID, SEEDED_KEY, defaultRoomSize, roomOpenings, seedKey, timeAgo, useLibrary, type CreateInput } from '../library'
import { PARK_Y, useStore } from '../store'
import { bedroomTwo, forestsRoom } from '../seeds'
import { findFreeSpot } from '../placement'
import { summarize, type RoomStorage } from '../storage/types'
import { DOC_VERSION } from '../migrate'
import { defaultRoom, presetLayouts } from '../data'
import { intersects, rectOf } from '../geometry'
import type { Item, Room, RoomDoc } from '../types'

/** In-memory RoomStorage with hooks for export/import. */
class FakeStorage implements RoomStorage {
  readonly location = 'a test'
  docs = new Map<string, RoomDoc>()
  exported: RoomDoc[] = []
  nextImport: unknown = null
  saves = 0
  async list() { return [...this.docs.values()].map(summarize) }
  async load(id: string) { const d = this.docs.get(id); return d ? JSON.parse(JSON.stringify(d)) as RoomDoc : null }
  async save(doc: RoomDoc) { this.saves += 1; this.docs.set(doc.id, JSON.parse(JSON.stringify(doc))) }
  async remove(id: string) { this.docs.delete(id) }
  async exportDoc(doc: RoomDoc) { this.exported.push(doc) }
  async importDoc() { return this.nextImport as RoomDoc | null }
}

let storage: FakeStorage

beforeEach(async () => {
  await useLibrary.getState().close()
  localStorage.clear()
  storage = new FakeStorage()
  useLibrary.getState().configure({ storage })
  useLibrary.setState({ rooms: [], groups: [], currentId: null, status: 'idle', error: null })
})

afterEach(async () => {
  vi.useRealTimers()
  await useLibrary.getState().close()
})

describe('library', () => {
  it("seeds the example room, Forest's Room and Bedroom 2 once each", async () => {
    await useLibrary.getState().refresh()
    const rooms = useLibrary.getState().rooms
    expect(rooms.map((r) => r.id)).toEqual([EXAMPLE_ID, 'room-forest', 'room-bedroom-2'])
    expect(rooms.map((r) => r.name)).toEqual(["Mila's room", "Forest's Room", 'Bedroom 2'])
    expect(rooms[0].group).toBe('Examples')
    expect(rooms[0].itemCount).toBe(8)
    expect(rooms[1].group).toBe('Home')
    expect(rooms[1].itemCount).toBe(7)
    expect(storage.docs.get('room-forest')).toEqual(forestsRoom())
    expect(storage.docs.get('room-bedroom-2')).toEqual(bedroomTwo())
    expect(rooms[2].itemCount).toBe(3)
    expect(useLibrary.getState().groups).toEqual(['Examples', 'Home'])
    expect(useLibrary.getState().location).toBe('a test')
    expect(localStorage.getItem(seedKey(EXAMPLE_ID))).toBe('1')
    expect(localStorage.getItem(seedKey('room-forest'))).toBe('1')
    expect(localStorage.getItem(SEEDED_KEY)).toBeNull()

    // refreshing again saves nothing more
    const saves = storage.saves
    await useLibrary.getState().refresh()
    expect(storage.saves).toBe(saves)
    expect(useLibrary.getState().rooms).toHaveLength(3)
  })

  it('never brings a deleted seed back', async () => {
    await useLibrary.getState().refresh()
    await useLibrary.getState().remove('room-forest')
    await useLibrary.getState().remove('room-bedroom-2')
    await useLibrary.getState().refresh()
    expect(useLibrary.getState().rooms.map((r) => r.id)).toEqual([EXAMPLE_ID])
    await useLibrary.getState().remove(EXAMPLE_ID)
    await useLibrary.getState().refresh()
    expect(useLibrary.getState().rooms).toHaveLength(0)
    expect(storage.docs.size).toBe(0)
    expect(localStorage.getItem(seedKey(EXAMPLE_ID))).toBe('1')
    expect(localStorage.getItem(seedKey('room-forest'))).toBe('1')
  })

  it('treats the old single flag as "the example was seeded already"', async () => {
    localStorage.setItem(SEEDED_KEY, '1')
    await useLibrary.getState().refresh()
    expect(useLibrary.getState().rooms.map((r) => r.id)).toEqual(['room-forest', 'room-bedroom-2'])
    expect(localStorage.getItem(seedKey(EXAMPLE_ID))).toBe('1')
    await useLibrary.getState().refresh()
    expect(useLibrary.getState().rooms).toHaveLength(2)
  })

  it('marks a seed as done when a room with its id is already in the library', async () => {
    storage.docs.set('room-forest', { ...forestsRoom(), name: 'My nursery' })
    await useLibrary.getState().refresh()
    expect(useLibrary.getState().rooms.map((r) => r.name)).toEqual(['My nursery', "Mila's room", 'Bedroom 2'])
    expect(localStorage.getItem(seedKey('room-forest'))).toBe('1')
    await useLibrary.getState().remove('room-forest')
    await useLibrary.getState().refresh()
    expect(useLibrary.getState().rooms.map((r) => r.id)).toEqual([EXAMPLE_ID, 'room-bedroom-2'])
  })

  it('keeps the seeded record next to the rooms so a fresh copy of the app does not bring a deleted seed back', async () => {
    class RecordingStorage extends FakeStorage {
      seeded = new Set<string>()
      async seededIds() { return [...this.seeded] }
      async markSeeded(ids: string[]) { ids.forEach((i) => this.seeded.add(i)) }
    }
    const shared = new RecordingStorage()
    useLibrary.getState().configure({ storage: shared })
    await useLibrary.getState().refresh()
    expect([...shared.seeded].sort()).toEqual(['room-bedroom-2', EXAMPLE_ID, 'room-forest'])
    await useLibrary.getState().remove('room-forest')

    // a new copy of the app: its browser storage is empty, the folder is the same
    localStorage.clear()
    await useLibrary.getState().refresh()
    expect(useLibrary.getState().rooms.map((r) => r.id).sort()).toEqual(['room-bedroom-2', EXAMPLE_ID])
  })

  it('copies seeds flagged in this browser into the shared record', async () => {
    class RecordingStorage extends FakeStorage {
      seeded = new Set<string>()
      async seededIds() { return [...this.seeded] }
      async markSeeded(ids: string[]) { ids.forEach((i) => this.seeded.add(i)) }
    }
    const shared = new RecordingStorage()
    localStorage.setItem(seedKey('room-forest'), '1') // seeded and then deleted before the record existed
    useLibrary.getState().configure({ storage: shared })
    await useLibrary.getState().refresh()
    expect(useLibrary.getState().rooms.map((r) => r.id)).not.toContain('room-forest')
    expect(shared.seeded.has('room-forest')).toBe(true)
  })

  it('create() adds a room and opens it in the planner', async () => {
    await useLibrary.getState().refresh()
    const id = await useLibrary.getState().create({ name: 'Study', group: 'Home', w: 320, d: 410, start: 'empty' })
    const lib = useLibrary.getState()
    expect(lib.currentId).toBe(id)
    expect(lib.status).toBe('saved')
    expect(lib.rooms.map((r) => r.name).sort()).toEqual(['Bedroom 2', "Forest's Room", "Mila's room", 'Study'])
    expect(lib.groups).toEqual(['Examples', 'Home'])
    const st = useStore.getState()
    expect(st.room.name).toBe('Study')
    expect(st.room.w).toBe(320)
    expect(st.room.d).toBe(410)
    expect(st.items).toEqual([])
    expect(st.savedLayouts).toEqual([])
    expect(storage.docs.get(id)?.group).toBe('Home')
  })

  it('opening the example room lights up preset A', async () => {
    await useLibrary.getState().refresh()
    const id = useLibrary.getState().rooms[0].id
    await useLibrary.getState().open(id)
    expect(useLibrary.getState().currentId).toBe(id)
    expect(useStore.getState().activeLayoutId).toBe('A')
    expect(useStore.getState().savedLayouts.map((l) => l.id)).toEqual(['A', 'B', 'C', 'now'])
  })

  it('autosaves edits after a debounce: dirty → saving → saved', async () => {
    await useLibrary.getState().refresh()
    const id = await useLibrary.getState().create({ name: 'Study' })
    vi.useFakeTimers()
    const savesBefore = storage.saves

    useStore.getState().setRoom({ w: 333 })
    expect(useLibrary.getState().status).toBe('dirty')
    useStore.getState().setRoom({ d: 444 })
    expect(useLibrary.getState().status).toBe('dirty')

    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS - 50)
    expect(useLibrary.getState().status).toBe('dirty')
    expect(storage.saves).toBe(savesBefore)

    // the save starts at the debounce and finishes once the (fake) storage resolves
    const seen: string[] = []
    const unsub = useLibrary.subscribe((s) => { seen.push(s.status) })
    await vi.advanceTimersByTimeAsync(60)
    unsub()
    expect(seen).toContain('saving')
    expect(useLibrary.getState().status).toBe('saved')
    expect(storage.saves).toBe(savesBefore + 1)

    const saved = storage.docs.get(id)!
    expect(saved.room.w).toBe(333)
    expect(saved.room.d).toBe(444)
    const summary = useLibrary.getState().rooms.find((r) => r.id === id)!
    expect(summary.w).toBe(333)
    expect(summary.d).toBe(444)

    // display settings and saved layouts are part of the document too
    useStore.getState().setSetting('daytime', false)
    useStore.getState().saveLayout('Version 1')
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10)
    expect(storage.docs.get(id)!.settings.daytime).toBe(false)
    expect(storage.docs.get(id)!.layouts.map((l) => l.name)).toEqual(['Version 1'])
  })

  it('keeps the edits after a failed autosave and retries on close()', async () => {
    await useLibrary.getState().refresh()
    const id = await useLibrary.getState().create({ name: 'Study' })
    const realSave = storage.save.bind(storage)
    let fail = true
    storage.save = async (doc) => { if (fail) throw new Error('disk full'); await realSave(doc) }
    vi.useFakeTimers()
    useStore.getState().setRoom({ h: 290 })
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MS + 10)
    expect(useLibrary.getState().status).toBe('error')
    expect(useLibrary.getState().error).toMatch(/disk full/)
    expect(storage.docs.get(id)!.room.h).not.toBe(290)
    vi.useRealTimers()

    // closing while the disk is still full: the room stays open, the edits stay in the planner
    await useLibrary.getState().close()
    expect(useLibrary.getState().currentId).toBe(id)
    expect(useLibrary.getState().status).toBe('error')
    expect(useLibrary.getState().error).toMatch(/stays open/)
    expect(useStore.getState().room.h).toBe(290)
    // and neither open() nor create() throws the edits away
    await useLibrary.getState().open(EXAMPLE_ID)
    expect(useLibrary.getState().currentId).toBe(id)
    expect(useStore.getState().room.h).toBe(290)
    await useLibrary.getState().create({ name: 'Another' })
    expect(useLibrary.getState().currentId).toBe(id)
    expect(useStore.getState().room.h).toBe(290)

    // once saving works again, close() flushes the pending edits
    fail = false
    await useLibrary.getState().close()
    expect(useLibrary.getState().currentId).toBeNull()
    expect(storage.docs.get(id)!.room.h).toBe(290)
  })

  it('open(): when two opens race, the later one wins whatever order the loads finish in', async () => {
    await useLibrary.getState().refresh()
    const gates = new Map<string, () => void>()
    const realLoad = storage.load.bind(storage)
    storage.load = async (id) => {
      await new Promise<void>((resolve) => gates.set(id, resolve))
      return realLoad(id)
    }
    const first = useLibrary.getState().open(EXAMPLE_ID)
    const second = useLibrary.getState().open('room-forest')
    await vi.waitFor(() => expect(gates.size).toBe(2))
    expect(useLibrary.getState().status).toBe('loading')
    // the second load finishes first, then the first one straggles in
    gates.get('room-forest')!()
    await second
    expect(useLibrary.getState().currentId).toBe('room-forest')
    gates.get(EXAMPLE_ID)!()
    await first
    expect(useLibrary.getState().currentId).toBe('room-forest')
    expect(useStore.getState().room.name).toBe("Forest's Room")
    expect(useLibrary.getState().status).toBe('saved')
  })

  it('close() flushes a pending save first', async () => {
    await useLibrary.getState().refresh()
    const id = await useLibrary.getState().create({ name: 'Study' })
    useStore.getState().setRoom({ h: 280 })
    expect(useLibrary.getState().status).toBe('dirty')
    await useLibrary.getState().close()
    expect(useLibrary.getState().currentId).toBeNull()
    expect(storage.docs.get(id)!.room.h).toBe(280)
  })

  it('rename updates the summary and room.name', async () => {
    await useLibrary.getState().refresh()
    const id = await useLibrary.getState().create({ name: 'Study' })
    await useLibrary.getState().rename(id, 'Office')
    expect(useStore.getState().room.name).toBe('Office')
    expect(useLibrary.getState().rooms.find((r) => r.id === id)!.name).toBe('Office')
    expect(storage.docs.get(id)!.name).toBe('Office')
    expect(storage.docs.get(id)!.room.name).toBe('Office')

    // renaming a room that is not open
    const other = useLibrary.getState().rooms.find((r) => r.id !== id)!
    await useLibrary.getState().rename(other.id, 'Example')
    expect(useLibrary.getState().rooms.find((r) => r.id === other.id)!.name).toBe('Example')
    expect(storage.docs.get(other.id)!.room.name).toBe('Example')
    expect(useStore.getState().room.name).toBe('Office')
  })

  it('setGroup moves a room and updates the group list', async () => {
    await useLibrary.getState().refresh()
    const id = useLibrary.getState().rooms[0].id
    await useLibrary.getState().setGroup(id, 'Cabin')
    expect(useLibrary.getState().groups).toEqual(['Cabin', 'Home'])
    expect(storage.docs.get(id)!.group).toBe('Cabin')
  })

  it('duplicate creates a copy with a new id', async () => {
    await useLibrary.getState().refresh()
    const id = useLibrary.getState().rooms[0].id
    const copyId = await useLibrary.getState().duplicate(id)
    expect(copyId).toBeTruthy()
    expect(copyId).not.toBe(id)
    expect(useLibrary.getState().rooms).toHaveLength(4)
    const copy = storage.docs.get(copyId!)!
    expect(copy.name).toBe("Mila's room (copy)")
    expect(copy.items).toHaveLength(8)
    expect(copy.group).toBe('Examples')
  })

  it('remove deletes the document, closing it if it was open', async () => {
    await useLibrary.getState().refresh()
    const id = await useLibrary.getState().create({ name: 'Temp' })
    expect(useLibrary.getState().currentId).toBe(id)
    await useLibrary.getState().remove(id)
    expect(useLibrary.getState().currentId).toBeNull()
    expect(storage.docs.has(id)).toBe(false)
    expect(useLibrary.getState().rooms.some((r) => r.id === id)).toBe(false)
  })

  it('exportDoc hands the document to the storage backend', async () => {
    await useLibrary.getState().refresh()
    const id = useLibrary.getState().rooms[0].id
    await useLibrary.getState().exportDoc(id)
    expect(storage.exported).toHaveLength(1)
    expect(storage.exported[0].id).toBe(id)
  })

  it('imports a document with the old singular room shape', async () => {
    await useLibrary.getState().refresh()
    storage.nextImport = {
      id: 'room-old',
      name: 'Old room',
      room: {
        name: 'Old room',
        w: 250,
        d: 300,
        h: 250,
        window: { wall: 'left', offset: 40, width: 100, height: 120, sill: 90 },
        door: { wall: 'right', offset: 20, width: 80, height: 205, sill: 0, hinge: 'left' },
        radiator: { wall: 'left', offset: 50, width: 80, depth: 10, height: 60 },
      },
      items: [{ id: 'bed', name: 'Bed', kind: 'bed', w: 140, d: 200, h: 50, x: 100, y: 120, rot: 0, color: '#fcc', inRoom: true }],
    }
    const id = await useLibrary.getState().importDoc()
    expect(id).toBe('room-old')
    expect(useLibrary.getState().currentId).toBe('room-old')
    const st = useStore.getState()
    expect(st.room.w).toBe(250)
    expect(st.room.name).toBe('Old room')
    expect(st.room.wallColors).toEqual(defaultRoom.wallColors)
    expect(st.items).toHaveLength(1)
    expect(st.savedLayouts).toEqual([])
    expect(storage.docs.get('room-old')!.version).toBe(DOC_VERSION)
    expect(useLibrary.getState().rooms.map((r) => r.name).sort()).toEqual(['Bedroom 2', "Forest's Room", "Mila's room", 'Old room'])

    // an unreadable file is reported, not thrown
    storage.nextImport = { nothing: true }
    expect(await useLibrary.getState().importDoc()).toBeNull()
    expect(useLibrary.getState().error).toMatch(/not a Room Planner room/)
  })
})

describe('what a new room starts with', () => {
  const inside = (room: Room, it: Item) => {
    const r = rectOf(it)
    return r.x0 >= 0 && r.y0 >= 0 && r.x1 <= room.w && r.y1 <= room.d
  }
  const overlapping = (items: Item[]) =>
    items.some((a, i) => items.slice(i + 1).some((b) => intersects(rectOf(a), rectOf(b))))

  it('"basics" adds a bed, a dresser, a desk and a rug that fit', async () => {
    await useLibrary.getState().refresh()
    const id = await useLibrary.getState().create({ name: 'Nursery', start: 'basics' })
    const { room, items, savedLayouts } = useStore.getState()
    expect(room.w).toBe(300)
    expect(room.d).toBe(400)
    expect(room.windows).toHaveLength(1)
    expect(room.doors).toHaveLength(1)
    expect(items.map((i) => i.id)).toEqual(['item-bed-1', 'item-dresser-1', 'item-desk-1', 'item-rug-1'])
    expect(items.map((i) => i.kind)).toEqual(['bed', 'dresser', 'desk', 'rug'])
    expect(items.map((i) => i.name)).toEqual(['Double bed 140×200', 'Wide dresser, 6 drawers', 'Small desk', 'Round rug Ø160'])
    expect(items.every((i) => i.inRoom)).toBe(true)
    expect(items.every((i) => inside(room, i))).toBe(true)
    expect(overlapping(items)).toBe(false)
    // catalogue colour and note come along
    expect(items[0].color).toBe('#efe9df')
    expect(items[0].note).toMatch(/140×200/)
    // fresh ids: the example room's preset layouts (and their tabs) never apply here
    expect(items.some((i) => i.id in presetLayouts[0].placements)).toBe(false)
    expect(savedLayouts).toEqual([])
    expect(storage.docs.get(id)!.items).toHaveLength(4)
    expect(useLibrary.getState().rooms.find((r) => r.id === id)!.itemCount).toBe(4)
  })

  it('is the default, and picks the smaller rug in a narrow room', async () => {
    await useLibrary.getState().refresh()
    await useLibrary.getState().create({ name: 'Box room', w: 240, d: 400 })
    const { room, items } = useStore.getState()
    expect(room.w).toBe(240)
    expect(items).toHaveLength(4)
    expect(items.find((i) => i.kind === 'rug')!.name).toBe('Round rug Ø120')
    expect(items.every((i) => inside(room, i))).toBe(true)
    expect(overlapping(items)).toBe(false)
  })

  it('leaves out what does not fit in a tiny room, without overlaps', async () => {
    await useLibrary.getState().refresh()
    await useLibrary.getState().create({ name: 'Cupboard', w: 160, d: 200, start: 'basics' })
    const { room, items } = useStore.getState()
    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThan(4)
    expect(items.every((i) => inside(room, i))).toBe(true)
    expect(overlapping(items)).toBe(false)
  })

  it('"empty" adds nothing', async () => {
    await useLibrary.getState().refresh()
    await useLibrary.getState().create({ name: 'Bare', start: 'empty' })
    expect(useStore.getState().items).toEqual([])
    expect(useStore.getState().room.windows).toHaveLength(1)
  })

  it('"example" copies the example room (fromExample still works)', async () => {
    await useLibrary.getState().refresh()
    const id = await useLibrary.getState().create({ name: 'Second try', group: 'Ideas', w: 500, start: 'example' })
    let st = useStore.getState()
    expect(st.room.name).toBe('Second try')
    expect(st.room.w).toBe(defaultRoom.w)
    expect(st.items).toHaveLength(8)
    expect(st.activeLayoutId).toBe('A')
    expect(st.savedLayouts.map((l) => l.id)).toEqual(['A', 'B', 'C', 'now'])
    expect(storage.docs.get(id)!.group).toBe('Ideas')

    await useLibrary.getState().create({ name: 'Old style', fromExample: true })
    st = useStore.getState()
    expect(st.items).toHaveLength(8)
    expect(st.room.name).toBe('Old style')
  })
})

describe('copying an item to another room', () => {
  const inside = (room: Room, it: Item) => {
    const r = rectOf(it)
    return r.x0 >= 0 && r.y0 >= 0 && r.x1 <= room.w && r.y1 <= room.d
  }

  /** Seed the library, save a target room, then open the example room in the planner. */
  async function setup(target: CreateInput = { name: 'Studio', group: 'Home', w: 300, d: 400, start: 'empty' }) {
    await useLibrary.getState().refresh()
    const targetId = await useLibrary.getState().create(target)
    await useLibrary.getState().open(EXAMPLE_ID)
    expect(useLibrary.getState().currentId).toBe(EXAMPLE_ID)
    return targetId
  }

  it('copies with a fresh id onto a free spot in the target and leaves the source alone', async () => {
    const targetId = await setup()
    storage.docs.get(targetId)!.updatedAt = '2020-01-01T00:00:00.000Z'
    const wardrobe = useStore.getState().items.find((i) => i.id === 'wardrobe')!
    const saves = storage.saves

    const result = await useLibrary.getState().copyItemToRoom('wardrobe', targetId, 'copy')
    expect(result.placed).toBe(true)
    expect(result.targetName).toBe('Studio')
    expect(result.where).toMatch(/^(against the (left|right|back|front) wall|in the (back|front)-(left|right) corner)$/)

    const target = storage.docs.get(targetId)!
    expect(target.items).toHaveLength(1)
    const copy = target.items[0]
    expect(copy.id).toMatch(/^wardrobe-[a-z0-9]{6}$/)
    expect(copy).toMatchObject({ name: 'Wardrobe', kind: 'wardrobe', w: 100, d: 58, h: 200, color: wardrobe.color, inRoom: true })
    expect('note' in copy).toBe(false)
    expect(inside(target.room, copy)).toBe(true)
    const spot = findFreeSpot(target.room, [], 100, 58, { h: 200 })
    expect({ x: copy.x, y: copy.y, rot: copy.rot }).toEqual({ x: spot.x, y: spot.y, rot: spot.rot })
    expect(target.updatedAt > '2020-01-01T00:00:00.000Z').toBe(true)
    expect(storage.saves).toBe(saves + 1)

    // the source still has it and is untouched; the list shows the target's new item
    expect(useStore.getState().items.find((i) => i.id === 'wardrobe')).toBe(wardrobe)
    expect(useLibrary.getState().status).toBe('saved')
    expect(useLibrary.getState().rooms.find((r) => r.id === targetId)!.itemCount).toBe(1)
    expect(useLibrary.getState().currentId).toBe(EXAMPLE_ID)

    // a second copy gets another id and another free spot, and the note comes along
    const again = await useLibrary.getState().copyItemToRoom('bed', targetId, 'copy')
    expect(again.placed).toBe(true)
    const items = storage.docs.get(targetId)!.items
    expect(items).toHaveLength(2)
    expect(items[1].id).toMatch(/^bed-/)
    expect(items[1].note).toMatch(/TUFJORD/)
    expect(intersects(rectOf(items[0]), rectOf(items[1]))).toBe(false)
  })

  it('move puts it in the target and removes it from the open room, which autosaves', async () => {
    const targetId = await setup()
    const result = await useLibrary.getState().copyItemToRoom('desk', targetId, 'move')
    expect(result.placed).toBe(true)
    expect(useStore.getState().items.some((i) => i.id === 'desk')).toBe(false)
    expect(storage.docs.get(targetId)!.items.map((i) => i.name)).toEqual(['Desk'])
    expect(useLibrary.getState().status).toBe('dirty')
    await useLibrary.getState().saveNow()
    expect(storage.docs.get(EXAMPLE_ID)!.items.some((i) => i.id === 'desk')).toBe(false)
    expect(storage.docs.get(EXAMPLE_ID)!.items).toHaveLength(7)
  })

  it('parks the item beside the plan when nothing fits', async () => {
    const targetId = await setup({ name: 'Cupboard', w: 150, d: 150, start: 'empty' })
    // something solid over the middle, so even the centre fallback is taken
    storage.docs.get(targetId)!.items = [
      { id: 'block', name: 'Block', kind: 'box', w: 140, d: 140, h: 100, x: 75, y: 75, rot: 0, color: '#ccc', inRoom: true },
    ]
    const result = await useLibrary.getState().copyItemToRoom('chair', targetId, 'copy')
    expect(result).toEqual({ placed: false, targetName: 'Cupboard' })
    const target = storage.docs.get(targetId)!
    const parked = target.items.find((i) => i.kind === 'chair')!
    expect(parked.inRoom).toBe(false)
    expect(parked.y).toBe(150 + PARK_Y)
    expect(parked.x).toBeGreaterThan(0)
    expect(useLibrary.getState().rooms.find((r) => r.id === targetId)!.itemCount).toBe(1)

    // a piece bigger than the room is parked too
    const big = await useLibrary.getState().copyItemToRoom('bed', targetId, 'copy')
    expect(big.placed).toBe(false)
    expect(storage.docs.get(targetId)!.items.find((i) => i.kind === 'bed')!.inRoom).toBe(false)
  })

  it('copying to the open room is a no-op', async () => {
    await setup()
    const saves = storage.saves
    const items = useStore.getState().items
    const result = await useLibrary.getState().copyItemToRoom('wardrobe', EXAMPLE_ID, 'copy')
    expect(result.placed).toBe(false)
    expect(result.targetName).toBe("Mila's room")
    expect(useStore.getState().items).toBe(items)
    expect(storage.saves).toBe(saves)
    expect(useLibrary.getState().status).toBe('saved')
  })

  it('rejects with a readable message for a missing item or room', async () => {
    const targetId = await setup()
    await expect(useLibrary.getState().copyItemToRoom('nothing', targetId, 'copy')).rejects.toThrow(/no longer in this room/)
    await expect(useLibrary.getState().copyItemToRoom('wardrobe', 'room-gone', 'copy')).rejects.toThrow(/could not be found/)
    expect(storage.docs.get(targetId)!.items).toEqual([])
  })
})

describe('helpers', () => {
  it('roomOpenings returns the window and door lists', () => {
    const single = roomOpenings(defaultRoom)
    expect(single.windows).toHaveLength(1)
    expect(single.doors[0].hinge).toBe('right')
    const arrays = roomOpenings({ ...defaultRoom, windows: [defaultRoom.windows[0], defaultRoom.windows[0]], doors: [] })
    expect(arrays.windows).toHaveLength(2)
    expect(arrays.doors).toHaveLength(0)
  })

  it('defaultRoomSize is 10 × 12 ft with an 8 ft ceiling in inches, 3 × 4 × 2.6 m otherwise', () => {
    expect(defaultRoomSize('in')).toEqual({ w: 305, d: 366, h: 244 })
    expect(defaultRoomSize('cm')).toEqual({ w: 300, d: 400, h: 260 })
  })

  it('timeAgo reads naturally', () => {
    const t = Date.parse('2026-09-24T12:00:00Z')
    expect(timeAgo('2026-09-24T11:59:50Z', t)).toBe('just now')
    expect(timeAgo('2026-09-24T11:30:00Z', t)).toBe('30 minutes ago')
    expect(timeAgo('2026-09-24T09:00:00Z', t)).toBe('3 hours ago')
    expect(timeAgo('2026-09-22T12:00:00Z', t)).toBe('2 days ago')
    expect(timeAgo('2026-06-24T12:00:00Z', t)).toBe('3 months ago')
    expect(timeAgo('nonsense', t)).toBe('')
  })
})

describe('share links', () => {
  it('start() turns a #hash share link into a "Shared room" document and clears the hash', async () => {
    const shared = { room: { ...defaultRoom, name: 'From a link', w: 280 }, items: [], s: { daytime: false } }
    const hash = '#' + btoa(encodeURIComponent(JSON.stringify(shared)))
    const g = globalThis as unknown as { location?: unknown; history?: unknown }
    const replaced: string[] = []
    g.location = { hash, pathname: '/planner', search: '?x=1' }
    g.history = { replaceState: (_s: unknown, _t: string, url: string) => { replaced.push(url) } }
    try {
      await useLibrary.getState().start()
      const lib = useLibrary.getState()
      expect(lib.currentId).toBeTruthy()
      const doc = storage.docs.get(lib.currentId!)!
      expect(doc.name).toBe('Shared room')
      expect(doc.group).toBe('Shared')
      expect(doc.room.w).toBe(280)
      expect(doc.settings.daytime).toBe(false)
      expect(useStore.getState().daytime).toBe(false)
      expect(replaced).toEqual(['/planner?x=1'])
      // the seed rooms were added as well
      expect(lib.rooms.map((r) => r.group).sort()).toEqual(['Examples', 'Home', 'Home', 'Shared'])
      // start() is idempotent (StrictMode mounts twice)
      await useLibrary.getState().start()
      expect(storage.docs.size).toBe(4)
    } finally {
      delete g.location
      delete g.history
    }
  })
})
