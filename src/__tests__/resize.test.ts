import { describe, expect, it } from 'vitest'
import { makeEmptyRoom } from '../data'
import { WALL_GAP, toHouse, type HouseDoc, type HouseRoom } from '../house'
import { MIN_ROOM, canResize, clampAmount, resizeRoom, snapResize } from '../resize'
import type { Item, Room, RoomDoc, Wall } from '../types'

const bed: Item = { id: 'bed', name: 'Bed', kind: 'bed', w: 100, d: 200, h: 50, x: 150, y: 200, rot: 0, color: '#ccc', inRoom: true }
const parked: Item = { ...bed, id: 'out', inRoom: false, x: 60, y: 500 }
const docOf = (room: Room): RoomDoc => ({
  id: 'r', name: 'Hall', group: '', notes: '', createdAt: '', updatedAt: '', version: 2, room,
  items: [bed, parked],
  layouts: [{ id: 'l1', name: 'Saved', description: '', placements: { bed: { x: 150, y: 200, rot: 0, inRoom: true } }, items: [bed] }],
  settings: { daytime: true, doorAngle: 70, blinds: 40, bedding: true, walkHeight: 'adult', quality: 'best' },
})
const room = (): Room => ({
  ...makeEmptyRoom('Hall', 300, 400),
  windows: [{ id: 'w1', wall: 'top', offset: 100, width: 100, height: 100, sill: 90 }],
  doors: [{ id: 'd1', wall: 'left', offset: 50, width: 80, height: 205, sill: 0, hinge: 'left', swing: 'in' }],
  closets: [{ id: 'c1', wall: 'bottom', offset: 40, width: 100, depth: 60, doors: 'none', inside: { offset: 20, width: 140 } }],
})

/** Where a room point is on the plan. */
const onPlan = (p: HouseRoom, pt: [number, number]) => toHouse(p, pt).map((v) => Math.round(v))

describe('resizing a room on the house map', () => {
  for (const rot of [0, 90, 180, 270] as const) {
    for (const side of ['left', 'right', 'top', 'bottom'] as Wall[]) {
      it(`moves only the ${side} wall (room turned ${rot}°)`, () => {
        const place: HouseRoom = { roomId: 'r', x: 1000, y: 500, rot }
        const before = docOf(room())
        const r = resizeRoom(before, place, side, 40)
        expect(r.amount).toBe(40)
        const across = side === 'left' || side === 'right'
        expect(r.doc.room.w).toBe(across ? 340 : 300)
        expect(r.doc.room.d).toBe(across ? 400 : 440)
        // the furniture, the openings and the saved layouts stay where they were on the plan
        const bedBefore = onPlan(place, [bed.x, bed.y]), bedAfter = onPlan(r.place, [r.doc.items[0].x, r.doc.items[0].y])
        expect(bedAfter).toEqual(bedBefore)
        const layoutBed = r.doc.layouts[0].placements.bed
        expect(onPlan(r.place, [layoutBed.x, layoutBed.y])).toEqual(bedBefore)
        expect(onPlan(r.place, [r.doc.layouts[0].items![0].x, r.doc.layouts[0].items![0].y])).toEqual(bedBefore)
        const winAt = (d: RoomDoc, p: HouseRoom) => onPlan(p, [d.room.windows[0].offset, 0])
        const doorAt = (d: RoomDoc, p: HouseRoom) => onPlan(p, [0, d.room.doors[0].offset])
        const closetAt = (d: RoomDoc, p: HouseRoom) => [onPlan(p, [d.room.closets[0].offset, d.room.d]), onPlan(p, [d.room.closets[0].inside!.offset, d.room.d])]
        if (side !== 'top') expect(winAt(r.doc, r.place)).toEqual(winAt(before, place))
        if (side !== 'left') expect(doorAt(r.doc, r.place)).toEqual(doorAt(before, place))
        if (side !== 'bottom') expect(closetAt(r.doc, r.place)).toEqual(closetAt(before, place))
        // a parked piece stays parked where it was in the list
        expect(r.doc.items[1]).toEqual(parked)
      })
    }
  }

  it('keeps a room at least MIN_ROOM across, and refuses drawn shapes', () => {
    const bare: Room = { ...room(), windows: [], doors: [], closets: [] }
    const r = resizeRoom(docOf(bare), { roomId: 'r', x: 0, y: 0, rot: 0 }, 'right', -1000)
    expect(r.doc.room.w).toBe(MIN_ROOM)
    expect(clampAmount(room(), 'bottom', 5000)).toBe(1200 - 400)
    const drawn = { ...room(), outline: [[0, 0], [300, 0], [300, 400], [0, 400]] as [number, number][] }
    expect(canResize(drawn)).toBe(false)
    expect(resizeRoom(docOf(drawn), { roomId: 'r', x: 0, y: 0, rot: 0 }, 'right', 50).amount).toBe(0)
  })

  it('snaps the moving wall a wall\'s thickness from a neighbour, or in line with one', () => {
    const a = makeEmptyRoom('A', 300, 400), hall = makeEmptyRoom('Hall', 120, 300)
    const rooms = new Map<string, Room>([['a', a], ['hall', hall]])
    const hallAt: HouseRoom = { roomId: 'hall', x: 500, y: 0, rot: 0 }
    const house: HouseDoc = { id: 'h', name: 'H', createdAt: '', updatedAt: '', version: 1, rooms: [{ roomId: 'a', x: 0, y: 0, rot: 0 }, hallAt] }
    // dragging the hall's left wall out to x 330 (20 past where it should stop): it stops a wall's thickness from room a
    const amount = snapResize(house, rooms, hallAt, hall, 'left', 170)
    expect(500 - amount).toBe(300 + WALL_GAP)
    // the front wall dragged close to room a's front (y 400): in line with it
    expect(300 + snapResize(house, rooms, hallAt, hall, 'bottom', 90)).toBe(400)
    // nothing near: unchanged
    expect(snapResize(house, rooms, hallAt, hall, 'right', 60)).toBe(60)
  })

  it('stops a wall moving in at the first opening on the walls it runs across, so nothing hangs off a wall', () => {
    // the window on the back wall runs 100..200 and the walk-in on the front wall 20..160
    const place: HouseRoom = { roomId: 'r', x: 0, y: 0, rot: 0 }
    expect(resizeRoom(docOf(room()), place, 'right', -1000).doc.room.w).toBe(200)
    const left = resizeRoom(docOf(room()), place, 'left', -1000)
    expect(left.amount).toBe(-20)
    expect(left.doc.room.closets[0].inside!.offset).toBe(0)
    expect(left.doc.room.windows[0].offset).toBe(80)
    // the door on the left wall runs 50..130: the back wall comes down to it, the front up to it
    expect(resizeRoom(docOf(room()), place, 'top', -1000).amount).toBe(-50)
    expect(resizeRoom(docOf(room()), place, 'bottom', -1000).doc.room.d).toBe(130)
    // a new hallway (door on the front wall, 20..100): 100 wide at the least
    const hall: Room = { ...makeEmptyRoom('Hall', 120, 300), windows: [], doors: [{ id: 'd1', wall: 'bottom', offset: 20, width: 80, height: 205, sill: 0, hinge: 'right', swing: 'in' }] }
    expect(resizeRoom(docOf(hall), place, 'right', -1000).doc.room.w).toBe(100)
    expect(resizeRoom(docOf(hall), place, 'left', -1000).doc.room.doors[0].offset).toBe(0)
  })
})
