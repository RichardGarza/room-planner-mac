import { describe, expect, it } from 'vitest'
import { runChecks } from '../checks'
import { intersects, rectOf } from '../geometry'
import { bedroomTwo, forestsRoom, inch } from '../seeds'

describe("Forest's Room seed", () => {
  const doc = forestsRoom()

  it('converts inches to whole centimetres', () => {
    expect(inch(141)).toBe(358)
    expect(inch(96)).toBe(244)
    expect(doc.room.w).toBe(358)
    expect(doc.room.d).toBe(295)
  })

  it('keeps every placed piece inside the room with no overlaps', () => {
    const placed = doc.items.filter((i) => i.inRoom)
    for (const it of placed) {
      const r = rectOf(it)
      expect(r.x0, it.name).toBeGreaterThanOrEqual(-0.5)
      expect(r.y0, it.name).toBeGreaterThanOrEqual(-0.5)
      expect(r.x1, it.name).toBeLessThanOrEqual(doc.room.w + 0.5)
      expect(r.y1, it.name).toBeLessThanOrEqual(doc.room.d + 0.5)
    }
    for (let a = 0; a < placed.length; a++)
      for (let b = a + 1; b < placed.length; b++)
        expect(intersects(rectOf(placed[a]), rectOf(placed[b])), `${placed[a].name} vs ${placed[b].name}`).toBe(false)
  })

  it('starts with no red checks and the dresser fitting under the window', () => {
    const checks = runChecks(doc.room, doc.items)
    const bad = checks.filter((c) => c.level === 'bad').map((c) => c.text)
    expect(bad).toEqual([])
    expect(checks.some((c) => c.level === 'ok' && /Dresser fits under the window/.test(c.text))).toBe(true)
  })

  it('keeps the reclined recliner parked outside the room', () => {
    const open = doc.items.find((i) => i.id === 'forest-recliner-open')!
    expect(open.inRoom).toBe(false)
    expect(open.d).toBe(inch(64))
  })
})

describe('Bedroom 2 seed', () => {
  const doc = bedroomTwo()
  const placed = doc.items.filter((i) => i.inRoom)

  it('is 11 × 11 ft with an 8 ft ceiling, two 32 in doors, a closet and the 66 in window', () => {
    expect(doc.room.w).toBe(inch(132))
    expect(doc.room.d).toBe(inch(132))
    expect(doc.room.h).toBe(inch(96))
    expect(doc.room.doors.map((d) => d.width)).toEqual([inch(32), inch(32)])
    expect(doc.room.closets).toHaveLength(1)
    expect(doc.room.windows).toEqual([expect.objectContaining({ width: inch(66), height: inch(24), sill: inch(58) })])
  })

  it('keeps every placed piece inside the room with no overlaps', () => {
    for (const it of placed) {
      const r = rectOf(it)
      expect(r.x0, it.name).toBeGreaterThanOrEqual(-0.5)
      expect(r.y0, it.name).toBeGreaterThanOrEqual(-0.5)
      expect(r.x1, it.name).toBeLessThanOrEqual(doc.room.w + 0.5)
      expect(r.y1, it.name).toBeLessThanOrEqual(doc.room.d + 0.5)
    }
    for (let a = 0; a < placed.length; a++)
      for (let b = a + 1; b < placed.length; b++)
        expect(intersects(rectOf(placed[a]), rectOf(placed[b])), `${placed[a].name} vs ${placed[b].name}`).toBe(false)
  })

  it('starts with nothing to warn about', () => {
    expect(runChecks(doc.room, doc.items).filter((c) => c.level !== 'ok').map((c) => c.text)).toEqual([])
  })

  it('keeps the 81 in desk parked outside the room', () => {
    const desk = doc.items.find((i) => i.id === 'b2-desk')!
    expect(desk.inRoom).toBe(false)
    expect(desk.w).toBe(inch(81))
    expect(rectOf(desk).y0).toBeGreaterThan(doc.room.d)
  })
})
