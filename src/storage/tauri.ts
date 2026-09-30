import { open, save } from '@tauri-apps/plugin-dialog'
import { BaseDirectory, exists, mkdir, readDir, readTextFile, remove, writeFile, writeTextFile } from '@tauri-apps/plugin-fs'
import { migrateDoc } from '../migrate'
import type { RoomDoc, RoomSummary } from '../types'
import { migrateHouse, type HouseDoc } from '../house'
import { backupRooms, type BackupFs } from './backup'
import { summarize, type RoomStorage } from './types'

/**
 * Mac app backend: one JSON file per room in ~/Documents/Room Planner, written
 * through @tauri-apps/plugin-fs. Files are named "<slug>--<id>.json" so a room
 * can be found by id even after it is renamed. Export/import use the native
 * save/open dialogs from @tauri-apps/plugin-dialog.
 */

const FOLDER = 'Room Planner'
/** Houses (src/house.ts) live in a folder of their own next to the rooms, so room listings never see them. */
const HOUSES = `${FOLDER}/Houses`
const LOCATION = `~/Documents/${FOLDER}`
const SEP = '--'
/** One id per line: the built-in rooms already added to this library (see RoomStorage.seededIds). */
const SEEDED_FILE = 'seeded-rooms.txt'
const JSON_FILTER = [{ name: 'Room', extensions: ['json'] }]
/** All folder-relative paths resolve against the user's Documents folder. */
const IN_DOCS = { baseDir: BaseDirectory.Document } as const

function describe(err: unknown) {
  return err instanceof Error ? err.message : String(err)
}

function slugOf(name: string) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'room'
}

function fileNameFor(doc: RoomDoc) {
  return `${slugOf(doc.name)}${SEP}${doc.id}.json`
}

function suffixFor(id: string) {
  return `${SEP}${id}.json`
}

function inFolder(name: string) {
  return `${FOLDER}/${name}`
}

function isRoomFile(name: string) {
  return !name.startsWith('.') && name.toLowerCase().endsWith('.json')
}

function baseName(path: string) {
  return path.split(/[\\/]/).pop() || path
}

/** Create ~/Documents/Room Planner if it is missing. Called before every folder operation. */
async function ensureFolder() {
  try {
    if (!(await exists(FOLDER, IN_DOCS))) await mkdir(FOLDER, { ...IN_DOCS, recursive: true })
  } catch (err) {
    throw new Error(`Could not create the "${LOCATION}" folder: ${describe(err)}`)
  }
}

/** Names of the .json files in the rooms folder. */
async function roomFileNames() {
  try {
    const entries = await readDir(FOLDER, IN_DOCS)
    return entries.filter((e) => e.isFile && isRoomFile(e.name)).map((e) => e.name)
  } catch (err) {
    throw new Error(`Could not read the "${LOCATION}" folder: ${describe(err)}`)
  }
}

/** Every file whose name ends with "--<id>.json" (normally one; more if an earlier cleanup failed). */
async function fileNamesFor(id: string) {
  const suffix = suffixFor(id)
  return (await roomFileNames()).filter((n) => n.endsWith(suffix))
}

/** Read and migrate one file. Throws when the file is unreadable or is not a room document. */
async function readRoomFile(name: string): Promise<RoomDoc> {
  let text: string
  try {
    text = await readTextFile(inFolder(name), IN_DOCS)
  } catch (err) {
    throw new Error(`Could not read "${name}": ${describe(err)}`)
  }
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new Error(`"${name}" is not valid JSON`)
  }
  const doc = migrateDoc(raw)
  if (!doc) throw new Error(`"${name}" is not a Room Planner room`)
  return doc
}

async function writeRoomFile(name: string, doc: RoomDoc) {
  try {
    await writeTextFile(inFolder(name), JSON.stringify(doc, null, 2), IN_DOCS)
  } catch (err) {
    throw new Error(`Could not save "${doc.name}" to ${LOCATION}/${name}: ${describe(err)}`)
  }
}

async function removeRoomFile(name: string) {
  try {
    await remove(inFolder(name), IN_DOCS)
  } catch (err) {
    throw new Error(`Could not delete ${LOCATION}/${name}: ${describe(err)}`)
  }
}

