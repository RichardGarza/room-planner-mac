import { describe, expect, it } from 'vitest'
import { defaultRoom } from '../data'
import { SNAP, WALL_GAP, floorsOverlap, houseBounds, houseRot, itemOnPlan, migrateHouse, roomAt, roomOnPlan, snapPlacement, toHouse, toRoom, type HouseDoc, type HouseRoom } from '../house'
import type { Item, Room } from '../types'

const room = (w: number, d: number): Room => ({ ...defaultRoom, w, d, windows: [], doors: [], radiators: [], closets: [] })
const house = (rooms: HouseRoom[]): HouseDoc => ({ id: 'house-t', name: 'T', createdAt: '', updatedAt: '', version: 1, rooms })

describe('house plan', () => {
  it('turns room points onto the house plan and back, for every quarter turn', () => {
    for (const rot of [0, 90, 180, 270] as const) {
      const p = { x: 500, y: 200, rot }
      for (const pt of [[0, 0], [300, 0], [300, 400], [37, 91]] as [number, number][]) {
        expect(toRoom(p, toHouse(p, pt))).toEqual(pt)
      }
    }
    // a quarter turn clockwise: the room's x axis points down the plan
    expect(toHouse({ x: 0, y: 0, rot: 90 }, [100, 0])).toEqual([0, 100])
    expect(toHouse({ x: 0, y: 0, rot: 90 }, [0, 100])).toEqual([-100, 0])
  })

  it('turns furniture with its room', () => {
    expect(houseRot({ rot: 90 }, 270)).toBe(0)
    expect(houseRot({ rot: 180 }, 90)).toBe(270)
    const bed: Item = { id: 'b', name: 'Bed', kind: 'bed', w: 100, d: 200, h: 50, x: 50, y: 100, rot: 0, color: '#ccc', inRoom: true }
    const pts = itemOnPlan(bed, { roomId: 'r', x: 1000, y: 0, rot: 90 })
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
    // 200 long along the plan's x after a quarter turn
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(200)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(100)
  })

  it('finds the box around the placed rooms and which room a point is in', () => {
    const rooms = new Map([['a', room(300, 400)], ['b', room(200, 200)]])
    const h = house([{ roomId: 'a', x: 0, y: 0, rot: 0 }, { roomId: 'b', x: 312, y: 0, rot: 0 }, { roomId: 'gone', x: 900, y: 900, rot: 0 }])
    expect(houseBounds(h, rooms)).toEqual({ x0: 0, y0: 0, x1: 512, y1: 400 })
    expect(roomAt(h, rooms, [100, 100])?.roomId).toBe('a')
    expect(roomAt(h, rooms, [400, 100])?.roomId).toBe('b')
    expect(roomAt(h, rooms, [306, 100])).toBeNull() // in the wall between them
    expect(roomOnPlan(room(300, 400), { roomId: 'a', x: 0, y: 0, rot: 180 })).toEqual([[0, 0], [-300, 0], [-300, -400], [0, -400]])
  })

  it('loads saved houses safely', () => {
    expect(migrateHouse(null)).toBeNull()
    expect(migrateHouse({ id: 'h', rooms: 'x' })).toBeNull()
    const h = migrateHouse({ id: 'h', rooms: [{ roomId: 'a', x: 1, y: 2, rot: 45 }, { roomId: 'a', x: 5, y: 5, rot: 0 }, { roomId: 'b', x: 'no', y: 0 }, { roomId: 'c', x: 3, y: 4, rot: 270 }] })!
    expect(h.name).toBe('House')
    expect(h.rooms).toEqual([{ roomId: 'a', x: 1, y: 2, rot: 0 }, { roomId: 'c', x: 3, y: 4, rot: 270 }])
  })
})

describe('arranging: snapping walls together', () => {
  // a 300 × 400 room at the origin; a 200 × 200 room being moved around it
  const rooms = new Map([['a', room(300, 400)], ['b', room(200, 200)]])
  const h = (b: Partial<HouseRoom>) => house([{ roomId: 'a', x: 0, y: 0, rot: 0 }, { roomId: 'b', x: 0, y: 0, rot: 0, ...b }])
  const snapB = (x: number, y: number, rot: HouseRoom['rot'] = 0) => {
    const hh = h({ x, y, rot })
    return snapPlacement(hh, rooms, hh.rooms[1])
  }

  it("snaps a wall dropped near another room's wall a wall's thickness away", () => {
    // dropped 20 cm too far right: back to 300 + WALL_GAP
    const r = snapB(300 + WALL_GAP + 20, 100)
    expect(r.place.x).toBe(300 + WALL_GAP)
    expect(r.snapped.x).toBe(true)
    // and from the other side, overlapping a little
    expect(snapB(-200 - WALL_GAP + 15, 100).place.x).toBe(-200 - WALL_GAP)
  })

  it('lines outside walls up', () => {
    // right of room a, its top 18 cm below a's top: the tops line up
    const r = snapB(300 + WALL_GAP, 18)
    expect(r.place.y).toBe(0)
    expect(r.snapped.y).toBe(true)
  })

  it('leaves a room alone when nothing is near', () => {
    const r = snapB(300 + WALL_GAP + SNAP + 40, 150)
    expect(r.place).toMatchObject({ x: 300 + WALL_GAP + SNAP + 40, y: 150 })
    expect(r.snapped).toEqual({ x: false, y: false })
  })

  it('snaps turned rooms by their walls on the plan', () => {
    // turned a quarter, room b spans x from x - 200 to x: its left wall is at x - 200
    const r = snapB(300 + WALL_GAP + 200 + 10, 100, 90)
    expect(r.place.x).toBe(300 + WALL_GAP + 200)
  })

  it('tells overlapping floors from neighbours', () => {
    const A = roomOnPlan(room(300, 400), { roomId: 'a', x: 0, y: 0, rot: 0 })
    const next = roomOnPlan(room(200, 200), { roomId: 'b', x: 300 + WALL_GAP, y: 0, rot: 0 })
    const touching = roomOnPlan(room(200, 200), { roomId: 'b', x: 300, y: 0, rot: 0 })
    const over = roomOnPlan(room(200, 200), { roomId: 'b', x: 250, y: 50, rot: 0 })
    expect(floorsOverlap(A, next)).toBe(false)
    expect(floorsOverlap(A, touching)).toBe(false)
    expect(floorsOverlap(A, over)).toBe(true)
  })
})
