import { describe, expect, it } from 'vitest'
import { runChecks } from '../checks'
import { defaultRoom } from '../data'
import { doorSwing, fractionInRoom, rectInRoom, roomPolygon, roomWalls, wallFrame, wallLength, wallPoint } from '../geometry'
import { migrateRoom } from '../migrate'
import { normalizeOutline, outlineFromWalls, wallsFromOutline, withOutline } from '../outline'
import { sanitizeRoom } from '../store'
import type { Item, Room } from '../types'

/** An L-shaped room: 400 wide at the front, the back-right 200 × 150 missing. */
const L: [number, number][] = [[0, 0], [200, 0], [200, 150], [400, 150], [400, 400], [0, 400]]
const lRoom = (patch: Partial<Room> = {}): Room => ({
  ...defaultRoom, w: 400, d: 400, outline: L, windows: [], doors: [], radiators: [], closets: [], ...patch,
})
const box = (x: number, y: number, w = 40, d = 40): Item => ({ id: 'b', name: 'Box', kind: 'box', w, d, h: 40, x, y, rot: 0, color: '#ccc', inRoom: true })

describe('drawn rooms', () => {
  it('have one wall per outline point, going round clockwise', () => {
    const room = lRoom()
    expect(roomWalls(room)).toEqual(['e0', 'e1', 'e2', 'e3', 'e4', 'e5'])
    expect(roomPolygon(room)).toEqual(L)
    expect(wallLength(room, 'e2')).toBe(200)
    // wall 2 runs down from the notch; the room is on its left (west), so the normal points there
    const f = wallFrame(room, 'e1')
    expect(f.start).toEqual([200, 0])
    expect(f.along).toEqual([0, 1])
    expect(f.normal[0]).toBeCloseTo(-1)
    expect(f.normal[1]).toBeCloseTo(0)
  })

  it('know which floor is theirs, notch included', () => {
    const room = lRoom()
    expect(rectInRoom(room, { x0: 250, y0: 20, x1: 350, y1: 120 })).toBe(false) // in the missing corner
    expect(rectInRoom(room, { x0: 150, y0: 100, x1: 250, y1: 200 })).toBe(false) // across the inside corner
    expect(rectInRoom(room, { x0: 20, y0: 20, x1: 180, y1: 380 })).toBe(true)
    // 100 × 100 of floor left of the notch, 100 × 50 below it, out of 200 × 100
    expect(fractionInRoom(room, { x0: 100, y0: 100, x1: 300, y1: 200 })).toBeCloseTo((100 * 100 + 100 * 50) / (200 * 100))
  })

  it('flag furniture standing where there is no floor as going through a wall', () => {
    const room = lRoom()
    expect(runChecks(room, [box(300, 60)]).some((c) => c.level === 'bad' && c.text === 'Box goes through a wall')).toBe(true)
    expect(runChecks(room, [box(200, 150)]).some((c) => c.text === 'Box goes through a wall')).toBe(true)
    expect(runChecks(room, [box(100, 300)]).some((c) => c.text === 'Box goes through a wall')).toBe(false)
  })

  it('swing a door on any wall into the room', () => {
    // a door on the inside wall of the notch (wall 3, running east along y = 150)
    const room = lRoom({ doors: [{ id: 'd1', wall: 'e2', offset: 60, width: 80, height: 205, sill: 0, hinge: 'left', swing: 'in' }] })
    const [lx, ly] = doorSwing(room, room.doors[0]).leafDir(90)
    expect(lx).toBeCloseTo(0)
    expect(ly).toBeCloseTo(1) // into the room, toward the front
    expect(runChecks(room, []).some((c) => c.text === 'Wide, clear entry into the room')).toBe(true)
  })
})

