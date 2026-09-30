import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { RoomStorage } from '../storage/types'
import type { RoomDoc } from '../types'

/*
 * In the page, a change is saved straight away, except while a pointer is held down: a drag is
 * written the moment it is let go. This needs a `window` for the pointer events, so it gets one of
 * its own before the library module loads.
 */
class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
const win = new EventTarget()
;(globalThis as unknown as { window: EventTarget }).window = win
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage()

let lib: typeof import('../library')
let store: typeof import('../store')
beforeAll(async () => {
  lib = await import('../library')
  store = await import('../store')
})

class CountingStorage implements RoomStorage {
  readonly location = 'a test'
  docs = new Map<string, RoomDoc>()
  saves = 0
  async list() { return [] }
  async load(id: string) { return this.docs.get(id) ?? null }
  async save(doc: RoomDoc) { this.saves += 1; this.docs.set(doc.id, JSON.parse(JSON.stringify(doc))) }
  async remove(id: string) { this.docs.delete(id) }
}

describe('saving during a drag', () => {
  it('waits while the pointer is down and saves the moment it is let go', async () => {
    const storage = new CountingStorage()
    lib.useLibrary.getState().configure({ storage })
    const id = await lib.useLibrary.getState().create({ name: 'Study', start: 'empty' })
    vi.useFakeTimers()
    const before = storage.saves

    win.dispatchEvent(new Event('pointerdown'))
    store.useStore.getState().setRoom({ w: 333 })
    store.useStore.getState().setRoom({ w: 344 })
    await vi.advanceTimersByTimeAsync(1000)
    expect(storage.saves).toBe(before)
    expect(lib.useLibrary.getState().status).toBe('dirty')

    win.dispatchEvent(new Event('pointerup'))
    await vi.advanceTimersByTimeAsync(1)
    expect(storage.saves).toBe(before + 1)
    expect(storage.docs.get(id)!.room.w).toBe(344)
    expect(lib.useLibrary.getState().status).toBe('saved')

    // not dragging: straight away
    store.useStore.getState().setRoom({ w: 355 })
    await vi.advanceTimersByTimeAsync(1)
    expect(storage.docs.get(id)!.room.w).toBe(355)
    vi.useRealTimers()
  })
})
