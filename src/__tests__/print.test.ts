import { describe, expect, it } from 'vitest'
import { defaultItems, defaultRoom } from '../data'
import { asciiFeetInches, asciiLength, asciiSize, asciiText, checkBar, scaleNote } from '../print/labels'
import { MARGIN, PAPERS, mmPerCm, packPieces, pageSize, pickScale, printableArea } from '../print/layout'
import { buildKitSheets, buildPlanSheets, placeRoom, planScale } from '../print/sheets'
import type { Item, Room } from '../types'

const room358: Room = { ...defaultRoom, name: 'Test room', w: 358, d: 295 }
const items = defaultItems.map((i) => ({ ...i }))

describe('ASCII labels', () => {
  it('writes feet and inches without special glyphs', () => {
    expect(asciiLength(358, 'in', { feet: true })).toBe('11 ft 9 in')
    expect(asciiFeetInches(144)).toBe('12 ft')
    expect(asciiFeetInches(35)).toBe('35 in')
    expect(asciiFeetInches(143.9)).toBe('12 ft')
  })
  it('writes inches to the nearest half', () => {
    expect(asciiLength(136, 'in')).toBe('53.5 in')
    expect(asciiLength(137, 'in')).toBe('54 in')
    expect(asciiLength(137, 'cm')).toBe('137 cm')
    expect(asciiSize(137, 76, 'in')).toBe('54 x 30 in')
    expect(asciiSize(137, 76, 'cm', 89)).toBe('137 x 76 x 89 cm')
  })
  it('has a scale note and a check bar for each unit', () => {
    expect(scaleNote(25, 'in')).toBe('1:25 (1 in on paper = 25 in in the room)')
    expect(checkBar('in')).toEqual({ mm: 101.6, label: '4 in' })
    expect(checkBar('cm')).toEqual({ mm: 100, label: '10 cm' })
  })
  it('turns app glyphs into ASCII', () => {
    expect(asciiText('New bed TUFJORD 140×200')).toBe('New bed TUFJORD 140x200')
    expect(asciiText('11′ 9″ · 6½')).toBe('11\' 9" - 6 1/2')
    for (const ch of asciiText('Émile’s crib')) expect(ch.charCodeAt(0)).toBeLessThan(127)
  })
})

describe('page and scale', () => {
  it('turns portrait for tall rooms and picks the paper size', () => {
    expect(pageSize('letter', 'auto', { w: 358, d: 295 })).toEqual(PAPERS.letter)
    expect(pageSize('letter', 'auto', { w: 270, d: 370 })).toEqual({ w: 215.9, h: 279.4 })
    expect(pageSize('a4', 'landscape', { w: 270, d: 370 })).toEqual(PAPERS.a4)
    expect(pageSize('a4', 'portrait', { w: 358, d: 295 })).toEqual({ w: 210, h: 297 })
    expect(printableArea(PAPERS.a4)).toEqual({ x: MARGIN, y: MARGIN, w: 297 - 2 * MARGIN, h: 210 - 2 * MARGIN })
  })
  it('picks the largest standard scale that fits', () => {
    expect(pickScale(358, 295, 200, 150)).toEqual({ scale: 20, fits: true })
    expect(pickScale(358, 295, 150, 150)).toEqual({ scale: 25, fits: true })
    expect(pickScale(2000, 2000, 100, 100)).toEqual({ scale: 50, fits: false })
  })
  it('fits a 358 x 295 room on Letter at 1:20 or 1:25', () => {
    const scale = planScale(room358, { paper: 'letter', orientation: 'auto' })
    expect([20, 25]).toContain(scale)
    const page = pageSize('letter', 'auto', room358)
    const area = printableArea(page)
    const p = placeRoom(room358, { x: area.x, y: area.y + 15, w: area.w, h: area.h - 24 })
    expect(p.scale).toBe(scale)
    expect(p.fits).toBe(true)
    // the room plus its label margins stays inside the printable area
    expect(p.ox - p.pads.l).toBeGreaterThanOrEqual(area.x - 0.01)
    expect(p.ox + p.W + p.pads.r).toBeLessThanOrEqual(area.x + area.w + 0.01)
    expect(p.oy + p.D + p.pads.b).toBeLessThanOrEqual(area.y + area.h + 0.01)
    // and the next larger drawing would not fit
    const larger = p.scale === 20 ? 15 : 20
    const k = mmPerCm(larger)
    expect(room358.w * k + p.pads.l + p.pads.r > area.w || room358.d * k + p.pads.t + p.pads.b > area.h - 24).toBe(true)
  })
})

