import { migrateDoc } from '../migrate'
import type { RoomDoc } from '../types'
import { FolderApiBackend } from './folder'
import { LocalStorageBackend } from './local'
import type { RoomStorage } from './types'

export type { RoomStorage } from './types'
export { summarize } from './types'

let instance: RoomStorage | null = null
let pending: Promise<RoomStorage> | null = null

/** True when running inside the Tauri Mac app. */
export function isTauri() {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/** Set once the rooms kept in this browser's storage have been copied into the rooms folder. */
export const ADOPTED_KEY = 'room-planner.rooms.adopted'

function flagGet(key: string) {
  try { return localStorage.getItem(key) } catch { return null }
}
function flagSet(key: string, value: string) {
  try { localStorage.setItem(key, value) } catch { /* private mode: it runs again next time, which is harmless */ }
}

/**
 * Copy the rooms an earlier version kept in this browser's local storage into the rooms folder,
 * once. A room the folder does not have is copied as it is. When the folder already has that id,
 * the folder wins, unless the browser's copy was edited later: then it is added as a separate
 * "(from browser)" room so neither version is lost. The browser's copies are left in place.
 */
export async function adoptBrowserRooms(folder: RoomStorage, local: RoomStorage = new LocalStorageBackend()): Promise<number> {
  if (flagGet(ADOPTED_KEY)) return 0
  const mine = await local.list()
  let copied = 0
  if (mine.length) {
    const there = new Map((await folder.list()).map((r) => [r.id, r]))
    for (const summary of mine) {
      const raw = await local.load(summary.id)
      const doc = raw ? migrateDoc(raw) : null
      if (!doc) continue
      const existing = there.get(doc.id)
      if (!existing) {
        await folder.save(doc)
        copied += 1
      } else if (doc.updatedAt > existing.updatedAt && doc.updatedAt !== doc.createdAt) {
        const copy: RoomDoc = { ...doc, id: `room-${Math.random().toString(36).slice(2, 10)}`, name: `${doc.name} (from browser)` }
        await folder.save(copy)
        copied += 1
      }
    }
  }
  flagSet(ADOPTED_KEY, '1')
  return copied
}

async function folderBackend(): Promise<RoomStorage | null> {
  if (!isTauri()) return FolderApiBackend.probe()
  try {
    const mod = await import('./tauri')
    return new mod.TauriFsBackend()
  } catch (err) {
    console.warn('Tauri storage unavailable, falling back to localStorage', err)
    return null
  }
}

async function pick(): Promise<RoomStorage> {
  const folder = await folderBackend()
  if (!folder) return new LocalStorageBackend()
  try {
    await adoptBrowserRooms(folder)
  } catch (err) {
    console.warn('Could not copy the rooms from browser storage into the rooms folder', err)
  }
  return folder
}

/**
 * Pick the backend once: files in ~/Documents/Room Planner in the Mac app (src/storage/tauri.ts,
 * loaded lazily so the web build never pulls in the Tauri packages) and on the dev or preview
 * server (src/storage/folder.ts), local storage only for a static build on a web host.
 */
export function getStorage(): Promise<RoomStorage> {
  if (instance) return Promise.resolve(instance)
  pending ??= pick().then((s) => (instance = s))
  return pending
}
