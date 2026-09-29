import { describe, expect, it } from 'vitest'
import { runChecks } from '../checks'
import { defaultRoom } from '../data'
import { doorSwing, fractionInRoom, rectInRoom, roomPolygon, roomWalls, wallFrame, wallLength, wallSpan } from '../geometry'
import { migrateRoom } from '../migrate'
import { sanitizeRoom } from '../store'
import type { Item, Room } from '../types'

/** A 300 × 400 room with its front-right corner cut 60 × 60 (a 45° wall about 85 cm across). */
const cutRoom = (patch: Partial<Room> = {}): Room => ({
  ...defaultRoom, w: 300, d: 400, windows: [], doors: [], radiators: [], closets: [],
  corners: { frontRight: { x: 60, y: 60 } },
  ...patch,
})

describe('cut corners', () => {
  it('turn a 4-wall room into a 5-wall one, going round clockwise', () => {
    const room = cutRoom()
    expect(roomWalls(room)).toEqual(['top', 'right', 'frontRight', 'bottom', 'left'])
    expect(roomPolygon(room)).toEqual([[0, 0], [300, 0], [300, 340], [240, 400], [0, 400]])
    expect(roomWalls({ ...room, corners: { backLeft: { x: 40, y: 40 }, backRight: { x: 40, y: 40 }, frontLeft: { x: 40, y: 40 }, frontRight: { x: 40, y: 40 } } })).toHaveLength(8)
  })

  it('give the angled wall a frame: start at its left end, normal into the room', () => {
    const f = wallFrame(cutRoom(), 'frontRight')
    expect(f.start).toEqual([240, 400])
    expect(f.length).toBeCloseTo(Math.hypot(60, 60))
    expect(f.along[0]).toBeCloseTo(Math.SQRT1_2)
    expect(f.along[1]).toBeCloseTo(-Math.SQRT1_2)
    expect(f.normal[0]).toBeCloseTo(-Math.SQRT1_2)
    expect(f.normal[1]).toBeCloseTo(-Math.SQRT1_2)
  })

  it('shorten the two walls they join', () => {
    const room = cutRoom()
    expect(wallSpan(room, 'bottom')).toEqual([0, 240])
    expect(wallSpan(room, 'right')).toEqual([0, 340])
    expect(wallSpan(room, 'top')).toEqual([0, 300])
  })

  it('are floor outside the room', () => {
    const room = cutRoom()
    expect(rectInRoom(room, { x0: 250, y0: 350, x1: 290, y1: 390 })).toBe(false)
    expect(rectInRoom(room, { x0: 100, y0: 300, x1: 200, y1: 390 })).toBe(true)
    // half of a 60 × 60 box in the corner is cut off
    expect(fractionInRoom(room, { x0: 240, y0: 340, x1: 300, y1: 400 })).toBeCloseTo(0.5)
  })

  it('flag furniture standing in the cut-off corner as going through a wall', () => {
    const room = cutRoom()
    const box: Item = { id: 'b', name: 'Box', kind: 'box', w: 40, d: 40, h: 40, x: 280, y: 380, rot: 0, color: '#ccc', inRoom: true }
    expect(runChecks(room, [box]).some((c) => c.level === 'bad' && c.text === 'Box goes through a wall')).toBe(true)
    expect(runChecks(room, [{ ...box, x: 150, y: 200 }]).some((c) => c.text === 'Box goes through a wall')).toBe(false)
  })

  it('swing a door on the angled wall into the room', () => {
    const room = cutRoom({ doors: [{ id: 'd1', wall: 'frontRight', offset: 2, width: 80, height: 205, sill: 0, hinge: 'left', swing: 'in' }] })
    const s = doorSwing(room, room.doors[0])
    const [lx, ly] = s.leafDir(90)
    // fully open, the leaf points into the room (toward the back-left)
    expect(lx).toBeLessThan(0)
    expect(ly).toBeLessThan(0)
    expect(runChecks(room, []).some((c) => c.text === 'Wide, clear entry into the room')).toBe(true)
  })

  it('keep openings on the wall that is there, and move one off a corner that is squared again', () => {
    const room = sanitizeRoom(cutRoom({
      doors: [{ id: 'd1', wall: 'bottom', offset: 230, width: 80, height: 205, sill: 0, hinge: 'left', swing: 'in' }],
      windows: [{ id: 'w1', wall: 'frontRight', offset: 0, width: 200, height: 100, sill: 90 }],
    }))
    expect(room.doors[0].offset + room.doors[0].width).toBeLessThanOrEqual(240)
    expect(room.windows[0].width).toBeLessThanOrEqual(Math.ceil(wallLength(room, 'frontRight')))
    const squared = sanitizeRoom({ ...room, corners: {} })
    expect(squared.corners).toBeUndefined()
    expect(squared.windows[0].wall).toBe('bottom')
  })

  it('load from saved rooms, dropping cuts that make no sense', () => {
    const room = migrateRoom({ ...cutRoom(), corners: { frontRight: { x: 60, y: 60 }, backLeft: { x: 0, y: 30 }, nowhere: { x: 5, y: 5 } } })
    expect(room.corners).toEqual({ frontRight: { x: 60, y: 60 } })
    expect(migrateRoom({ ...defaultRoom, doors: [{ ...defaultRoom.doors[0], wall: 'backLeft' }] }).doors[0].wall).toBe('top')
  })
})
