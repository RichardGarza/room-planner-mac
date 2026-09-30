import { useEffect, useState } from 'react'
import { houseBounds, type HouseDoc } from '../house'
import { libraryStorage } from '../library'
import { migrateDoc } from '../migrate'
import type { Room, RoomDoc } from '../types'
import { RoomDrawing } from './PlanThumb'

/** A small map of a house for the start screen: every room at its place, with its furniture. */
export function HouseThumb({ house, width = 200 }: { house: HouseDoc; width?: number }) {
  const [docs, setDocs] = useState<Record<string, RoomDoc>>({})
  const key = house.rooms.map((p) => `${p.roomId}@${p.x},${p.y},${p.rot}`).join('|') + house.updatedAt
  useEffect(() => {
    let live = true
    void (async () => {
      const s = await libraryStorage()
      const out: Record<string, RoomDoc> = {}
      for (const p of house.rooms) {
        const raw = await s.load(p.roomId).catch(() => null)
        const doc = raw ? migrateDoc(raw) : null
        if (doc) out[p.roomId] = doc
      }
      if (live) setDocs(out)
    })()
    return () => { live = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  const b = houseBounds(house, new Map(Object.entries(docs).map(([id, d]) => [id, d.room] as [string, Room])))
  const pad = 30
  const height = Math.round((width * 2) / 3)
  if (!b) return <svg className="house-thumb" width={width} height={height} aria-hidden="true" />
  return (
    <svg className="house-thumb" viewBox={`${b.x0 - pad} ${b.y0 - pad} ${b.x1 - b.x0 + pad * 2} ${b.y1 - b.y0 + pad * 2}`} width={width} height={height} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
      {house.rooms.map((p) => docs[p.roomId] && (
        <g key={p.roomId} transform={`translate(${p.x} ${p.y}) rotate(${p.rot})`}>
          <RoomDrawing room={docs[p.roomId].room} items={docs[p.roomId].items} />
        </g>
      ))}
    </svg>
  )
}
