import type { RoomDoc, RoomSummary } from '../types'
import { summarize, type RoomStorage } from './types'

const INDEX_KEY = 'room-planner.rooms.index'
const DOC_PREFIX = 'room-planner.rooms.doc.'

function readIndex(): RoomSummary[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY)
    return raw ? (JSON.parse(raw) as RoomSummary[]) : []
  } catch {
    return []
  }
}

function writeIndex(list: RoomSummary[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(list))
}

/** Browser backend: one localStorage entry per room plus a small index. */
export class LocalStorageBackend implements RoomStorage {
  readonly location: string = 'this browser'

  async list() {
    return readIndex().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  async load(id: string) {
    try {
      const raw = localStorage.getItem(DOC_PREFIX + id)
      return raw ? (JSON.parse(raw) as RoomDoc) : null
    } catch {
      return null
    }
  }

  async save(doc: RoomDoc) {
    localStorage.setItem(DOC_PREFIX + doc.id, JSON.stringify(doc))
    const index = readIndex().filter((r) => r.id !== doc.id)
    index.push(summarize(doc))
    writeIndex(index)
  }

  async remove(id: string) {
    localStorage.removeItem(DOC_PREFIX + id)
    writeIndex(readIndex().filter((r) => r.id !== id))
  }

  async exportDoc(doc: RoomDoc) {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${doc.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'room'}.json`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async saveFile(name: string, data: Uint8Array, mime: string) {
    const blob = new Blob([data as BlobPart], { type: mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async importDoc() {
    return new Promise<RoomDoc | null>((resolve) => {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'application/json,.json'
      input.onchange = async () => {
        const file = input.files?.[0]
        if (!file) return resolve(null)
        try {
          resolve(JSON.parse(await file.text()) as RoomDoc)
        } catch {
          resolve(null)
        }
      }
      input.oncancel = () => resolve(null)
      input.click()
    })
  }
}
