import { useEffect, useRef, useState } from 'react'
import { FloorPlan } from './components/FloorPlan'
import { HouseMap } from './components/HouseMap'
import { Library } from './components/Library'
import { useHouses } from './houses'
import { PrintDialog, usePrintDialog } from './components/PrintDialog'
import { Scene3D } from './components/Scene3D'
import { Sidebar } from './components/Sidebar'
import { SplitPane, useSplit } from './components/SplitPane'
import { TopBar } from './components/TopBar'
import { useLibrary } from './library'
import { useStore, type OutsideAngle } from './store'
import { useSidebar } from './components/Collapse'
import './components/focus.css'

const ANGLES: { id: OutsideAngle; label: string }[] = [
  { id: 'corner', label: 'Corner' },
  { id: 'above', label: 'Above' },
  { id: 'window', label: 'Window side' },
  { id: 'door', label: 'Door side' },
]

export default function App() {
  const currentId = useLibrary((s) => s.currentId)
  const houseId = useHouses((s) => s.currentId)
  const start = useLibrary((s) => s.start)

  // load the room list (and a shared link, if the URL has one) once, then the houses
  useEffect(() => { void start().then(() => useHouses.getState().refresh()) }, [start])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!useLibrary.getState().currentId) return
      const tag = (e.target as HTMLElement).tagName
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void useLibrary.getState().saveNow()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p') {
        // print the plan, not the app window
        e.preventDefault()
        usePrintDialog.getState().setOpen(true)
        return
      }
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      const st = useStore.getState()
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) st.redo(); else st.undo()
        return
      }
      if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        useSplit.getState().toggleFocus()
        return
      }
      if (e.key === '\\' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        useSidebar.getState().toggle()
        return
      }
      if (e.key === 'Escape') st.select(null)
      if (!st.selectedId) return
      const sel = st.items.find((i) => i.id === st.selectedId)
      if ((e.key === 'l' || e.key === 'L') && !e.metaKey && !e.ctrlKey && !e.altKey) st.toggleLock(st.selectedId)
      // a locked piece stays put: R does nothing to it
      if ((e.key === 'r' || e.key === 'R') && !sel?.locked) st.rotateItem(st.selectedId, e.shiftKey ? -90 : 90)
      if (e.key === 'Delete' || e.key === 'Backspace') st.toggleInRoom(st.selectedId)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // a room open in the planner; else the house map when a house is open; else the library
  if (!currentId) return houseId ? <HouseMap /> : <Library />
  return <Planner />
}

