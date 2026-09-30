import { wallFrame } from './geometry'
import { connections, toHouse, toRoom, type Connection } from './house'
import { useHouses } from './houses'
import { useLibrary } from './library'
import { freeWalkPose, useStore } from './store'

/*
 * Walking from room to room: in walk mode, stepping into a door that is connected to another room's
 * door (see connections in src/house.ts) opens that room and carries on walking, just inside its
 * door, facing in. Only when the room was opened from a house, whose map knows where rooms meet.
 */

/** The doors of this room that lead into another room of the house on screen. */
export function connectedDoors(roomId: string): { doorId: string; to: Connection['b'] }[] {
  const st = useHouses.getState()
  const house = st.houses.find((h) => h.id === st.currentId)
  if (!house) return []
  return connections(house, st.rooms).flatMap((c) => {
    if (c.a.roomId === roomId) return [{ doorId: c.a.doorId, to: c.b }]
    if (c.b.roomId === roomId) return [{ doorId: c.b.doorId, to: c.a }]
    return []
  })
}

/** How far inside the next room's door you come out (cm). */
const STEP_IN = 45

let walking = false

/** Go through `doorId` of room `fromRoomId` into the room it connects to; resolves true when it did. */
export async function walkThrough(fromRoomId: string, doorId: string): Promise<boolean> {
  if (walking) return false
  const link = connectedDoors(fromRoomId).find((d) => d.doorId === doorId)
  const st = useHouses.getState()
  const house = st.houses.find((h) => h.id === st.currentId)
  const target = link && house?.rooms.find((p) => p.roomId === link.to.roomId)
  const targetDoc = link && st.rooms[link.to.roomId]
  const door = targetDoc?.room.doors.find((d) => d.id === link!.to.doorId)
  if (!link || !target || !targetDoc || !door) return false
  walking = true
  try {
    // just inside the far door, in the middle of it, facing into the room
    const f = wallFrame(targetDoc.room, door.wall)
    const mid = door.offset + door.width / 2
    const inRoom: [number, number] = [f.start[0] + f.along[0] * mid + f.normal[0] * STEP_IN, f.start[1] + f.along[1] * mid + f.normal[1] * STEP_IN]
    // (round trip through the house plan: the same point, but it keeps the two rooms' frames honest)
    const [x, y] = toRoom(target, toHouse(target, inRoom))
    const yaw = Math.atan2(0 - f.normal[0], 0 - f.normal[1])
    await useLibrary.getState().open(link.to.roomId)
    if (useLibrary.getState().currentId !== link.to.roomId) return false
    const s = useStore.getState()
    useStore.setState({ view: 'walk', walkPose: freeWalkPose(s.room, s.items, { x, y, yaw, pitch: s.walkPose.pitch }) })
    return true
  } finally {
    walking = false
  }
}
