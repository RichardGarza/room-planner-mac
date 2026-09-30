import { describe, expect, it } from 'vitest'
import { runChecks } from '../checks'
import { defaultItems, defaultRoom, makeEmptyRoom, presetLayouts } from '../data'
import { intersects, isRugKind, rectOf } from '../geometry'
import { useStore } from '../store'
import { describeLayout, suggestLayouts } from '../suggest'
import type { Item, Layout, Rect, Room } from '../types'

function item(id: string, kind: Item['kind'], w: number, d: number, h: number): Item {
  return { id, name: id, kind, w, d, h, x: 0, y: 0, rot: 0, color: '#ffffff', inRoom: true }
}

const bedroom = (): Item[] => [
  item('bed', 'bed', 150, 210, 95),
  item('dresser', 'dresser', 160, 48, 85),
  item('desk', 'desk', 100, 50, 75),
  item('chair', 'chair', 56, 56, 86),
  item('rug', 'rug', 160, 160, 1),
]

const apply = (items: Item[], layout: Layout): Item[] => items.map((i) => ({ ...i, ...layout.placements[i.id] }))
const inside = (room: Room, r: Rect) => r.x0 >= -0.01 && r.y0 >= -0.01 && r.x1 <= room.w + 0.01 && r.y1 <= room.d + 0.01

