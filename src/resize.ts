import { toHouse, levelOf, roomOnPlan, SNAP, WALL_GAP, type HouseDoc, type HouseRoom } from './house'
import type { Item, Layout, Room, RoomDoc, Wall } from './types'

/*
 * Resizing a room on the house map by dragging one of its walls. Only plain rooms (a rectangle, no
 * drawn outline: a hallway, say) can be resized this way; a drawn shape has the wall editor.
 *
 * `side` is the wall being moved, in the room's own terms (top = its back wall), and `amount` how far
 * it moves out (cm; negative moves it in). The opposite wall stays where it is on the house plan, and
 * so does everything in the room: its furniture, doors, windows, closets and saved layouts.
 */

/** The narrowest a room can be (cm): a hallway or a walk-in, not a bookcase. */
export const MIN_ROOM = 60
export const MAX_ROOM = 1200

export function canResize(room: Room): boolean {
  return !room.outline
}

/** How far the wall may move: the room stays between MIN_ROOM and MAX_ROOM across. */
export function clampAmount(room: Room, side: Wall, amount: number): number {
  const size = side === 'left' || side === 'right' ? room.w : room.d
  return Math.round(Math.min(MAX_ROOM - size, Math.max(MIN_ROOM - size, amount)))
}

/**
 * The room and its place in the house with `side` moved out by `amount` (clamped). Moving the back
 * or left wall moves the room's own origin, so its contents shift the other way in the room's
 * coordinates and the place moves to match: nothing moves on the plan but that wall.
 */
export function resizeRoom(doc: RoomDoc, place: HouseRoom, side: Wall, amount: number): { doc: RoomDoc; place: HouseRoom; amount: number } {
  if (!canResize(doc.room)) return { doc, place, amount: 0 }
  const a = clampAmount(doc.room, side, amount)
  if (!a) return { doc, place, amount: 0 }
  const across = side === 'left' || side === 'right'
  const room: Room = { ...doc.room, w: across ? doc.room.w + a : doc.room.w, d: across ? doc.room.d : doc.room.d + a }
  // the far walls (right, front) just grow; the near ones (left, back) move the origin by -a
  if (side === 'right' || side === 'bottom') return { doc: { ...doc, room }, place, amount: a }
  const dx = side === 'left' ? a : 0, dy = side === 'top' ? a : 0
  // openings run along the walls across the move: left moves shift the back and front walls' openings
  const along = (w: string) => (side === 'left' ? w === 'top' || w === 'bottom' : w === 'left' || w === 'right')
  const shift = <T extends { wall: string; offset: number }>(o: T): T => (along(o.wall) ? { ...o, offset: o.offset + a } : o)
  const moveItem = <T extends Pick<Item, 'x' | 'y' | 'inRoom'>>(it: T): T => (it.inRoom ? { ...it, x: it.x + dx, y: it.y + dy } : it)
  const moved: Room = {
    ...room,
    windows: room.windows.map(shift),
    doors: room.doors.map(shift),
    radiators: room.radiators.map(shift),
    closets: (room.closets ?? []).map((c) => {
      const next = shift(c)
      return c.inside && along(c.wall) ? { ...next, inside: { ...c.inside, offset: c.inside.offset + a } } : next
    }),
  }
  const layouts: Layout[] = doc.layouts.map((l) => ({
    ...l,
    placements: Object.fromEntries(Object.entries(l.placements).map(([id, p]) => [id, moveItem(p)])),
    ...(l.items ? { items: l.items.map(moveItem) } : {}),
  }))
  // the new origin: where the old room's (-dx, -dy) was on the plan
  const [x, y] = toHouse(place, [-dx, -dy])
  return {
    doc: { ...doc, room: moved, items: doc.items.map(moveItem), layouts },
    place: { ...place, x, y },
    amount: a,
  }
}

/** A side's outward direction on the house plan (the room turned with its place). */
export function outward(place: HouseRoom, side: Wall): [number, number] {
  const local: Record<Wall, [number, number]> = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
  return toHouse({ x: 0, y: 0, rot: place.rot }, local[side])
}

/**
 * The amount that lands the moving wall on a snap: a wall's thickness from another room's wall
 * facing it (where the two run alongside), or in line with a wall facing the same way. Rooms on
 * other floors are ignored. Returns `amount` unchanged when nothing is within SNAP.
 */
export function snapResize(house: HouseDoc, rooms: Map<string, Room>, place: HouseRoom, room: Room, side: Wall, amount: number, snap = SNAP): number {
  const out = outward(place, side)
  const horizontal = Math.abs(out[0]) > 0.5 // the wall runs down the plan and moves across it
  const k = horizontal ? 0 : 1
  // where the moving wall ends up, and the stretch it covers along the other axis
  const moved = roomOnPlan({ ...room, ...(side === 'left' || side === 'right' ? { w: room.w + amount } : { d: room.d + amount }) },
    side === 'left' || side === 'top' ? { ...place, ...xy(toHouse(place, side === 'left' ? [-amount, 0] : [0, -amount])) } : place)
  const coords = moved.map((p) => p[k])
  const wallAt = out[k] > 0 ? Math.max(...coords) : Math.min(...coords)
  const span: [number, number] = [Math.min(...moved.map((p) => p[1 - k])), Math.max(...moved.map((p) => p[1 - k]))]
  let best: number | null = null
  for (const other of house.rooms) {
    if (other.roomId === place.roomId || levelOf(other) !== levelOf(place)) continue
    const r = rooms.get(other.roomId)
    if (!r) continue
    const pts = roomOnPlan(r, other)
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length]
      if (Math.abs(a[k] - b[k]) > 0.01) continue // not a wall at right angles to the move
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
      // clockwise on the plan: outside is to the left of travel
      const otherOut = [(b[1] - a[1]) / len, -(b[0] - a[0]) / len][k]
      const at = a[k]
      let target: number
      if (otherOut * out[k] < 0) {
        const theirs: [number, number] = [Math.min(a[1 - k], b[1 - k]), Math.max(a[1 - k], b[1 - k])]
        if (Math.min(span[1], theirs[1]) - Math.max(span[0], theirs[0]) <= 0) continue
        target = at - Math.sign(out[k]) * WALL_GAP
      } else target = at
      const diff = (target - wallAt) * Math.sign(out[k])
      if (Math.abs(diff) <= snap && (best === null || Math.abs(diff) < Math.abs(best))) best = diff
    }
  }
  return best === null ? amount : amount + best
}

const xy = ([x, y]: [number, number]) => ({ x, y })
