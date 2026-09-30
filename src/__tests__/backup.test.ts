import { describe, expect, it } from 'vitest'
import { backupRooms, stamp, type BackupFs } from '../storage/backup'

/** An in-memory disk: file paths to contents; folders exist when something is in them or was made. */
function memoryFs(files: Record<string, string> = {}) {
  const disk = new Map(Object.entries(files))
  const made = new Set<string>()
  const children = (dir: string) => [...disk.keys(), ...made].filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1))
  const fs: BackupFs = {
    files: async (dir) => [...new Set(children(dir).filter((c) => !c.includes('/') && disk.has(`${dir}/${c}`)))],
    dirs: async (dir) => [...new Set(children(dir).filter((c) => c.includes('/') || made.has(`${dir}/${c}`)).map((c) => c.split('/')[0]))],
    read: async (p) => { if (!disk.has(p)) throw new Error(`ENOENT ${p}`); return disk.get(p)! },
    write: async (p, t) => { disk.set(p, t) },
    mkdir: async (d) => { made.add(d) },
    removeDir: async (d) => {
      for (const k of [...disk.keys()]) if (k.startsWith(`${d}/`)) disk.delete(k)
      for (const k of [...made]) if (k === d || k.startsWith(`${d}/`)) made.delete(k)
    },
  }
  return { fs, disk }
}

const at = (h: number, m = 0) => new Date(2026, 8, 29, h, m, 0)

describe('room backups', () => {
  const rooms = {
    'R/office--room-a.json': '{"id":"room-a","layouts":[{"name":"Layout 1"}]}',
    'R/forest--room-forest.json': '{"id":"room-forest"}',
    'R/seeded-rooms.txt': 'room-forest\n',
  }

  it('copies every room file, layouts and all, into a dated folder', async () => {
    const { fs, disk } = memoryFs(rooms)
    const name = await backupRooms(fs, 'R', at(17, 42))
    expect(name).toBe('2026-09-29 17.42.00')
    expect(disk.get(`R/Backups/${name}/office--room-a.json`)).toBe(rooms['R/office--room-a.json'])
    expect(disk.get(`R/Backups/${name}/forest--room-forest.json`)).toBe(rooms['R/forest--room-forest.json'])
    // only room files; the rooms themselves are untouched
    expect(disk.has(`R/Backups/${name}/seeded-rooms.txt`)).toBe(false)
    for (const [k, v] of Object.entries(rooms)) expect(disk.get(k)).toBe(v)
  })

  it('makes no new copy while nothing changed, and one as soon as a room changes', async () => {
    const { fs, disk } = memoryFs(rooms)
    expect(await backupRooms(fs, 'R', at(9))).not.toBeNull()
    expect(await backupRooms(fs, 'R', at(10))).toBeNull()
    disk.set('R/office--room-a.json', '{"id":"room-a","layouts":[{"name":"Layout 1"},{"name":"Layout 2"}]}')
    const next = await backupRooms(fs, 'R', at(11))
    expect(next).toBe('2026-09-29 11.00.00')
    expect(disk.get(`R/Backups/${next}/office--room-a.json`)).toContain('Layout 2')
    // the earlier copy still holds the earlier version
    expect(disk.get('R/Backups/2026-09-29 09.00.00/office--room-a.json')).not.toContain('Layout 2')
  })

  it('keeps the newest copies and drops the oldest', async () => {
    const { fs, disk } = memoryFs(rooms)
    for (let i = 0; i < 5; i++) {
      disk.set('R/forest--room-forest.json', `{"id":"room-forest","v":${i}}`)
      await backupRooms(fs, 'R', at(8 + i), 3)
    }
    expect((await fs.dirs('R/Backups')).sort()).toEqual(['2026-09-29 10.00.00', '2026-09-29 11.00.00', '2026-09-29 12.00.00'])
  })

  it('does nothing in an empty folder', async () => {
    const { fs, disk } = memoryFs({})
    expect(await backupRooms(fs, 'R', at(9))).toBeNull()
    expect(disk.size).toBe(0)
  })

  it('names folders so they sort by time', () => {
    expect(stamp(new Date(2026, 0, 5, 7, 3, 9))).toBe('2026-01-05 07.03.09')
  })
})
