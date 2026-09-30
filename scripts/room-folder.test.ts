import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ROUTE, handle, listDocs, markSeeded, saveDoc, seededIds } from './room-folder.ts'

let dir = ''
let server: Server
let base = ''

const doc = (id: string, name: string, updatedAt = '2026-01-01T00:00:00.000Z') => ({ id, name, updatedAt, room: {}, items: [] })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'room-folder-'))
  server = createServer((req, res) => void handle(dir, req, res))
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}${ROUTE}`
})

afterEach(async () => {
  await new Promise((r) => server.close(r))
  await rm(dir, { recursive: true, force: true })
})

describe('rooms folder', () => {
  it('saves under the same "<slug>--<id>.json" names as the Mac app and renames with the room', async () => {
    await saveDoc(dir, doc('room-a', "Forest's Room"))
    expect(await readdir(dir)).toEqual(['forest-s-room--room-a.json'])
    await saveDoc(dir, doc('room-a', 'Nursery'))
    expect(await readdir(dir)).toEqual(['nursery--room-a.json'])
  })

  it('lists the newest copy per id and skips files that are not rooms', async () => {
    await writeFile(join(dir, 'old--room-a.json'), JSON.stringify(doc('room-a', 'Old', '2026-01-01T00:00:00.000Z')))
    await writeFile(join(dir, 'new copy.json'), JSON.stringify(doc('room-a', 'New', '2026-02-01T00:00:00.000Z')))
    await writeFile(join(dir, 'broken.json'), '{ nope')
    await writeFile(join(dir, 'notes.txt'), 'hello')
    const docs = (await listDocs(dir)) as { name: string }[]
    expect(docs.map((d) => d.name)).toEqual(['New'])
    // nothing was deleted
    expect((await readdir(dir)).sort()).toEqual(['broken.json', 'new copy.json', 'notes.txt', 'old--room-a.json'])
  })

  it('serves list, load, save and delete over HTTP', async () => {
    const put = await fetch(`${base}/room-b`, { method: 'PUT', body: JSON.stringify(doc('room-b', 'Study')) })
    expect(put.status).toBe(200)
    const list = (await (await fetch(base)).json()) as { location: string; docs: { id: string }[] }
    expect(list.docs.map((d) => d.id)).toEqual(['room-b'])
    expect(list.location).toBe(dir.replace(process.env.HOME ?? '\0', '~'))
    expect(((await (await fetch(`${base}/room-b`)).json()) as { name: string }).name).toBe('Study')
    expect((await fetch(`${base}/room-zzz`)).status).toBe(404)
    expect((await fetch(`${base}/room-b`, { method: 'DELETE' })).status).toBe(200)
    expect(await readdir(dir)).toEqual([])
  })

  it('refuses ids that could leave the folder and bodies whose id does not match', async () => {
    expect((await fetch(`${base}/..%2Fescape`, { method: 'PUT', body: JSON.stringify(doc('../escape', 'x')) })).status).toBe(400)
    expect((await fetch(`${base}/room-c`, { method: 'PUT', body: JSON.stringify(doc('room-d', 'x')) })).status).toBe(400)
    expect(await readdir(dir)).toEqual([])
  })

  it('keeps the seeded-rooms record in a plain text file shared with the Mac app', async () => {
    await markSeeded(dir, ['room-forest'])
    const post = await fetch(`${base}/_seeded`, { method: 'POST', body: JSON.stringify({ ids: ['room-example', 'room-forest'] }) })
    expect(post.status).toBe(200)
    expect(await seededIds(dir)).toEqual(['room-example', 'room-forest'])
    expect(await readFile(join(dir, 'seeded-rooms.txt'), 'utf8')).toBe('room-example\nroom-forest\n')
    expect(((await (await fetch(`${base}/_seeded`)).json()) as { ids: string[] }).ids).toEqual(['room-example', 'room-forest'])
  })

  it('backs the rooms up on request and never lists a backup as a room', async () => {
    await saveDoc(dir, doc('room-b', 'Study'))
    const first = (await (await fetch(`${base}/_backup`, { method: 'POST' })).json()) as { name: string | null }
    expect(first.name).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}$/)
    expect(await readdir(join(dir, 'Backups', first.name!))).toEqual(['study--room-b.json'])
    // nothing changed: no second copy
    expect(((await (await fetch(`${base}/_backup`, { method: 'POST' })).json()) as { name: string | null }).name).toBeNull()
    // the backup folder is not a room
    const list = (await (await fetch(base)).json()) as { docs: { id: string }[] }
    expect(list.docs.map((d) => d.id)).toEqual(['room-b'])
  })

  it('keeps houses in Houses/, apart from the rooms', async () => {
    await saveDoc(dir, doc('room-b', 'Study'))
    const house = { id: 'house-home', name: 'Home', rooms: [{ roomId: 'room-b', x: 0, y: 0, rot: 0 }] }
    expect((await fetch(`${base}/_houses/house-home`, { method: 'PUT', body: JSON.stringify(house) })).status).toBe(200)
    expect(await readdir(join(dir, 'Houses'))).toEqual(['home--house-home.json'])
    const houses = (await (await fetch(`${base}/_houses`)).json()) as { houses: { id: string }[] }
    expect(houses.houses.map((h) => h.id)).toEqual(['house-home'])
    // the room list is unaffected
    const rooms = (await (await fetch(base)).json()) as { docs: { id: string }[] }
    expect(rooms.docs.map((d) => d.id)).toEqual(['room-b'])
    // backups take the house along
    const b = (await (await fetch(`${base}/_backup`, { method: 'POST' })).json()) as { name: string }
    expect(await readdir(join(dir, 'Backups', b.name, 'Houses'))).toEqual(['home--house-home.json'])
    expect((await fetch(`${base}/_houses/house-home`, { method: 'DELETE' })).status).toBe(200)
    expect(await readdir(join(dir, 'Houses'))).toEqual([])
    expect((await fetch(`${base}/_houses/..%2Fx`, { method: 'PUT', body: '{}' })).status).toBe(400)
  })
})
