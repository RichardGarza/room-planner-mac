import { describe, expect, it } from 'vitest'

class MemoryStorage {
  private m = new Map<string, string>()
  getItem(k: string) { return this.m.get(k) ?? null }
  setItem(k: string, v: string) { this.m.set(k, v) }
  removeItem(k: string) { this.m.delete(k) }
  clear() { this.m.clear() }
}
;(globalThis as unknown as { localStorage: MemoryStorage }).localStorage = new MemoryStorage()

import { examplePresets, presetLayouts } from '../data'
import { exampleDoc } from '../library'
import { resizeRoom } from '../resize'
import { useStore } from '../store'
import type { Layout } from '../types'

describe('the example room presets', () => {
  it('are the presets themselves for a room that was never shifted', () => {
    expect(examplePresets(exampleDoc().layouts)).toEqual(presetLayouts)
    expect(examplePresets([])).toEqual(presetLayouts)
  })

  it('move with the room when a resize on the house map shifted it, and it opens on the preset again', () => {
    const doc = exampleDoc()
    const r = resizeRoom(doc, { roomId: doc.id, x: 0, y: 0, rot: 0 }, 'left', 40)
    const shifted = examplePresets(r.doc.layouts)
    const a = shifted.find((l) => l.id === 'A')!
    const bed = presetLayouts[0].placements.bed
    expect(a.placements.bed).toEqual({ ...bed, x: bed.x + 40 })
    // names and descriptions come from the presets
    expect(shifted.map((l) => l.name)).toEqual(presetLayouts.map((l) => l.name))
    // reopened, the room is recognised as sitting on preset A
    useStore.getState().hydrate(r.doc)
    expect(useStore.getState().activeLayoutId).toBe('A')
  })

  it('ignore a stored copy that is not a clean shift (an older version of a preset)', () => {
    const stale: Layout[] = presetLayouts.map((l) => ({ ...l, placements: { ...l.placements, bed: { ...l.placements.bed, x: l.placements.bed.x + 77 } } }))
    expect(examplePresets(stale)).toEqual(presetLayouts)
  })
})
