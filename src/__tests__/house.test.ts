import { describe, expect, it } from 'vitest'
import { defaultRoom } from '../data'
import { houseBounds, houseRot, itemOnPlan, migrateHouse, roomAt, roomOnPlan, toHouse, toRoom, type HouseDoc, type HouseRoom } from '../house'
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