describe('cut-out packing', () => {
  const area = { w: 255.4, h: 160 }
  it('keeps every piece inside the area with no overlaps', () => {
    const k = mmPerCm(20)
    const pieces = items.map((it) => ({ id: it.id, w: it.w * k + 2, h: it.d * k + 2 }))
    const packing = packPieces(pieces, area.w, area.h, 5)
    expect(packing.unplaced).toEqual([])
    const placedIds = packing.pages.flat().map((p) => p.id).sort()
    expect(placedIds).toEqual(items.map((i) => i.id).sort())
    for (const page of packing.pages) {
      for (const p of page) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(p.y).toBeGreaterThanOrEqual(0)
        expect(p.x + p.w).toBeLessThanOrEqual(area.w + 0.01)
        expect(p.y + p.h).toBeLessThanOrEqual(area.h + 0.01)
        const src = pieces.find((s) => s.id === p.id)!
        expect([src.w, src.h].sort()).toEqual([p.w, p.h].sort())
      }
      for (let i = 0; i < page.length; i++) {
        for (let j = i + 1; j < page.length; j++) {
          const a = page[i], b = page[j]
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y
          expect(apart, `${a.id} overlaps ${b.id}`).toBe(true)
        }
      }
    }
  })
  it('turns a tall piece to fit a short area and reports pieces too big for any page', () => {
    const packing = packPieces([{ id: 'tall', w: 20, h: 100 }, { id: 'huge', w: 300, h: 300 }], 120, 50)
    expect(packing.unplaced).toEqual(['huge'])
    expect(packing.pages[0][0]).toMatchObject({ id: 'tall', w: 100, h: 20, rotated: true })
  })
  it('spills onto a second page', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: `p${i}`, w: 40, h: 40 }))
    const packing = packPieces(many, 100, 100, 5)
    expect(packing.pages.length).toBeGreaterThan(1)
    expect(packing.pages.flat()).toHaveLength(30)
  })
})

describe('sheets', () => {
  const input = { room: defaultRoom, items, unit: 'in' as const, group: 'Home', date: '24 Sep 2026' }
  it('draws every item name, the openings and the footer on the measured plan', () => {
    const sheets = buildPlanSheets(input, { paper: 'letter', orientation: 'auto' })
    const all = sheets.map((s) => s.svg).join('\n')
    for (const it of items.filter((i) => i.inRoom)) expect(all).toContain(it.name.replace('×', 'x'))
    expect(all).toContain('Window 59 in, sill 35.5 in')
    expect(all).toContain('Door 31.5 in')
    expect(all).toContain('Print at 100% / actual size. Check: this bar is 4 in')
    expect(all).toContain('Scale 1:20 (1 in on paper = 20 in in the room)')
    expect(sheets[0].svg).toContain('page 1 of')
    expect(sheets[0].svg.startsWith('<svg')).toBe(true)
    expect(sheets[0]).toMatchObject({ w: 215.9, h: 279.4 })
    // the legend lists wall distances
    expect(all).toContain('From left wall')
  })
  it('uses cm labels for metric users', () => {
    const sheets = buildPlanSheets({ ...input, unit: 'cm' }, { paper: 'a4', orientation: 'auto' })
    const all = sheets.map((s) => s.svg).join('\n')
    expect(all).toContain('Window 150 cm, sill 90 cm')
    expect(all).toContain('Door 80 cm')
    expect(all).toContain('this bar is 10 cm')
    expect(sheets[0]).toMatchObject({ w: 210, h: 297 })
  })
  it('lists a parked item in the kit but not in the plan, and ends the kit with the empty room', () => {
    const parked: Item[] = items.map((i) => (i.id === 'shelf' ? { ...i, inRoom: false } : i))
    const plan = buildPlanSheets({ ...input, items: parked }, { paper: 'letter', orientation: 'auto' })
    const kit = buildKitSheets({ ...input, items: parked }, { paper: 'letter', orientation: 'auto' })
    expect(plan.map((s) => s.svg).join()).not.toContain('>Shelf<')
    const kitAll = kit.map((s) => s.svg).join('\n')
    expect(kitAll).toContain('>Shelf<')
    expect(kitAll).toContain('not in room yet')
    for (const it of parked) expect(kitAll).toContain(it.name.replace('×', 'x'))
    expect(kit.length).toBeGreaterThanOrEqual(2)
    expect(kit[kit.length - 1].svg).toContain('empty room')
    expect(kit[kit.length - 1].svg).toContain('Window 59 in, sill 35.5 in')
    expect(kit[kit.length - 1].svg).toContain('this bar is 4 in')
  })
  it('keeps text ASCII for the PDF fonts', () => {
    const sheets = buildKitSheets(input, { paper: 'a4', orientation: 'landscape' })
    for (const s of sheets) {
      const texts = [...s.svg.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1])
      expect(texts.length).toBeGreaterThan(0)
      for (const t of texts) expect(t, t).toMatch(/^[\x20-\x7e&;#]*$/)
    }
  })
})

describe('the house plan page', () => {
  it('puts every room of the house on one page, each with its name and furniture', async () => {
    const { buildHouseSheet } = await import('../print')
    const { bedroomTwo, forestsRoom } = await import('../seeds')
    const forest = forestsRoom(), b2 = bedroomTwo()
    const house = { id: 'house-home', name: 'Home', createdAt: '', updatedAt: '', version: 1, rooms: [
      { roomId: forest.id, x: 61, y: 0, rot: 0 as const },
      { roomId: b2.id, x: 500, y: 0, rot: 90 as const },
    ] }
    const sheet = buildHouseSheet({ house, rooms: { [forest.id]: forest, [b2.id]: b2 }, unit: 'in', date: 'Sep 29, 2026' }, { paper: 'letter', orientation: 'auto' })
    expect(sheet.svg).toContain('Home - house plan')
    expect(sheet.svg).toContain("Forest's Room")
    expect(sheet.svg).toContain('Bedroom 2')
    // the second room is drawn turned a quarter
    expect(sheet.svg).toMatch(/rotate\(90\)/)
    // a few of its pieces are labelled
    expect(sheet.svg).toMatch(/Crib|Dresser/)
    expect(sheet.notes).toEqual([])
    expect(sheet.w).toBeGreaterThan(sheet.h) // two rooms side by side: landscape
  })
})
