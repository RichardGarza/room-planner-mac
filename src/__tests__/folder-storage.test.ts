import { beforeEach, describe, expect, it } from 'vitest'

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

import { defaultRoom } from '../data'
import { DOC_VERSION } from '../migrate'
import { ADOPTED_KEY, adoptBrowserRooms } from '../storage'
import { LocalStorageBackend } from '../storage/local'
import { summarize, type RoomStorage } from '../storage/types'
import type { RoomDoc } from '../types'

class FakeFolder implements RoomStorage {
  readonly location = '~/Documents/Room Planner'
  docs = new Map<string, RoomDoc>()
  async list() { return [...this.docs.values()].map(summarize) }
  async load(id: string) { return this.docs.get(id) ?? null }
  async save(doc: RoomDoc) { this.docs.set(doc.id, doc) }
  async remove(id: string) { this.docs.delete(id) }
}

const doc = (id: string, name: string, updatedAt: string, createdAt = '2026-01-01T00:00:00.000Z'): RoomDoc => ({
  id, name, group: '', notes: '', createdAt, updatedAt,
  room: { ...defaultRoom, name }, items: [], layouts: [],
  settings: { daytime: true, doorAngle: 70, blinds: 40, bedding: true, walkHeight: 'adult', quality: 'best' },
  version: DOC_VERSION,
})

let local: LocalStorageBackend
let folder: FakeFolder

beforeEach(() => {
  localStorage.clear()
  local = new LocalStorageBackend()
  folder = new FakeFolder()
})

describe('adoptBrowserRooms', () => {
  it('copies rooms the folder does not have, once, and leaves the browser copies in place', async () => {
    await local.save(doc('room-a', 'Study', '2026-02-01T00:00:00.000Z'))
    expect(await adoptBrowserRooms(folder, local)).toBe(1)
    expect(folder.docs.get('room-a')?.name).toBe('Study')
    expect(localStorage.getItem(ADOPTED_KEY)).toBe('1')
    expect((await local.list()).map((r) => r.id)).toEqual(['room-a'])

    folder.docs.clear()
    expect(await adoptBrowserRooms(folder, local)).toBe(0)
    expect(folder.docs.size).toBe(0)
  })

  it('lets the folder win, and keeps a later browser edit as a separate room', async () => {
    folder.docs.set('room-a', doc('room-a', 'Study', '2026-03-01T00:00:00.000Z'))
    folder.docs.set('room-b', doc('room-b', 'Den', '2026-01-05T00:00:00.000Z'))
    await local.save(doc('room-a', 'Study', '2026-02-01T00:00:00.000Z')) // older: dropped
    await local.save(doc('room-b', 'Den', '2026-04-01T00:00:00.000Z')) // edited later: kept as a copy
    await local.save(doc('room-forest', "Forest's Room", '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')) // unedited seed
    folder.docs.set('room-forest', doc('room-forest', "Forest's Room", '2026-09-20T00:00:00.000Z'))

    expect(await adoptBrowserRooms(folder, local)).toBe(1)
    expect(folder.docs.get('room-a')?.updatedAt).toBe('2026-03-01T00:00:00.000Z')
    expect(folder.docs.get('room-b')?.updatedAt).toBe('2026-01-05T00:00:00.000Z')
    const copies = [...folder.docs.values()].filter((d) => d.name === 'Den (from browser)')
    expect(copies).toHaveLength(1)
    expect(copies[0].updatedAt).toBe('2026-04-01T00:00:00.000Z')
    expect(folder.docs.get('room-forest')?.updatedAt).toBe('2026-09-20T00:00:00.000Z')
  })
})

describe('houses in the browser', () => {
  it('keeps houses in local storage when there is no rooms folder', async () => {
    const local = new LocalStorageBackend()
    const house = { id: 'house-home', name: 'Home', createdAt: '', updatedAt: '', version: 1, rooms: [{ roomId: 'room-a', x: 0, y: 0, rot: 0 as const }] }
    await local.saveHouse(house)
    await local.saveHouse({ ...house, name: 'Our home' })
    expect((await local.listHouses()).map((h) => h.name)).toEqual(['Our home'])
    await local.removeHouse('house-home')
    expect(await local.listHouses()).toEqual([])
  })
})
