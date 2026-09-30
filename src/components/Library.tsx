import { plannerTitle, useOwner } from '../owner'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useHouses } from '../houses'
import './house.css'
import { HouseThumb } from './HouseThumb'
import { getStorage } from '../storage'
import { defaultRoomSize, timeAgo, useLibrary, type StartWith } from '../library'
import { migrateDoc } from '../migrate'
import type { Item, Room, RoomDoc, RoomSummary } from '../types'
import { formatRoomSize, useUnits } from '../units'
import { LengthInput, UnitToggle } from './LengthInput'
import { PlanThumb } from './PlanThumb'

const NO_GROUP = 'No group'
/** how long the saved-room cards glow after "Open an existing room" */
const FLASH_MS = 1600

/** Home screen: two big ways in (new room / existing room), then every saved room, grouped. */
export function Library() {
  const houses = useHouses((s) => s.houses)
  const openHouse = useHouses((s) => s.open)
  const rooms = useLibrary((s) => s.rooms)
  const groups = useLibrary((s) => s.groups)
  const status = useLibrary((s) => s.status)
  const error = useLibrary((s) => s.error)
  const location = useLibrary((s) => s.location)
  const importDoc = useLibrary((s) => s.importDoc)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [flash, setFlash] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (flashTimer.current) clearTimeout(flashTimer.current) }, [])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rooms
    return rooms.filter((r) => r.name.toLowerCase().includes(q) || r.group.toLowerCase().includes(q))
  }, [rooms, query])

  const sections = useMemo(() => {
    const byGroup = new Map<string, RoomSummary[]>()
    for (const r of filtered) {
      const key = r.group || NO_GROUP
      byGroup.set(key, [...(byGroup.get(key) ?? []), r])
    }
    const names = [...byGroup.keys()].filter((g) => g !== NO_GROUP).sort((a, b) => a.localeCompare(b))
    if (byGroup.has(NO_GROUP)) names.push(NO_GROUP)
    return names.map((g) => ({
      name: g,
      rooms: (byGroup.get(g) ?? []).slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }))
  }, [filtered])

  const loading = status === 'loading' && rooms.length === 0

  /** "Open an existing room": show the list, glow the cards for a moment, focus the first one. */
  const showExisting = () => {
    setCreating(false)
    setQuery('')
    setFlash(true)
    if (flashTimer.current) clearTimeout(flashTimer.current)
    flashTimer.current = setTimeout(() => setFlash(false), FLASH_MS)
    requestAnimationFrame(() => {
      const list = listRef.current
      if (!list) return
      list.scrollIntoView({ behavior: 'smooth', block: 'start' })
      list.querySelector<HTMLElement>('.lib-card')?.focus({ preventScroll: true })
    })
  }

  const existingHint = loading
    ? 'Loading your rooms…'
    : rooms.length === 0
      ? 'Nothing saved yet — start a new room or import a room file'
      : `${rooms.length} saved room${rooms.length === 1 ? '' : 's'} · pick up where you left off`

  return (
    <div className="library">
      <header className="lib-head">
        <OwnerPrompt />
        <div className="lib-title">
          <span className="logo">R</span>
          <div>
            <OwnerTitle />
            <p className="muted">Rooms are saved in {location || '…'}</p>
          </div>
        </div>
      </header>

      <div className="lib-start" role="group" aria-label="Start">
        <button type="button" className={creating ? 'lib-action on' : 'lib-action'} aria-expanded={creating} onClick={() => setCreating(true)}>
          <span className="lib-action-icon" aria-hidden="true"><PlusIcon /></span>
          <span className="lib-action-text">
            <strong>Start a new room</strong>
            <span>Measure it, pick what it starts with, then try layouts in 2D and 3D.</span>
          </span>
        </button>
        <button type="button" className="lib-action" onClick={showExisting}>
          <span className="lib-action-icon" aria-hidden="true"><RoomIcon /></span>
          <span className="lib-action-text">
            <strong>Open an existing room</strong>
            <span>{existingHint}</span>
          </span>
        </button>
      </div>

      {creating && <NewRoomPanel groups={groups} onDone={() => setCreating(false)} />}

      {error && (
        <div className="lib-error" role="alert">
          <span>{error}</span>
          <button className="chip ghost" onClick={() => useLibrary.setState({ error: null, status: 'idle' })}>Dismiss</button>
        </div>
      )}

      {houses.length > 0 && (
        <section className="lib-houses" aria-label="Your house">
          <h2>Your house</h2>
          <div className="lib-houses-list">
            {houses.map((h) => (
              <button key={h.id} type="button" className="lib-house" onClick={() => void openHouse(h.id)}>
                <HouseThumb house={h} width={150} />
                <span>
                  <strong>{h.name}</strong>
                  <span>{h.rooms.length} room{h.rooms.length === 1 ? '' : 's'} · see them all on one map</span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div ref={listRef} className={flash ? 'lib-rooms flash' : 'lib-rooms'}>
        <div className="lib-rooms-head">
          <h2>Your rooms</h2>
          <div className="lib-tools">
            <input
              className="text lib-search"
              type="search"
              placeholder="Search rooms or groups"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search rooms"
            />
            <UnitToggle />
            <button className="chip ghost" onClick={() => void importDoc()} title="Open a room file exported with Export JSON — to move a room between computers or restore a backup">Import room file</button>
          </div>
        </div>

        {loading ? (
          <p className="lib-empty muted">Loading your rooms…</p>
        ) : rooms.length === 0 ? (
          <div className="lib-empty">
            <h2>No rooms yet</h2>
            <p className="muted">
              A room is a real space you want to furnish: measure it, add its windows and doors, then try layouts in 2D and 3D.
              Everything you change is saved automatically, so you can come back to it when you renovate.
            </p>
            <button className="chip solid pink-btn" onClick={() => setCreating(true)}>Create your first room</button>
          </div>
        ) : filtered.length === 0 ? (
          <p className="lib-empty muted">Nothing matches “{query}”.</p>
        ) : (
          sections.map((sec) => (
            <section key={sec.name} className="lib-group">
              <h4>
                {sec.name} <span className="count">{sec.rooms.length}</span>
              </h4>
              <div className="lib-grid">
                {sec.rooms.map((r) => <RoomCard key={r.id} summary={r} groups={groups} />)}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  )
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

/** A little floor plan: four walls with a door standing open in the bottom one. */
function RoomIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 20H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4" />
      <path d="M9 20v-6" />
      <path d="M9 14a6 6 0 0 1 6 6" strokeDasharray="1.5 2.2" />
    </svg>
  )
}

/* ---------- new room ---------- */

const STARTS: { id: StartWith; title: string; hint: string }[] = [
  { id: 'basics', title: 'The basics', hint: 'door, window, bed, dresser, rug and desk — placed for you' },
  { id: 'empty', title: 'Empty room', hint: 'just the walls, with a window and a door' },
  { id: 'example', title: 'A copy of the example room', hint: "Mila's room with its furniture and layouts" },
]

function NewRoomPanel({ groups, onDone }: { groups: string[]; onDone: () => void }) {
  const create = useLibrary((s) => s.create)
  const unit = useUnits((s) => s.unit)
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  // 10 × 12 ft with an 8 ft ceiling in inches, 3 × 4 m with 2.6 m in cm
  const [w, setW] = useState(() => defaultRoomSize(unit).w)
  const [d, setD] = useState(() => defaultRoomSize(unit).d)
  const [h, setH] = useState(() => defaultRoomSize(unit).h)
  const [start, setStart] = useState<StartWith>('basics')
  const [busy, setBusy] = useState(false)
  const touched = useRef(false)
  const valid = name.trim().length > 0
  // the example room brings its own size
  const fixed = start === 'example'

  // switching units while the form is open swaps the untouched defaults for that unit's
  useEffect(() => {
    if (touched.current) return
    const size = defaultRoomSize(unit)
    setW(size.w); setD(size.d); setH(size.h)
  }, [unit])
  const commit = (set: (v: number) => void) => (v: number) => { touched.current = true; set(v) }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!valid || busy) return
    setBusy(true)
    await create({ name, group, w, d, h, start })
    setBusy(false)
    onDone()
  }

  return (
    <form className="card lib-new" onSubmit={submit}>
      <h4>New room</h4>
      <div className="lib-new-grid">
        <label className="field wide">
          Name
          <input className="text name" autoFocus required placeholder="e.g. Mila's room" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          Group
          <input className="text" list="lib-groups" placeholder="e.g. Home, Cabin, 2027 renovation" value={group} onChange={(e) => setGroup(e.target.value)} />
          <datalist id="lib-groups">
            {groups.map((g) => <option key={g} value={g} />)}
          </datalist>
        </label>
        <div className="dims-grid">
          <label>Width<LengthInput min={150} max={1200} value={w} disabled={fixed} onCommit={commit(setW)} /></label>
          <label>Depth<LengthInput min={150} max={1200} value={d} disabled={fixed} onCommit={commit(setD)} /></label>
          <label>Ceiling height<LengthInput min={200} max={400} value={h} disabled={fixed} onCommit={commit(setH)} /></label>
        </div>
        <div className="lib-start-with" role="radiogroup" aria-labelledby="lib-start-with-label">
          <span id="lib-start-with-label" className="caption">Start with</span>
          <div className="lib-start-options">
            {STARTS.map((o) => (
              <label key={o.id} className={start === o.id ? 'lib-radio on' : 'lib-radio'}>
                <input type="radio" name="start" value={o.id} checked={start === o.id} onChange={() => setStart(o.id)} />
                <span className="lib-radio-text">
                  <strong>{o.title}</strong>
                  <small>{o.hint}</small>
                </span>
              </label>
            ))}
          </div>
        </div>
      </div>
      <div className="row">
        <button className="chip solid pink-btn" type="submit" disabled={!valid || busy}>{busy ? 'Creating…' : 'Create room'}</button>
        <button className="chip ghost" type="button" onClick={onDone}>Cancel</button>
      </div>
    </form>
  )
}

/* ---------- room card ---------- */

type CardMode = null | 'menu' | 'rename' | 'group' | 'delete'

function RoomCard({ summary, groups }: { summary: RoomSummary; groups: string[] }) {
  const open = useLibrary((s) => s.open)
  const rename = useLibrary((s) => s.rename)
  const setGroup = useLibrary((s) => s.setGroup)
  const duplicate = useLibrary((s) => s.duplicate)
  const exportDoc = useLibrary((s) => s.exportDoc)
  const remove = useLibrary((s) => s.remove)
  const unit = useUnits((s) => s.unit)
  const [mode, setMode] = useState<CardMode>(null)
  const [draft, setDraft] = useState('')
  const preview = useDocPreview(summary.id, summary.updatedAt)

  const stop = (e: React.SyntheticEvent) => e.stopPropagation()
  const startRename = () => { setDraft(summary.name); setMode('rename') }
  const startGroup = () => { setDraft(summary.group); setMode('group') }

  const commitRename = async () => {
    const n = draft.trim()
    setMode(null)
    if (n && n !== summary.name) await rename(summary.id, n)
  }
  const commitGroup = async () => {
    const g = draft.trim()
    setMode(null)
    if (g !== summary.group) await setGroup(summary.id, g)
  }

  return (
    <article
      className="lib-card"
      onClick={() => { if (!mode) void open(summary.id) }}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' && !mode) void open(summary.id) }}
    >
      <div className="lib-thumb">
        {preview ? (
          <PlanThumb room={preview.room} items={preview.items} size={200} />
        ) : (
          <div className="lib-thumb-blank" style={{ aspectRatio: `${summary.w} / ${summary.d}` }} />
        )}
      </div>
      <div className="lib-card-body" onClick={stop}>
        {mode === 'rename' ? (
          <form className="lib-inline" onSubmit={(e) => { e.preventDefault(); void commitRename() }}>
            <input className="text name" autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commitRename()} onKeyDown={(e) => { if (e.key === 'Escape') setMode(null) }} />
          </form>
        ) : mode === 'group' ? (
          <form className="lib-inline" onSubmit={(e) => { e.preventDefault(); void commitGroup() }}>
            <input className="text" autoFocus list={`groups-${summary.id}`} placeholder="Group name (empty for none)" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={() => void commitGroup()} onKeyDown={(e) => { if (e.key === 'Escape') setMode(null) }} />
            <datalist id={`groups-${summary.id}`}>
              {groups.map((g) => <option key={g} value={g} />)}
            </datalist>
          </form>
        ) : mode === 'delete' ? (
          <div className="lib-inline lib-confirm">
            <span>Delete “{summary.name}”?</span>
            <button className="chip danger" onClick={() => { setMode(null); void remove(summary.id) }}>Delete</button>
            <button className="chip ghost" onClick={() => setMode(null)}>Keep</button>
          </div>
        ) : (
          <>
            <div className="lib-card-title">
              <h3 onClick={() => void open(summary.id)}>{summary.name}</h3>
              <button className="icon lib-more" title="More" aria-label="More" onClick={() => setMode(mode === 'menu' ? null : 'menu')}>⋯</button>
            </div>
            <div className="lib-meta">{formatRoomSize(summary.w, summary.d, { unit })} · {summary.itemCount} item{summary.itemCount === 1 ? '' : 's'}</div>
            <div className="lib-meta muted">edited {timeAgo(summary.updatedAt)}</div>
          </>
        )}
        {mode === 'menu' && (
          <div className="lib-menu" onMouseLeave={() => setMode(null)}>
            <button onClick={() => void open(summary.id)}>Open</button>
            <button onClick={startRename}>Rename</button>
            <button onClick={startGroup}>Move to group…</button>
            <button onClick={() => { setMode(null); void duplicate(summary.id) }}>Duplicate</button>
            <button onClick={() => { setMode(null); void exportDoc(summary.id) }} title="Save this room as a file you can back up or open on another computer">Export room file</button>
            <button className="danger" onClick={() => setMode('delete')}>Delete</button>
          </div>
        )}
      </div>
    </article>
  )
}

/** Loads the document behind a card (for its thumbnail); reloads when it was edited. */
function useDocPreview(id: string, updatedAt: string): Pick<RoomDoc, 'room' | 'items'> | null {
  const [doc, setDoc] = useState<{ room: Room; items: Item[] } | null>(null)
  useEffect(() => {
    let alive = true
    ;(async () => {
      try {
        const s = await getStorage()
        const raw = await s.load(id)
        const d = raw ? migrateDoc(raw) : null
        if (alive && d) setDoc({ room: d.room, items: d.items })
      } catch {
        /* thumbnail is optional */
      }
    })()
    return () => { alive = false }
  }, [id, updatedAt])
  return doc
}


/** The page title, named after whoever owns this planner; click to change the name. */
function OwnerTitle() {
  const name = useOwner((s) => s.name)
  const setName = useOwner((s) => s.setName)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  if (editing) {
    return (
      <form
        className="owner-edit"
        onSubmit={(e) => { e.preventDefault(); setName(draft); setEditing(false) }}
      >
        <input autoFocus value={draft} placeholder="Your name" maxLength={40} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setEditing(false) }} />
        <button className="chip solid" type="submit">Save</button>
        <button className="chip ghost" type="button" onClick={() => setEditing(false)}>Cancel</button>
      </form>
    )
  }
  return (
    <h1 className="owner-title" title="Click to change the name" onClick={() => { setDraft(name); setEditing(true) }}>
      {plannerTitle(name)}
    </h1>
  )
}

/** First launch: ask for a name so the home page can say whose planner it is. */
function OwnerPrompt() {
  const asked = useOwner((s) => s.asked)
  const setName = useOwner((s) => s.setName)
  const skip = useOwner((s) => s.skip)
  const [draft, setDraft] = useState('')
  if (asked) return null
  return (
    <div className="owner-overlay" role="dialog" aria-modal="true" aria-labelledby="owner-q">
      <form className="owner-card" onSubmit={(e) => { e.preventDefault(); if (draft.trim()) setName(draft); else skip() }}>
        <span className="logo">R</span>
        <h2 id="owner-q">Welcome. What’s your name?</h2>
        <p className="muted">The home page will be called <b>{plannerTitle(draft || 'Your')}</b>. You can change it later by clicking the title.</p>
        <input autoFocus value={draft} placeholder="First name" maxLength={40} onChange={(e) => setDraft(e.target.value)} />
        <div className="row">
          <button className="chip solid" type="submit">{draft.trim() ? 'Continue' : 'Skip'}</button>
        </div>
      </form>
    </div>
  )
}