describe('suggestLayouts', () => {
  it('suggests up to three layouts for the example room, the best one without bad checks', () => {
    const items = apply(defaultItems, presetLayouts[0])
    const layouts = suggestLayouts(defaultRoom, items)
    expect(layouts.length).toBeGreaterThanOrEqual(1)
    expect(layouts.length).toBeLessThanOrEqual(3)
    expect(layouts[0].recommended).toBe(true)
    expect(layouts.slice(1).every((l) => !l.recommended)).toBe(true)
    expect(layouts.map((l) => l.id)).toEqual(['sug-a', 'sug-b', 'sug-c'].slice(0, layouts.length))
    const checks = runChecks(defaultRoom, apply(items, layouts[0]))
    expect(checks.filter((c) => c.level === 'bad')).toEqual([])
    for (const l of layouts) {
      expect(Object.keys(l.placements).sort()).toEqual(items.map((i) => i.id).sort())
      expect(l.name).toMatch(/^[ABC] · Bed /)
      expect(l.description.split(/\.\s/).length).toBeGreaterThanOrEqual(2)
    }
  })

  it('places a bedroom set in an empty room: inside, apart, chair at the desk', () => {
    const room = makeEmptyRoom('t', 300, 400)
    const items = bedroom()
    const t0 = performance.now()
    const layouts = suggestLayouts(room, items)
    const ms = performance.now() - t0
    expect(ms).toBeLessThan(500)
    expect(layouts.length).toBeGreaterThanOrEqual(2)
    for (const l of layouts) {
      const placed = apply(items, l)
      for (const it of placed) {
        expect(it.inRoom, `${it.id} is placed in ${l.name}`).toBe(true)
        expect(inside(room, rectOf(it)), `${it.id} inside the room in ${l.name}`).toBe(true)
      }
      const solid = placed.filter((i) => !isRugKind(i.kind))
      for (let a = 0; a < solid.length; a++) {
        for (let b = a + 1; b < solid.length; b++) {
          const A = solid[a], B = solid[b]
          const pair = new Set([A.kind, B.kind])
          if (pair.has('chair') && pair.has('desk')) continue
          expect(intersects(rectOf(A), rectOf(B)), `${A.id} and ${B.id} apart in ${l.name}`).toBe(false)
        }
      }
      const desk = placed.find((i) => i.id === 'desk')!
      const chair = placed.find((i) => i.id === 'chair')!
      expect(Math.hypot(desk.x - chair.x, desk.y - chair.y)).toBeLessThanOrEqual(70)
      // the bed stands against a wall, headboard first
      const bed = rectOf(placed.find((i) => i.id === 'bed')!)
      expect(bed.x0 === 0 || bed.y0 === 0 || bed.x1 === room.w || bed.y1 === room.d).toBe(true)
      const checks = runChecks(room, placed)
      expect(checks.filter((c) => c.level === 'bad')).toEqual([])
    }
    // the layouts differ in where the bed went
    const beds = layouts.map((l) => `${l.placements.bed.x},${l.placements.bed.y},${l.placements.bed.rot}`)
    expect(new Set(beds).size).toBe(layouts.length)
  })

  it('is deterministic', () => {
    const room = makeEmptyRoom('t', 300, 400)
    const a = suggestLayouts(room, bedroom())
    const b = suggestLayouts(room, bedroom())
    expect(a).toEqual(b)
  })

  // a timing test: a busy machine (a build, a browser) can slow one run, so it gets two more tries at the same limit
  it('stays fast with a dozen pieces in a 4 × 5 m room', { retry: 2 }, () => {
    const room = makeEmptyRoom('big', 400, 500)
    const items = [
      ...bedroom(),
      item('wardrobe', 'wardrobe', 150, 58, 220),
      item('wardrobe2', 'wardrobe', 100, 58, 200),
      item('ns1', 'nightstand', 40, 40, 55),
      item('ns2', 'nightstand', 40, 40, 55),
      item('bookcase', 'bookcase', 80, 28, 202),
      item('sofa', 'sofa', 160, 90, 85),
      item('table', 'table', 100, 60, 45),
    ]
    const t0 = performance.now()
    const layouts = suggestLayouts(room, items)
    expect(performance.now() - t0).toBeLessThan(500)
    expect(layouts).toHaveLength(3)
    const best = apply(items, layouts[0])
    expect(best.every((i) => i.inRoom)).toBe(true)
    // at least one nightstand sits right beside the bed (both when the bed is not in a corner)
    const bed = rectOf(best.find((i) => i.id === 'bed')!)
    const beside = ['ns1', 'ns2'].filter((id) => {
      const ns = rectOf(best.find((i) => i.id === id)!)
      const gap = Math.max(Math.max(ns.x0, bed.x0) - Math.min(ns.x1, bed.x1), Math.max(ns.y0, bed.y0) - Math.min(ns.y1, bed.y1))
      return gap <= 1
    })
    expect(beside.length).toBeGreaterThanOrEqual(1)
  })

  it('puts every piece in the room in, even a bed too big for the room, and says so instead of pretending it is on a wall', () => {
    const room = makeEmptyRoom('tiny', 160, 160)
    const items = [item('bed', 'bed', 190, 212, 95), item('chair', 'chair', 40, 40, 60)]
    const layouts = suggestLayouts(room, items)
    expect(layouts.length).toBeGreaterThanOrEqual(1)
    for (const l of layouts) {
      expect(l.placements.bed.inRoom).toBe(true)
      expect(l.placements.chair.inRoom).toBe(true)
    }
    expect(layouts[0].name).toBe('A · Bed does not fit cleanly')
    expect(layouts[0].description).toMatch(/^The bed has no clean spot in this room and stands where it is in the way least\. Watch out: [Bb]ed goes through a wall/)
    // with nothing else in the room
    const [alone] = suggestLayouts(room, [item('bed', 'bed', 190, 212, 95)])
    expect(alone.placements.bed.inRoom).toBe(true)
    expect(alone.name).toBe('A · Bed does not fit cleanly')
  })


  it('leaves furniture the user took out of the room where it is, out of the room', () => {
    const room = makeEmptyRoom('t', 300, 400)
    const wardrobe: Item = { ...item('wardrobe', 'wardrobe', 100, 58, 200), inRoom: false, x: 70, y: 490, rot: 90 }
    const items = [...bedroom(), wardrobe]
    const layouts = suggestLayouts(room, items)
    expect(layouts.length).toBeGreaterThanOrEqual(2)
    for (const l of layouts) {
      expect(l.placements.wardrobe).toEqual({ x: 70, y: 490, rot: 90, inRoom: false })
      expect(l.description).not.toMatch(/did not fit|wardrobe/)
      for (const it of bedroom()) expect(l.placements[it.id].inRoom, `${it.id} placed in ${l.name}`).toBe(true)
    }
    // the parked piece takes no part: the layouts are the ones the room would get without it
    const without = suggestLayouts(room, bedroom())
    expect(layouts.map((l) => l.name)).toEqual(without.map((l) => l.name))
    for (const l of layouts) {
      const { wardrobe: _w, ...rest } = l.placements
      expect(rest).toEqual(without.find((o) => o.id === l.id)!.placements)
    }
  })

  it('anchors on what is in the room when the bed is parked', () => {
    const room = makeEmptyRoom('t', 300, 400)
    const bed: Item = { ...item('bed', 'bed', 150, 210, 95), inRoom: false, x: 95, y: 490 }
    const items = [bed, item('dresser', 'dresser', 160, 48, 85), item('desk', 'desk', 100, 50, 75)]
    const layouts = suggestLayouts(room, items)
    expect(layouts.length).toBeGreaterThanOrEqual(1)
    for (const l of layouts) {
      expect(l.name).toMatch(/^[ABC] · Dresser /)
      expect(l.name).not.toMatch(/head/)
      expect(l.placements.bed).toEqual({ x: 95, y: 490, rot: 0, inRoom: false })
      expect(l.placements.dresser.inRoom).toBe(true)
      expect(l.description).toMatch(/^The dresser stands /)
    }
  })

  it('titles layouts around a sofa without bed wording', () => {
    const room = makeEmptyRoom('t', 300, 400)
    const items = [item('sofa', 'sofa', 180, 90, 85), item('table', 'table', 100, 60, 45), item('bookcase', 'bookcase', 80, 28, 202)]
    const layouts = suggestLayouts(room, items)
    expect(layouts.length).toBeGreaterThanOrEqual(2)
    for (const l of layouts) {
      expect(l.name).toMatch(/^[ABC] · Sofa (against the (left|right|back|front) wall|in the (back|front)-(left|right) corner|under the window)/)
      expect(l.name).not.toMatch(/head|along/)
      expect(l.description).toMatch(/^The sofa stands (against|in the|under)/)
    }
    // and beds keep theirs
    const [bedLayout] = suggestLayouts(room, bedroom())
    expect(bedLayout.name).toMatch(/^A · Bed /)
  })

  it('returns nothing without furniture', () => {
    expect(suggestLayouts(makeEmptyRoom('e'), [])).toEqual([])
  })

  it('describes a layout in plain English', () => {
    const room = makeEmptyRoom('t', 300, 400)
    const items = bedroom()
    const [best] = suggestLayouts(room, items)
    const text = describeLayout(room, items, best)
    expect(text).toBe(best.description)
    expect(text).toMatch(/^The bed /)
    // a parked piece stays out of the story too
    const parked: Item = { ...item('wardrobe', 'wardrobe', 100, 58, 200), inRoom: false, x: 70, y: 490 }
    const [withParked] = suggestLayouts(room, [...items, parked])
    expect(describeLayout(room, [...items, parked], withParked)).toBe(withParked.description)
    expect(withParked.description).not.toMatch(/wardrobe/)
  })
})

