import type { HouseDoc } from '../house'
import type { RoomDoc, RoomSummary } from '../types'

/**
 * Where room documents live. The Mac app (Tauri) and the dev/preview server write JSON files to
 * ~/Documents/Room Planner; a static build on a web host uses localStorage. All implement this.
 */
export interface RoomStorage {
  /** Human-readable description of where files go, shown in the library UI. */
  readonly location: string
  list(): Promise<RoomSummary[]>
  load(id: string): Promise<RoomDoc | null>
  save(doc: RoomDoc): Promise<void>
  remove(id: string): Promise<void>
  /** Optional: hand the user a JSON file (native dialog in Tauri, download in the browser). */
  exportDoc?(doc: RoomDoc): Promise<void>
  /** Optional: let the user pick a JSON file to import; resolves null when cancelled. */
  importDoc?(): Promise<RoomDoc | null>
  /** Optional: hand the user a binary file such as a PDF (native save dialog in Tauri, download in the browser). Resolves silently when cancelled. */
  saveFile?(name: string, data: Uint8Array, mime: string): Promise<void>
  /**
   * Optional: ids of the built-in rooms (the example, Forest's Room, …) this library has already
   * been given, kept next to the rooms so a deleted one stays deleted in every copy of the app.
   */
  seededIds?(): Promise<string[]>
  markSeeded?(ids: string[]): Promise<void>
  /** Optional: copy every room file into Backups/<date time>/ when they changed since the last copy (src/storage/backup.ts). Resolves the new folder's name, or null. */
  backup?(): Promise<string | null>
  /** Houses (src/house.ts): where rooms sit in a home. Kept in Houses/ next to the rooms. */
  listHouses?(): Promise<HouseDoc[]>
  saveHouse?(house: HouseDoc): Promise<void>
  removeHouse?(id: string): Promise<void>
}

export function summarize(doc: RoomDoc): RoomSummary {
  return {
    id: doc.id,
    name: doc.name,
    group: doc.group,
    updatedAt: doc.updatedAt,
    createdAt: doc.createdAt,
    w: doc.room.w,
    d: doc.room.d,
    itemCount: doc.items.filter((i) => i.inRoom).length,
  }
}
