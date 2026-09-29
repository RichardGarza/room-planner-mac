import { useStore } from '../store'
import { wallLength } from '../geometry'
import type { Closet } from '../types'
import { LengthInput } from './LengthInput'
import { WallSelect } from './WallSelect'

const DOORS: { id: Closet['doors']; label: string }[] = [
  { id: 'none', label: 'No doors' },
  { id: 'hinged', label: 'Hinged' },
  { id: 'bifold', label: 'Bi-fold' },
  { id: 'sliding', label: 'Sliding' },
]

/**
 * The "Closets" section of the Room card: one row per closet (wall, position along it, width,
 * depth of the recess and the kind of doors) and a button to add one. Lengths use LengthInput,
 * so they read and accept the chosen unit.
 */
export function ClosetRows() {
  const closets = useStore((s) => s.room.closets ?? [])
  const room = useStore((s) => s.room)
  const addOpening = useStore((s) => s.addOpening)
  const updateOpening = useStore((s) => s.updateOpening)
  const removeOpening = useStore((s) => s.removeOpening)
  return (
    <>
      <h5>Closets</h5>
      {closets.length === 0 && <p className="muted small">No closets.</p>}
      {closets.map((c, i) => {
        const label = closets.length > 1 ? `Closet ${i + 1}` : 'Closet'
        const patch = (p: Partial<Closet>) => updateOpening('closet', c.id, p)
        const wallLen = wallLength(room, c.wall)
        return (
          <div key={c.id} className="closet-row">
            <h5 style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              {label}
              <button className="x" onClick={() => removeOpening('closet', c.id)} title={`Remove ${label.toLowerCase()}`} aria-label={`Remove ${label.toLowerCase()}`}>×</button>
            </h5>
            <div className="dims-grid four">
              <WallSelect value={c.wall} onChange={(wall) => patch({ wall })} />
              <label>From corner<LengthInput value={c.offset} min={0} max={wallLen} onCommit={(offset) => patch({ offset })} /></label>
              <label>Width<LengthInput value={c.width} min={40} max={wallLen} onCommit={(width) => patch({ width })} /></label>
              <label>Depth<LengthInput value={c.depth} min={30} max={120} onCommit={(depth) => patch({ depth })} /></label>
              <label>
                Doors
                <select value={c.doors} onChange={(e) => patch({ doors: e.target.value as Closet['doors'] })}>
                  {DOORS.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
                </select>
              </label>
            </div>
          </div>
        )
      })}
      <div className="row"><button className="chip ghost" onClick={() => addOpening('closet')}>+ Add closet</button></div>
      <p className="muted small">The recess sits behind the wall. Hinged and bi-fold doors need free floor in front of them; sliding doors and an open closet only need room to reach in.</p>
    </>
  )
}
