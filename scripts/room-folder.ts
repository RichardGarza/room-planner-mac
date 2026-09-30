import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Plugin } from 'vite'
import { backupRooms, type BackupFs } from '../src/storage/backup.ts'

/*
 * The rooms folder for the browser build. `npm run dev` and `npm run preview` serve a tiny
 * JSON API under /__rooms that reads and writes ~/Documents/Room Planner, the same folder the
 * Mac app uses, with the same "<slug>--<id>.json" file names. Every copy of the app (the Mac
 * app, a dev server on any port, a fresh build or clone) sees the same rooms, and they survive
 * clearing the browser. Set ROOM_PLANNER_DIR to use another folder.
 */

export const ROUTE = '/__rooms'
const SEP = '--'
/** Same file the Mac app keeps: one id per line of the built-in rooms already added. */
const SEEDED_FILE = 'seeded-rooms.txt'

export function roomsDir() {
  return process.env.ROOM_PLANNER_DIR || join(homedir(), 'Documents', 'Room Planner')
}

/** "~/Documents/Room Planner" rather than the full home path, for the library screen. */
export function displayDir(dir: string) {
  const home = homedir()
  return dir.startsWith(home) ? `~${dir.slice(home.length)}` : dir
}

interface DocLike { id: string; name: string; updatedAt?: string }

const slugOf = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'room'
const fileNameFor = (doc: DocLike) => `${slugOf(doc.name)}${SEP}${doc.id}.json`
const isRoomFile = (name: string) => !name.startsWith('.') && name.toLowerCase().endsWith('.json')
/** Room ids are generated ("room-ab12cd34"); anything with a path separator is refused. */
const validId = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id)

async function roomFiles(dir: string) {
  await mkdir(dir, { recursive: true })
  return (await readdir(dir, { withFileTypes: true })).filter((e) => e.isFile() && isRoomFile(e.name)).map((e) => e.name)
}

/**
 * Every readable room document in the folder, newest copy per id. Files dropped in by hand
 * (no "--<id>" suffix) are listed too; the Mac app renames them to the canonical name.
 */
export async function listDocs(dir: string): Promise<unknown[]> {
  const byId = new Map<string, DocLike>()
  for (const name of await roomFiles(dir)) {
    try {
      const doc = JSON.parse(await readFile(join(dir, name), 'utf8')) as DocLike
      if (!doc || typeof doc.id !== 'string') continue
      const seen = byId.get(doc.id)
      if (!seen || (doc.updatedAt ?? '') > (seen.updatedAt ?? '')) byId.set(doc.id, doc)
    } catch {
      // unreadable or not JSON: skip it, never delete it
    }
  }
  return [...byId.values()]
}

export async function loadDoc(dir: string, id: string): Promise<unknown | null> {
  return (await listDocs(dir)).find((d) => (d as DocLike).id === id) ?? null
}

/** Write through a hidden temp file and a rename, so a crash never leaves half a room behind. */
export async function saveDoc(dir: string, doc: DocLike) {
  const target = fileNameFor(doc)
  const stale = (await roomFiles(dir)).filter((n) => n.endsWith(`${SEP}${doc.id}.json`) && n !== target)
  // a temp name of its own, so two saves at once never trip over each other's file
  const tmp = join(dir, `.${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`)
  await writeFile(tmp, JSON.stringify(doc, null, 2))
  await rename(tmp, join(dir, target))
  // the room was renamed: drop the file that carried the old name
  for (const name of stale) await rm(join(dir, name), { force: true })
}

export async function removeDoc(dir: string, id: string) {
  for (const name of await roomFiles(dir)) if (name.endsWith(`${SEP}${id}.json`)) await rm(join(dir, name), { force: true })
}

/** Houses live in Houses/ next to the rooms, named like rooms ("<slug>--<id>.json"). */
const housesDir = (dir: string) => join(dir, 'Houses')

export async function listHouses(dir: string): Promise<unknown[]> {
  try {
    return await listDocs(housesDir(dir))
  } catch {
    return []
  }
}

export async function saveHouse(dir: string, house: DocLike) {
  await mkdir(housesDir(dir), { recursive: true })
  await saveDoc(housesDir(dir), house)
}

export async function removeHouse(dir: string, id: string) {
  try {
    await removeDoc(housesDir(dir), id)
  } catch {
    // no Houses folder: nothing to remove
  }
}

