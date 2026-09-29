import { roomWalls, wallName } from '../geometry'
import { useStore } from '../store'
import type { AnyWall } from '../types'

/** Picks one of the room's walls: back, front, left, right, or Wall 1 … Wall n of a drawn room. */
export function WallSelect({ value, onChange }: { value: AnyWall; onChange: (w: AnyWall) => void }) {
  const room = useStore((s) => s.room)
  return (
    <label>
      Wall
      <select value={value} onChange={(e) => onChange(e.target.value as AnyWall)}>
        {roomWalls(room).map((w) => <option key={w} value={w}>{wallName(w)}</option>)}
      </select>
    </label>
  )
}