function Planner() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const outsideAngle = useStore((s) => s.outsideAngle)
  const setOutsideAngle = useStore((s) => s.setOutsideAngle)
  const walkTo = useStore((s) => s.walkTo)
  const daytime = useStore((s) => s.daytime)
  const setSetting = useStore((s) => s.setSetting)
  const selectedId = useStore((s) => s.selectedId)
  const selected = useStore((s) => s.items.find((i) => i.id === s.selectedId))
  const rotateItem = useStore((s) => s.rotateItem)
  const toggleInRoom = useStore((s) => s.toggleInRoom)
  const focus = useSplit((s) => s.focus)
  const setFocus = useSplit((s) => s.setFocus)
  const openPrint = usePrintDialog((s) => s.setOpen)
  const sideOpen = useSidebar((s) => s.open)
  const showSide = useSidebar((s) => s.setOpen)

  const plan = (
    <>
      <div className="pane-head">
        <div className="pane-head-row">
          <h4>Floor plan</h4>
          <div className="pane-tools">
            <button className="print-btn" title="Print the plan or save it as a PDF (⌘P)" aria-label="Print / PDF" onClick={() => openPrint(true)}>
              <span aria-hidden="true">⎙</span> Print<span className="print-more"> / PDF</span>
            </button>
            <div className="focus-seg" role="group" aria-label="Focus">
              <span className="focus-label">Focus</span>
              <button className={focus === '2d' ? 'on' : ''} aria-label="Focus 2D" aria-pressed={focus === '2d'} title="Bigger floor plan (F)" onClick={() => setFocus('2d')}>2D</button>
              <button className={focus === '3d' ? 'on' : ''} aria-label="Focus 3D" aria-pressed={focus === '3d'} title="Bigger 3D view (F)" onClick={() => setFocus('3d')}>3D</button>
            </div>
          </div>
        </div>
        <span className="legend" title="Drag items · R rotates · drop below the room to remove">drag items · R rotates · drop below the room to remove</span>
      </div>
      <FloorPlan />
      {selected && (
        <div className="item-toolbar">
          <span>{selected.locked && <span aria-label="Locked" title="Locked in place">🔒 </span>}{selected.name.split(' ').slice(0, 2).join(' ')}</span>
          <button onClick={() => rotateItem(selected.id, -90)} disabled={!!selected.locked} title={selected.locked ? 'Locked' : 'Rotate left'}>↺</button>
          <button onClick={() => rotateItem(selected.id, 90)} disabled={!!selected.locked} title={selected.locked ? 'Locked' : 'Rotate right'}>↻</button>
          <button onClick={() => toggleInRoom(selected.id)} title={selected.inRoom ? 'Take out' : 'Put back'}>{selected.inRoom ? '→' : '←'}</button>
        </div>
      )}
    </>
  )

  const scene = (
    <>
      <div className="scene-controls">
        <div className="seg">
          <button className={view === 'outside' ? 'on' : ''} onClick={() => setView('outside')}>View from outside</button>
          <button className={view === 'walk' ? 'on' : ''} onClick={() => walkTo('door')}>Walk through the room</button>
        </div>
        <div className="seg sub">
          {view === 'outside' ? (
            ANGLES.map((a) => (
              <button key={a.id} className={outsideAngle === a.id ? 'on' : ''} onClick={() => setOutsideAngle(a.id)}>{a.label}</button>
            ))
          ) : (
            <>
              <button onClick={() => walkTo('door')}>From the door</button>
              <button onClick={() => walkTo('window')}>From the window</button>
            </>
          )}
        </div>
      </div>
      <div className="seg daynight">
        <button className={daytime ? 'on' : ''} onClick={() => setSetting('daytime', true)}>☀ Day</button>
        <button className={!daytime ? 'on' : ''} onClick={() => setSetting('daytime', false)}>☾ Evening</button>
      </div>
      {view === 'walk' && <SceneHint kind="walk">Drag to look around · W A S D or arrows to move</SceneHint>}
      {view === 'outside' && !selectedId && <SceneHint kind="orbit">Drag to orbit · scroll to zoom · click furniture to select, drag to move</SceneHint>}
      <Scene3D />
    </>
  )

  return (
    <div className="app">
      <TopBar />
      <main className={`main${sideOpen ? '' : ' side-closed'}`}>
        <SplitPane leftClassName="pane plan-pane" rightClassName="pane scene-pane" left={plan} right={scene} />
        <div className="side" aria-hidden={!sideOpen} inert={!sideOpen}>
          <Sidebar />
        </div>
        {!sideOpen && (
          <button type="button" className="side-tab" onClick={() => showSide(true)} title="Show the side panel (\)" aria-label="Show the side panel">
            <span className="side-tab-chev" aria-hidden="true">‹</span>
            <span className="side-tab-text">Settings</span>
          </button>
        )}
      </main>
      <PrintDialog />
    </div>
  )
}

/* ---------- one-time hints over the 3D view ---------- */

/** localStorage flag per hint: set after the first interaction, so the pill never comes back. */
const HINT_KEYS = { orbit: 'room-planner.hint.orbit', walk: 'room-planner.hint.walk' } as const
const WALK_KEYS = new Set(['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright'])
const HINT_FADE_MS = 450

function hintSeen(key: string) {
  try { return localStorage.getItem(key) === '1' } catch { return false }
}

/**
 * The "Drag to orbit…" / "Drag to look around…" pill: shown until the first pointer interaction
 * on the canvas (or, for walking, the first movement key), then faded out and remembered.
 */
function SceneHint({ kind, children }: { kind: keyof typeof HINT_KEYS; children: React.ReactNode }) {
  const key = HINT_KEYS[kind]
  const [seen, setSeen] = useState(() => hintSeen(key))
  const [fading, setFading] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (seen || fading) return
    const el = ref.current
    if (!el) return
    // the canvas sits beside the pill inside the scene pane
    const target: HTMLElement = el.parentElement?.querySelector('canvas') ?? el.parentElement ?? el
    const done = () => {
      try { localStorage.setItem(key, '1') } catch { /* private mode: the hint just comes back next time */ }
      setFading(true)
    }
    const onKey = (e: KeyboardEvent) => { if (kind === 'walk' && WALK_KEYS.has(e.key.toLowerCase())) done() }
    target.addEventListener('pointerdown', done)
    window.addEventListener('keydown', onKey)
    return () => {
      target.removeEventListener('pointerdown', done)
      window.removeEventListener('keydown', onKey)
    }
  }, [seen, fading, key, kind])

  // once faded out, take the pill out of the page
  useEffect(() => {
    if (!fading) return
    const timer = setTimeout(() => setSeen(true), HINT_FADE_MS)
    return () => clearTimeout(timer)
  }, [fading])

  if (seen) return null
  return (
    <div ref={ref} className="walk-hint" style={{ opacity: fading ? 0 : 1, transition: `opacity ${HINT_FADE_MS}ms ease` }} aria-hidden={fading}>
      {children}
    </div>
  )
}
