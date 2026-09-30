import { migrateHouse, type HouseDoc } from '../house'
import { migrateDoc } from '../migrate'
import type { RoomDoc, RoomSummary } from '../types'
import { LocalStorageBackend } from './local'
import { summarize } from './types'

/** Served by scripts/room-folder.ts on `npm run dev` and `npm run preview`. */
export const ROUTE = '/__rooms'

async function call(path: string, init?: RequestInit): Promise<Response> {
  let res: Response
  try {
    res = await fetch(ROUTE + path, { cache: 'no-store', ...init })
  } catch (err) {
    throw new Error(`The rooms folder is out of reach (is the dev server still running?): ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!res.ok && res.status !== 404) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `rooms folder answered ${res.status}`)
  }
  return res
}

/**
 * Browser backend when the page comes from the dev or preview server: rooms are JSON files in
 * ~/Documents/Room Planner, shared with the Mac app. Export, import and PDF downloads work
 * the same as in the plain browser build.
 */
export class FolderApiBackend extends LocalStorageBackend {
  readonly location: string

  constructor(location: string) {
    super()
    this.location = location
  }

  /** The folder backend when the server offers one, else null (a static build on a web host). */
  static async probe(): Promise<FolderApiBackend | null> {
    try {
      const res = await fetch(ROUTE, { cache: 'no-store' })
      if (!res.ok || !(res.headers.get('Content-Type') ?? '').includes('application/json')) return null
      const body = (await res.json()) as { location?: unknown }
      return typeof body.location === 'string' ? new FolderApiBackend(body.location) : null
    } catch {
      return null
    }
  }

  async list(): Promise<RoomSummary[]> {
    const body = (await (await call('')).json()) as { docs?: unknown[] }
    return (body.docs ?? [])
      .map((raw) => migrateDoc(raw))
      .filter((d): d is RoomDoc => d !== null)
      .map(summarize)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async load(id: string): Promise<RoomDoc | null> {
    const res = await call(`/${encodeURIComponent(id)}`)
    return res.status === 404 ? null : migrateDoc(await res.json())
  }

  async save(doc: RoomDoc): Promise<void> {
    const body = JSON.stringify(doc)
    await call(`/${encodeURIComponent(doc.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body,
      // a save sent as the page closes still arrives (browsers allow this up to 64 KB)
      keepalive: body.length < 60000,
    })
  }

  async remove(id: string): Promise<void> {
    await call(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async listHouses(): Promise<HouseDoc[]> {
    const body = (await (await call('/_houses')).json()) as { houses?: unknown[] }
    return (body.houses ?? []).map(migrateHouse).filter((h): h is HouseDoc => h !== null)
  }

  async saveHouse(house: HouseDoc): Promise<void> {
    const body = JSON.stringify(house)
    await call(`/_houses/${encodeURIComponent(house.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body, keepalive: body.length < 60000 })
  }

  async removeHouse(id: string): Promise<void> {
    await call(`/_houses/${encodeURIComponent(id)}`, { method: 'DELETE' })
  }

  async backup(): Promise<string | null> {
    const body = (await (await call('/_backup', { method: 'POST' })).json()) as { name?: unknown }
    return typeof body.name === 'string' ? body.name : null
  }

  async seededIds(): Promise<string[]> {
    const body = (await (await call('/_seeded')).json()) as { ids?: unknown }
    return Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === 'string') : []
  }

  async markSeeded(ids: string[]): Promise<void> {
    await call('/_seeded', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) })
  }
}