describe('walls from lengths and angles', () => {
  it('reads an outline back as lengths and inside angles', () => {
    const spec = wallsFromOutline(L)
    expect(spec.lengths).toEqual([200, 150, 200, 250, 400, 400])
    expect(spec.angles.map(Math.round)).toEqual([90, 270, 90, 90, 90, 90])
  })

  it('closes the shape with the wall you pick, keeping every other length and angle', () => {
    const spec = wallsFromOutline(L)
    // wall 5 (the front) made 20 cm shorter: the left wall, worked out, leans in to meet it
    const edited = { ...spec, lengths: spec.lengths.map((l, i) => (i === 4 ? 380 : l)) }
    const out = outlineFromWalls(edited, 5)
    if ('error' in out) throw new Error(out.error)
    const back = wallsFromOutline(out.points)
    expect(back.lengths.slice(0, 5).map(Math.round)).toEqual([200, 150, 200, 250, 380])
    expect(back.angles.slice(0, 4).map(Math.round)).toEqual([90, 270, 90, 90])
    expect(out.closing.length).toBeCloseTo(Math.hypot(20, 400))
  })

  it('reproduces a rectangle exactly with the last wall worked out', () => {
    const out = outlineFromWalls({ lengths: [300, 400, 300, 999], angles: [90, 90, 90, 90], headings: [0, 90, 180, 270] }, 3)
    if ('error' in out) throw new Error(out.error)
    expect(out.closing.length).toBeCloseTo(400)
    expect(out.closing.angleBefore).toBeCloseTo(90)
    expect(out.closing.angleAfter).toBeCloseTo(90)
    expect(normalizeOutline(out.points)).toEqual({ points: [[0, 0], [300, 0], [300, 400], [0, 400]] })
  })

  it('refuses walls that cross or cannot close', () => {
    expect('error' in outlineFromWalls({ lengths: [300, 400, 300, 0], angles: [270, 270, 90, 90], headings: [0, 0, 0, 0] }, 3)).toBe(true)
    expect('error' in outlineFromWalls({ lengths: [300, 0], angles: [90, 90], headings: [0, 90] }, 1)).toBe(true)
    // a bow tie
    expect('error' in normalizeOutline([[0, 0], [100, 100], [100, 0], [0, 100]])).toBe(true)
  })

  it('tidies a drawn outline: clockwise, no straight-through corners, from (0, 0)', () => {
    const anticlockwise: [number, number][] = [[50, 50], [50, 250], [150, 250], [250, 250], [250, 50]]
    expect(normalizeOutline(anticlockwise)).toEqual({ points: [[0, 0], [200, 0], [200, 200], [0, 200]] })
  })
})

describe('changing shape', () => {
  it('keeps doors and windows where they are when a plain room gets drawn walls', () => {
    const plain: Room = {
      ...defaultRoom, w: 300, d: 400, radiators: [], closets: [],
      windows: [{ id: 'w1', wall: 'top', offset: 100, width: 100, height: 120, sill: 90 }],
      doors: [{ id: 'd1', wall: 'bottom', offset: 20, width: 80, height: 205, sill: 0, hinge: 'left', swing: 'in' }],
    }
    // the same box, with the front-right corner cut off
    const drawn = sanitizeRoom(withOutline(plain, [[0, 0], [300, 0], [300, 340], [240, 400], [0, 400]]))
    const win = drawn.windows[0], door = drawn.doors[0]
    expect(win.wall).toBe('e0')
    expect(wallPoint(drawn, win.wall, win.offset)).toEqual([100, 0])
    expect(door.wall).toBe('e3') // the front wall, which now runs right to left
    const ends = [wallPoint(drawn, door.wall, door.offset), wallPoint(drawn, door.wall, door.offset + door.width)]
    expect(ends.map((p) => p[0]).sort((a, b) => a - b)).toEqual([20, 100])
    // the hinge stays by the left corner: on a wall running the other way it is the far end
    expect(door.hinge).toBe('right')
    const plainHinge = doorSwing({ ...plain }, plain.doors[0])
    const drawnHinge = doorSwing(drawn, door)
    expect([drawnHinge.hx, drawnHinge.hy]).toEqual([plainHinge.hx, plainHinge.hy])
  })

  it('keeps openings on their numbered wall when a drawn room is edited', () => {
    const room = sanitizeRoom(lRoom({ doors: [{ id: 'd1', wall: 'e4', offset: 300, width: 80, height: 205, sill: 0, hinge: 'left', swing: 'in' }] }))
    // the front wall gets shorter than the door's offset: the door stays on it, pulled back
    const edited = sanitizeRoom(withOutline(room, [[0, 0], [200, 0], [200, 150], [300, 150], [300, 400], [0, 400]]))
    expect(edited.doors[0].wall).toBe('e4')
    expect(edited.doors[0].offset + edited.doors[0].width).toBeLessThanOrEqual(wallLength(edited, 'e4'))
  })

  it('loads a room saved with the angled corners of the earlier version as a drawn room', () => {
    const room = migrateRoom({
      ...defaultRoom, w: 300, d: 400, windows: [], radiators: [], closets: [],
      corners: { frontRight: { x: 60, y: 60 } },
      // on the old angled wall, which ran from its front-wall end up to its right-wall end
      doors: [{ id: 'd1', wall: 'frontRight', offset: 2, width: 80, height: 205, sill: 0, hinge: 'right', swing: 'in' }],
    })
    expect(room.outline).toEqual([[0, 0], [300, 0], [300, 340], [240, 400], [0, 400]])
    const door = room.doors[0]
    expect(door.wall).toBe('e2')
    // the hinge is still at the end by the right wall
    const s = doorSwing(room, door)
    expect(s.hx).toBeGreaterThan(280)
    expect(s.hy).toBeLessThan(360)
  })

  it('drops a saved outline that is not a room', () => {
    expect(migrateRoom({ ...defaultRoom, outline: [[0, 0], [10, 10]] }).outline).toBeUndefined()
    expect(migrateRoom({ ...defaultRoom, outline: 'square' }).outline).toBeUndefined()
  })
})
