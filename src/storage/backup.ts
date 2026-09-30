/*
 * Backups of the rooms folder. Each time the app starts, if any room or house file differs from the
 * newest backup, every room file (layouts and all) and every house file is copied into
 * Backups/<date time>/ (houses in its Houses/). The newest KEEP backups are kept. Nothing here ever
 * changes or removes a room or house file itself.
 *
 * The same code runs in the Mac app (through the Tauri fs plugin, src/storage/tauri.ts) and on the
 * dev server (through Node's fs, scripts/room-folder.ts), so it talks to the disk through BackupFs.
 */

export const BACKUP_DIR = 'Backups'
/** Houses live in this folder next to the rooms; backups copy it too. */
export const HOUSES_DIR = 'Houses'
export const KEEP = 30

export interface BackupFs {
  /** names of the files directly in `dir` */
  files(dir: string): Promise<string[]>
  /** names of the folders directly in `dir` ([] when `dir` does not exist) */
  dirs(dir: string): Promise<string[]>
  read(path: string): Promise<string>
  write(path: string, text: string): Promise<void>
  /** create `dir` and any missing parents */
  mkdir(dir: string): Promise<void>
  /** remove `dir` and everything in it */
  removeDir(dir: string): Promise<void>
}

/** Room files: the .json files, not hidden ones. */
const isRoomFile = (name: string) => !name.startsWith('.') && name.toLowerCase().endsWith('.json')

/** "2026-09-29 17.42.05": sorts by time, and is a valid folder name everywhere. */
export function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`
}

/**
 * Back up the room files in `root` unless the newest backup already holds exactly these files.
 * Returns the new backup's folder name, or null when nothing needed backing up.
 */
export async function backupRooms(fs: BackupFs, root: string, now = new Date(), keep = KEEP): Promise<string | null> {
  const names = (await fs.files(root)).filter(isRoomFile).sort()
  if (!names.length) return null
  // room files by name, house files as "Houses/<name>"
  const current = new Map<string, string>()
  for (const n of names) current.set(n, await fs.read(`${root}/${n}`))
  for (const n of (await filesOr([], fs, `${root}/${HOUSES_DIR}`)).filter(isRoomFile).sort()) current.set(`${HOUSES_DIR}/${n}`, await fs.read(`${root}/${HOUSES_DIR}/${n}`))

  const base = `${root}/${BACKUP_DIR}`
  const existing = (await fs.dirs(base)).sort()
  const newest = existing[existing.length - 1]
  if (newest && (await sameAs(fs, `${base}/${newest}`, current))) return null

  let name = stamp(now)
  // two starts within the same second: keep both
  for (let i = 2; existing.includes(name); i++) name = `${stamp(now)} (${i})`
  await fs.mkdir(`${base}/${name}`)
  if ([...current.keys()].some((n) => n.startsWith(`${HOUSES_DIR}/`))) await fs.mkdir(`${base}/${name}/${HOUSES_DIR}`)
  for (const [n, text] of current) await fs.write(`${base}/${name}/${n}`, text)

  // the oldest go once there are more than `keep`
  const all = [...existing, name].sort()
  for (const old of all.slice(0, Math.max(0, all.length - keep))) await fs.removeDir(`${base}/${old}`)
  return name
}

async function sameAs(fs: BackupFs, dir: string, current: Map<string, string>): Promise<boolean> {
  const saved = [
    ...(await fs.files(dir)).filter(isRoomFile),
    ...(await filesOr([], fs, `${dir}/${HOUSES_DIR}`)).filter(isRoomFile).map((n) => `${HOUSES_DIR}/${n}`),
  ].sort()
  if (saved.length !== current.size || saved.some((n) => !current.has(n))) return false
  for (const n of saved) if ((await fs.read(`${dir}/${n}`)) !== current.get(n)) return false
  return true
}

/** The files in a folder, or `fallback` when it does not exist. */
async function filesOr(fallback: string[], fs: BackupFs, dir: string): Promise<string[]> {
  try {
    return await fs.files(dir)
  } catch {
    return fallback
  }
}