export async function seededIds(dir: string): Promise<string[]> {
  try {
    return (await readFile(join(dir, SEEDED_FILE), 'utf8')).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
  } catch {
    return []
  }
}

export async function markSeeded(dir: string, ids: string[]) {
  await mkdir(dir, { recursive: true })
  const all = [...new Set([...(await seededIds(dir)), ...ids.filter(validId)])].sort()
  await writeFile(join(dir, SEEDED_FILE), all.join('\n') + '\n')
}

/** Node's fs for backupRooms (absolute paths). */
const nodeBackupFs: BackupFs = {
  files: async (d) => (await readdir(d, { withFileTypes: true })).filter((e) => e.isFile()).map((e) => e.name),
  dirs: async (d) => {
    try {
      return (await readdir(d, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  },
  read: (p) => readFile(p, 'utf8'),
  write: (p, text) => writeFile(p, text),
  mkdir: async (d) => { await mkdir(d, { recursive: true }) },
  removeDir: (d) => rm(d, { recursive: true, force: true }),
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.end(JSON.stringify(body))
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

/** GET /__rooms, GET|PUT|DELETE /__rooms/<id>, GET|POST /__rooms/_seeded, POST /__rooms/_backup, GET /__rooms/_houses, PUT|DELETE /__rooms/_houses/<id>. */
export async function handle(dir: string, req: IncomingMessage, res: ServerResponse) {
  const path = (req.url ?? '').split('?')[0].slice(ROUTE.length).replace(/^\/+|\/+$/g, '')
  try {
    if (!path) {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      return send(res, 200, { location: displayDir(dir), docs: await listDocs(dir) })
    }
    if (path === '_houses') {
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' })
      return send(res, 200, { houses: await listHouses(dir) })
    }
    if (path.startsWith('_houses/')) {
      const id = decodeURIComponent(path.slice('_houses/'.length))
      if (!validId(id)) return send(res, 400, { error: 'bad house id' })
      if (req.method === 'PUT') {
        const house = JSON.parse(await readBody(req)) as DocLike
        if (!house || house.id !== id || typeof house.name !== 'string') return send(res, 400, { error: 'not a house' })
        await saveHouse(dir, house)
        return send(res, 200, { ok: true })
      }
      if (req.method === 'DELETE') {
        await removeHouse(dir, id)
        return send(res, 200, { ok: true })
      }
      return send(res, 405, { error: 'method not allowed' })
    }
    if (path === '_backup') {
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      return send(res, 200, { name: await backupRooms(nodeBackupFs, dir) })
    }
    if (path === '_seeded') {
      if (req.method === 'GET') return send(res, 200, { ids: await seededIds(dir) })
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' })
      const body = JSON.parse(await readBody(req)) as { ids?: unknown }
      await markSeeded(dir, Array.isArray(body.ids) ? body.ids.filter((i): i is string => typeof i === 'string') : [])
      return send(res, 200, { ok: true })
    }
    const id = decodeURIComponent(path)
    if (!validId(id)) return send(res, 400, { error: 'bad room id' })
    if (req.method === 'GET') {
      const doc = await loadDoc(dir, id)
      return doc ? send(res, 200, doc) : send(res, 404, { error: 'not found' })
    }
    if (req.method === 'PUT') {
      const doc = JSON.parse(await readBody(req)) as DocLike
      if (!doc || doc.id !== id || typeof doc.name !== 'string') return send(res, 400, { error: 'not a room document' })
      await saveDoc(dir, doc)
      return send(res, 200, { ok: true })
    }
    if (req.method === 'DELETE') {
      await removeDoc(dir, id)
      return send(res, 200, { ok: true })
    }
    return send(res, 405, { error: 'method not allowed' })
  } catch (err) {
    return send(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
}

/** Vite plugin: mounts the rooms API on the dev and preview servers. */
export function roomFolder(): Plugin {
  const mount = (server: { middlewares: { use: (route: string, fn: (req: IncomingMessage, res: ServerResponse) => void) => void } }) => {
    const dir = roomsDir()
    server.middlewares.use(ROUTE, (req, res) => {
      // connect strips the mount path from req.url; put it back so handle() sees the full path
      req.url = ROUTE + (req.url ?? '')
      void handle(dir, req, res)
    })
  }
  return { name: 'room-folder', configureServer: mount, configurePreviewServer: mount }
}