describe('store suggestions', () => {
  it('fills the suggestions on demand and marks them stale when the furniture changes', () => {
    const s = useStore.getState()
    s.hydrate({
      id: 'r', name: 'Test', group: '', notes: '', createdAt: '', updatedAt: '', version: 1,
      room: makeEmptyRoom('t', 300, 400), items: bedroom(), layouts: [],
      settings: { daytime: true, doorAngle: 70, blinds: 40, bedding: true, walkHeight: 'adult', quality: 'best' },
    })
    expect(useStore.getState().suggestions).toEqual([])
    s.generateSuggestions()
    let st = useStore.getState()
    expect(st.suggestions.length).toBeGreaterThanOrEqual(2)
    expect(st.suggestionsStale).toBe(false)
    s.applyLayout(st.suggestions[0])
    st = useStore.getState()
    expect(st.activeLayoutId).toBe('sug-a')
    expect(st.suggestionsStale).toBe(false)
    s.addItem({ name: 'Lamp', kind: 'box', w: 30, d: 30, h: 160, color: '#fff' })
    expect(useStore.getState().suggestionsStale).toBe(true)
    s.generateSuggestions()
    expect(useStore.getState().suggestionsStale).toBe(false)
    s.setRoom({ w: 350 })
    expect(useStore.getState().suggestionsStale).toBe(true)
  })
})

describe('suggestions use exactly the furniture in the room', () => {
  it('puts every piece that is in the room into every suggestion, and leaves every piece taken out where it is', async () => {
    const { bedroomTwo, forestsRoom } = await import('../seeds')
    const { exampleDoc } = await import('../library')
    for (const doc of [forestsRoom(), bedroomTwo(), exampleDoc()]) {
      // take the first piece out, bring every other one in
      const items = doc.items.map((it, i) => (i === 0 ? { ...it, inRoom: false, x: 60, y: doc.room.d + 90 } : { ...it, inRoom: true }))
      const layouts = suggestLayouts(doc.room, items)
      expect(layouts.length, doc.name).toBeGreaterThan(0)
      for (const l of layouts) {
        for (const it of items) {
          if (it.inRoom) expect(l.placements[it.id]?.inRoom, `${it.name} in ${l.name} (${doc.name})`).toBe(true)
          else expect(l.placements[it.id], `${it.name} stays out in ${l.name} (${doc.name})`).toEqual({ x: it.x, y: it.y, rot: it.rot, inRoom: false })
        }
      }
    }
  })
})