/** The Documents folder through the fs plugin, for backupRooms (paths are relative to Documents). */
const tauriBackupFs: BackupFs = {
  files: async (dir) => (await readDir(dir, IN_DOCS)).filter((e) => e.isFile).map((e) => e.name),
  dirs: async (dir) => ((await exists(dir, IN_DOCS)) ? (await readDir(dir, IN_DOCS)).filter((e) => e.isDirectory).map((e) => e.name) : []),
  read: (path) => readTextFile(path, IN_DOCS),
  write: (path, text) => writeTextFile(path, text, IN_DOCS),
  mkdir: (dir) => mkdir(dir, { ...IN_DOCS, recursive: true }),
  removeDir: (dir) => remove(dir, { ...IN_DOCS, recursive: true }),
}

export class TauriFsBackend implements RoomStorage {
  readonly location = LOCATION

  async list(): Promise<RoomSummary[]> {
    await ensureFolder()
    const byId = new Map<string, RoomSummary>()
    const names = await roomFileNames()
    // canonical files ("<slug>--<id>.json") are read first so a stray copy can never claim their id
    const canonical = (n: string) => /--[^/\\]+\.json$/i.test(n)
    const ordered = [...names.filter(canonical), ...names.filter((n) => !canonical(n))]
    const taken = new Set<string>()
    for (const name of ordered) {
      let doc: RoomDoc
      try {
        doc = await readRoomFile(name)
      } catch (err) {
        console.warn('Skipping room file', name, describe(err))
        continue
      }
      // A file dropped into the folder by hand (no "--<id>" suffix) is adopted under the
      // canonical name so load()/save()/remove() can find it by id. It must never overwrite a
      // room that is already there (a Finder backup copy carries the same id as the original),
      // so such a copy becomes a room of its own with a fresh id.
      if (!name.endsWith(suffixFor(doc.id))) {
        const clash = taken.has(doc.id) || names.some((n) => n.endsWith(suffixFor(doc.id)))
        if (clash) {
          const fresh = `room-${Math.random().toString(36).slice(2, 10)}`
          console.warn(`Room file "${name}" has the id of a room that already exists; adopting it as a copy (${fresh})`)
          doc = { ...doc, id: fresh, name: `${doc.name} (copy)` }
        }
        try {
          await writeRoomFile(fileNameFor(doc), doc)
        } catch (err) {
          console.warn('Could not adopt room file', name, describe(err))
          continue
        }
        try {
          await removeRoomFile(name)
        } catch (err) {
          console.warn(describe(err))
        }
      }
      taken.add(doc.id)
      const summary = summarize(doc)
      const seen = byId.get(doc.id)
      if (!seen || summary.updatedAt > seen.updatedAt) byId.set(doc.id, summary)
    }
    return [...byId.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async load(id: string): Promise<RoomDoc | null> {
    await ensureFolder()
    const names = await fileNamesFor(id)
    if (names.length === 0) return null
    // If an old duplicate lingers, prefer the most recently updated copy.
    let best: RoomDoc | null = null
    let firstError: Error | null = null
    for (const name of names) {
      try {
        const doc = await readRoomFile(name)
        if (!best || doc.updatedAt > best.updatedAt) best = doc
      } catch (err) {
        firstError ??= err instanceof Error ? err : new Error(describe(err))
      }
    }
    if (!best && firstError) throw firstError
    return best
  }

  async save(doc: RoomDoc): Promise<void> {
    await ensureFolder()
    const target = fileNameFor(doc)
    const stale = (await fileNamesFor(doc.id)).filter((n) => n !== target)
    await writeRoomFile(target, doc)
    // The room was renamed: drop the file that carried the old slug.
    for (const name of stale) {
      try {
        await removeRoomFile(name)
      } catch (err) {
        console.warn(describe(err))
      }
    }
  }

  async remove(id: string): Promise<void> {
    await ensureFolder()
    for (const name of await fileNamesFor(id)) await removeRoomFile(name)
  }

  async seededIds(): Promise<string[]> {
    await ensureFolder()
    if (!(await exists(inFolder(SEEDED_FILE), IN_DOCS))) return []
    return (await readTextFile(inFolder(SEEDED_FILE), IN_DOCS)).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  }

  async markSeeded(ids: string[]): Promise<void> {
    const all = [...new Set([...(await this.seededIds()), ...ids])].sort()
    await writeTextFile(inFolder(SEEDED_FILE), all.join('\n') + '\n', IN_DOCS)
  }

  async listHouses(): Promise<HouseDoc[]> {
    await ensureFolder()
    if (!(await exists(HOUSES, IN_DOCS))) return []
    const byId = new Map<string, HouseDoc>()
    for (const e of await readDir(HOUSES, IN_DOCS)) {
      if (!e.isFile || !isRoomFile(e.name)) continue
      try {
        const house = migrateHouse(JSON.parse(await readTextFile(`${HOUSES}/${e.name}`, IN_DOCS)))
        const seen = house && byId.get(house.id)
        if (house && (!seen || house.updatedAt > seen.updatedAt)) byId.set(house.id, house)
      } catch (err) {
        console.warn('Skipping house file', e.name, describe(err))
      }
    }
    return [...byId.values()]
  }

  async saveHouse(house: HouseDoc): Promise<void> {
    await ensureFolder()
    if (!(await exists(HOUSES, IN_DOCS))) await mkdir(HOUSES, { ...IN_DOCS, recursive: true })
    const target = `${slugOf(house.name)}${SEP}${house.id}.json`
    const stale = (await readDir(HOUSES, IN_DOCS)).filter((e) => e.isFile && e.name.endsWith(suffixFor(house.id)) && e.name !== target)
    try {
      await writeTextFile(`${HOUSES}/${target}`, JSON.stringify(house, null, 2), IN_DOCS)
    } catch (err) {
      throw new Error(`Could not save the house "${house.name}": ${describe(err)}`)
    }
    for (const e of stale) await remove(`${HOUSES}/${e.name}`, IN_DOCS).catch((err) => console.warn(describe(err)))
  }

  async removeHouse(id: string): Promise<void> {
    if (!(await exists(HOUSES, IN_DOCS))) return
    for (const e of await readDir(HOUSES, IN_DOCS)) if (e.isFile && e.name.endsWith(suffixFor(id))) await remove(`${HOUSES}/${e.name}`, IN_DOCS)
  }

  async backup(): Promise<string | null> {
    await ensureFolder()
    return backupRooms(tauriBackupFs, FOLDER)
  }

  async exportDoc(doc: RoomDoc): Promise<void> {
    let path: string | null
    try {
      path = await save({ defaultPath: `${slugOf(doc.name)}.json`, filters: JSON_FILTER })
    } catch (err) {
      throw new Error(`Could not open the save dialog: ${describe(err)}`)
    }
    if (!path) return
    try {
      // The dialog plugin adds the chosen path to the fs scope, so an absolute path is allowed here.
      await writeTextFile(path, JSON.stringify(doc, null, 2))
    } catch (err) {
      throw new Error(`Could not export "${doc.name}" to ${path}: ${describe(err)}`)
    }
  }

  async saveFile(name: string, data: Uint8Array, mime: string): Promise<void> {
    const ext = name.split('.').pop() || 'bin'
    const label = mime === 'application/pdf' ? 'PDF' : ext.toUpperCase()
    let path: string | null
    try {
      path = await save({ defaultPath: name, filters: [{ name: label, extensions: [ext] }] })
    } catch (err) {
      throw new Error(`Could not open the save dialog: ${describe(err)}`)
    }
    if (!path) return
    try {
      // The dialog plugin adds the chosen path to the fs scope, so an absolute path is allowed here.
      await writeFile(path, data)
    } catch (err) {
      throw new Error(`Could not save ${baseName(path)}: ${describe(err)}`)
    }
  }

  async importFile(): Promise<unknown | null> {
    let picked: string | string[] | null
    try {
      picked = await open({ multiple: false, directory: false, filters: JSON_FILTER })
    } catch (err) {
      throw new Error(`Could not open the file dialog: ${describe(err)}`)
    }
    const path = Array.isArray(picked) ? (picked[0] ?? null) : picked
    if (!path) return null
    let text: string
    try {
      text = await readTextFile(path)
    } catch (err) {
      throw new Error(`Could not read ${path}: ${describe(err)}`)
    }
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`"${baseName(path)}" is not valid JSON`)
    }
  }

  async importDoc(): Promise<RoomDoc | null> {
    let picked: string | string[] | null
    try {
      picked = await open({ multiple: false, directory: false, filters: JSON_FILTER })
    } catch (err) {
      throw new Error(`Could not open the file dialog: ${describe(err)}`)
    }
    const path = Array.isArray(picked) ? (picked[0] ?? null) : picked
    if (!path) return null
    let text: string
    try {
      text = await readTextFile(path)
    } catch (err) {
      throw new Error(`Could not read ${path}: ${describe(err)}`)
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      throw new Error(`"${baseName(path)}" is not valid JSON`)
    }
    const doc = migrateDoc(raw)
    if (!doc) throw new Error(`"${baseName(path)}" is not a Room Planner room`)
    return doc
  }
}
