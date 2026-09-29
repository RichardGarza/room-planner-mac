import { accessAllows, accessZones, closetClearance, closetLabel, doorClearanceFor, doorwayPolygon, isSide, polygonInRoom, wallStripPolygon, fractionInRoom, gapBetween, isRugKind, itemsGap, itemsIntersect, overlapArea, polygonIntersectsRect, polygonOf, polygonsIntersect, rectOf, wallStripRect, type AccessZone } from './geometry'
import type { Check, Item, Rect, Room, Wall } from './types'

const MIN_PASSAGE = 60
const BED_EXIT = 45
const MIN_DOOR_ANGLE = 85
/** how close to a wall an item must stand to count as "against" it */
const WALL_TOUCH = 5
/** how much of a window's span an item must share to count as standing under it */
const MIN_SPAN = 20
/** fraction of the window height an item may rise into before it "blocks" the window */
const BLOCKS_WINDOW = 0.7
/** strip in front of a door that must stay clear */
const DOORWAY_DEPTH = 40

/** "the window" with one, "window 2" with several (1-based). */
function nameOf(kind: 'window' | 'door' | 'radiator', i: number, count: number) {
  return count > 1 ? `${kind} ${i + 1}` : `the ${kind}`
}
function sillOf(i: number, count: number) {
  return count > 1 ? `the sill of window ${i + 1}` : 'the window sill'
}

function touchesWall(room: Room, r: Rect, wall: Wall, reach: number) {
  switch (wall) {
    case 'top': return r.y0 <= reach
    case 'bottom': return r.y1 >= room.d - reach
    case 'left': return r.x0 <= reach
    case 'right': return r.x1 >= room.w - reach
  }
}

/** An item's extent along a wall, in that wall's offset coordinate. */
function spanOf(r: Rect, wall: Wall): { offset: number; width: number } {
  return wall === 'top' || wall === 'bottom' ? { offset: r.x0, width: r.x1 - r.x0 } : { offset: r.y0, width: r.y1 - r.y0 }
}

function spanOverlap(a: { offset: number; width: number }, b: { offset: number; width: number }) {
  return Math.min(a.offset + a.width, b.offset + b.width) - Math.max(a.offset, b.offset)
}

/** A chair pushed under a desk is not a collision. */
function tucksUnder(chair: Item, desk: Item) {
  return chair.kind === 'chair' && desk.kind === 'desk' && overlapArea(rectOf(chair), rectOf(desk)) < 0.5 * chair.w * chair.d
}

/** a piece only "blocks" an access strip when it reaches at least this far into it both ways (a corner clipping it does not count) */
const ZONE_REACH = 10
/** a bed side counts as usable while this much of its strip is inside the room and free */
const SIDE_FREE = 0.6

/** Does a piece stand in an access strip (more than a sliver of it)? */
function blocksZone(other: Item, zone: AccessZone) {
  const r = rectOf(other)
  const w = Math.min(r.x1, zone.rect.x1) - Math.max(r.x0, zone.rect.x0)
  const h = Math.min(r.y1, zone.rect.y1) - Math.max(r.y0, zone.rect.y0)
  if (w < ZONE_REACH || h < ZONE_REACH) return false
  return polygonsIntersect(polygonOf(other), zone.poly)
}

/** True for the access-space checks (drawers, doors, chair, legroom, a bed's free side). */
export function isAccessCheck(check: Check) {
  return /^(Drawers can't open|Wardrobe doors can't open|Can't reach the shelves|Nothing can pull up to the desk|No legroom in front of|No room to sit at|Can't get to|No room in front of)/.test(check.text)
}

/** "Drawers can't open", "Wardrobe doors can't open", … for the piece whose access space is taken. */
function accessLead(it: Item) {
  const subject = it.name.toLowerCase()
  switch (it.kind) {
    case 'dresser':
    case 'nightstand': return "Drawers can't open"
    case 'wardrobe': return "Wardrobe doors can't open"
    case 'bookcase':
    case 'shelf': return "Can't reach the shelves"
    case 'desk': return 'Nothing can pull up to the desk'
    case 'sofa': return `No legroom in front of the ${subject}`
    case 'table': return it.w >= 120 ? `No room to sit at the ${subject}` : `Can't get to the ${subject}`
    case 'bed': return `Can't get to the ${subject} from either side`
    default: return `No room in front of the ${subject}`
  }
}

export interface CheckOptions {
  /** formats a length in cm for the check texts (default "N cm") */
  len?: (cm: number) => string
}

const defaultLen = (cm: number) => `${Math.round(cm)} cm`

export function runChecks(room: Room, items: Item[], opts: CheckOptions = {}): Check[] {
  const len = opts.len ?? defaultLen
  const checks: Check[] = []
  const inRoom = items.filter((i) => i.inRoom)
  const solid = inRoom.filter((i) => !isRugKind(i.kind))
  // Passage and bed-exit checks only make sense for beds people climb into, not cribs.
  const bed = [...inRoom]
    .filter((i) => i.kind === 'bed' && Math.min(i.w, i.d) >= 85)
    .sort((a, b) => b.w * b.d - a.w * a.d)[0]

  // 1. Items poking through walls (the turned corners, so an angled piece is judged by its real outline) or the ceiling
  for (const it of inRoom) {
    const poly = polygonOf(it)
    if (!polygonInRoom(room, poly)) {
      checks.push({ level: 'bad', text: `${it.name} goes through a wall`, itemIds: [it.id] })
    }
    if (it.h > room.h + 0.5) {
      checks.push({ level: 'bad', text: `${it.name} is ${len(it.h - room.h)} taller than the ceiling`, itemIds: [it.id] })
    }
  }

  // 2. Overlaps
  for (let a = 0; a < solid.length; a++) {
    for (let b = a + 1; b < solid.length; b++) {
      const A = solid[a], B = solid[b]
      if (tucksUnder(A, B) || tucksUnder(B, A)) continue
      if (itemsIntersect(A, B)) {
        const bedItem = A.kind === 'bed' ? A : B.kind === 'bed' ? B : null
        const other = bedItem ? (A === bedItem ? B : A) : null
        const text =
          bedItem && other?.kind === 'chair'
            ? 'Bed blocks the chair spot'
            : bedItem && other
              ? `Bed overlaps the ${other.name.toLowerCase()}`
              : `${A.name} overlaps ${B.name.toLowerCase()}`
        checks.push({ level: 'bad', text, itemIds: [A.id, B.id] })
      }
    }
  }

  // 3. Windows: does what stands under each one fit below the sill?
  room.windows.forEach((win, i) => {
    const label = nameOf('window', i, room.windows.length)
    // a radiator under the window keeps furniture that far from the wall; still counts as "against the wall"
    const radDepth = Math.max(0, ...room.radiators.filter((r) => r.wall === win.wall && spanOverlap(r, win) > 0).map((r) => r.depth))
    const wall = win.wall
    // on a wall of a drawn outline: whatever reaches the strip in front of the window stands under it
    const strip = isSide(wall) ? null : wallStripPolygon(room, wall, win.offset + MIN_SPAN / 2, Math.max(1, win.width - MIN_SPAN), WALL_TOUCH + radDepth)
    for (const it of solid) {
      const r = rectOf(it)
      if (!isSide(wall)) {
        if (!strip || !polygonsIntersect(polygonOf(it), strip, 0)) continue
      } else {
        if (!touchesWall(room, r, wall, WALL_TOUCH + radDepth)) continue
        if (spanOverlap(spanOf(r, wall), win) < MIN_SPAN) continue
      }
      if (it.h <= win.sill) {
        checks.push({ level: 'ok', text: `${it.name} fits under ${label} with ${len(win.sill - it.h)} to spare`, itemIds: [it.id] })
        continue
      }
      const above = Math.round(it.h - win.sill)
      const covered = Math.min(above, win.height) / win.height
      checks.push({
        level: covered > BLOCKS_WINDOW ? 'bad' : 'warn',
        text: covered > BLOCKS_WINDOW ? `${it.name} blocks ${label}` : `${it.name} stands ${len(above)} above ${sillOf(i, room.windows.length)}`,
        itemIds: [it.id],
      })
    }
  })

  // 4. Radiators
  room.radiators.forEach((radiator, i) => {
    const label = nameOf('radiator', i, room.radiators.length)
    const rad = wallStripRect(room, radiator.wall, radiator.offset, radiator.width, radiator.depth + 15)
    for (const it of solid) {
      if (!polygonIntersectsRect(polygonOf(it), rad, 0)) continue
      const area = overlapArea(rectOf(it), rad)
      if (area > 0) {
        const frac = area / (radiator.width * (radiator.depth + 15))
        checks.push({
          level: 'warn',
          text: frac > 0.6 ? `${it.name} is in front of ${label}` : `${it.name} partly covers ${label}`,
          itemIds: [it.id],
        })
      }
    }
  })

  // 5. Doors: swing clearance for doors opening in, a clear doorway strip for doors opening out
  room.doors.forEach((door, i) => {
    const several = room.doors.length > 1
    const label = nameOf('door', i, room.doors.length)
    const Label = several ? `Door ${i + 1}` : 'Door'
    if (door.swing === 'in') {
      const { maxAngle, blocker } = doorClearanceFor(room, door, items)
      if (blocker && maxAngle < MIN_DOOR_ANGLE) {
        checks.push({ level: maxAngle < 45 ? 'bad' : 'warn', text: `${Label} only opens to ${maxAngle}° — ${blocker.name} is in the way`, itemIds: [blocker.id] })
        return
      }
    } else {
      const strip = doorwayPolygon(room, door, DOORWAY_DEPTH)
      const blockers = solid.filter((it) => polygonsIntersect(polygonOf(it), strip))
      for (const it of blockers) {
        checks.push({ level: 'bad', text: `${it.name} blocks the doorway${several ? ` of ${label}` : ''}`, itemIds: [it.id] })
      }
      if (blockers.length) return
    }
    checks.push({ level: 'ok', text: several ? `Clear entry through ${label}` : 'Wide, clear entry into the room', itemIds: [] })
  })

  // 6. Passages next to the bed
  if (bed) {
    const br = rectOf(bed)
    for (const it of solid) {
      if (it === bed) continue
      // nightstands are meant to sit right beside the bed
      if (it.kind === 'nightstand') continue
      const g = gapBetween(br, rectOf(it))
      if (!g || g.gap < 0 || g.gap > 120) continue
      const gap = Math.round(g.gap)
      checks.push({
        level: gap < MIN_PASSAGE ? 'warn' : 'ok',
        text: `Passage between ${it.name.toLowerCase()} and bed: ${len(gap)}`,
        itemIds: [bed.id, it.id],
      })
    }
    // room for getting out of bed: at least half of one long side needs a 60 cm strip beside it
    const rot = bed.rot === 90 || bed.rot === 270
    const clearFraction = (side: 'a' | 'b') => {
      const len = rot ? br.x1 - br.x0 : br.y1 - br.y0
      const steps = Math.max(1, Math.floor(len / 10))
      let clear = 0
      for (let i = 0; i < steps; i++) {
        const t = (i + 0.5) * 10
        const strip = rot
          ? side === 'a'
            ? { x0: br.x0 + t - 5, y0: br.y0 - BED_EXIT, x1: br.x0 + t + 5, y1: br.y0 }
            : { x0: br.x0 + t - 5, y0: br.y1, x1: br.x0 + t + 5, y1: br.y1 + BED_EXIT }
          : side === 'a'
            ? { x0: br.x0 - BED_EXIT, y0: br.y0 + t - 5, x1: br.x0, y1: br.y0 + t + 5 }
            : { x0: br.x1, y0: br.y0 + t - 5, x1: br.x1 + BED_EXIT, y1: br.y0 + t + 5 }
        if (strip.x0 < 0 || strip.x1 > room.w || strip.y0 < 0 || strip.y1 > room.d) continue
        if (!solid.some((o) => o !== bed && polygonIntersectsRect(polygonOf(o), strip))) clear++
      }
      return clear / steps
    }
    const best = Math.max(clearFraction('a'), clearFraction('b'))
    if (best < 0.5) {
      checks.push({ level: 'warn', text: 'Hard to get in and out of bed — both long sides are mostly blocked', itemIds: [bed.id] })
    }
  }

  // 7. Closets: the doors need room to open (or you need room to reach in)
  const closets = room.closets ?? []
  closets.forEach((closet, i) => {
    const label = closetLabel(i, closets.length)
    const clear = closetClearance(room, closet)
    for (const it of solid) {
      if (polygonIntersectsRect(polygonOf(it), clear.rect)) checks.push({ level: clear.level, text: clear.text(it.name, label), itemIds: [it.id] })
    }
  })

  // 8. Access space: drawers and doors have to open, a chair has to pull out, legs need room, a bed needs a free side
  for (const it of solid) {
    const access = accessZones(it)
    if (!access) continue
    // beds people climb into are covered by the bed-exit check above
    if (it === bed) continue
    const subject = it.name.toLowerCase()
    const blockersOf = (zone: AccessZone) => solid.filter((o) => o !== it && !accessAllows(it, o) && blocksZone(o, zone))
    if (access.rule.mode === 'all') {
      for (const zone of access.zones) {
        if (fractionInRoom(room, zone.rect) < 0.5) {
          checks.push({ level: 'warn', text: `${accessLead(it)}: the ${subject} faces the wall`, itemIds: [it.id] })
          continue
        }
        for (const o of blockersOf(zone)) {
          const gap = itemsGap(it, o)
          const where = zone.face === 'front' ? 'in front of' : 'beside'
          const how = gap < 1 ? `right ${where}` : `${len(gap)} ${where}`
          checks.push({ level: 'warn', text: `${accessLead(it)}: ${o.name.toLowerCase()} is ${how} the ${subject}`, itemIds: [it.id, o.id] })
        }
      }
    } else {
      // one usable side is enough: a side counts while most of its strip is inside the room and free
      const blockedBy: Item[] = []
      let usable = 0
      for (const zone of access.zones) {
        const area = (zone.rect.x1 - zone.rect.x0) * (zone.rect.y1 - zone.rect.y0)
        const inRoomFraction = fractionInRoom(room, zone.rect)
        const blockers = blockersOf(zone)
        const covered = blockers.reduce((sum, o) => sum + overlapArea(rectOf(o), zone.rect), 0) / Math.max(1, area)
        if (inRoomFraction >= SIDE_FREE && inRoomFraction - covered >= SIDE_FREE) usable++
        else blockedBy.push(...blockers)
      }
      if (usable === 0) {
        const names = [...new Set(blockedBy.map((o) => o.name.toLowerCase()))]
        const tail = names.length ? `${names.join(', ')} ${names.length > 1 ? 'are' : 'is'} in the way` : `it is boxed in by the walls`
        checks.push({ level: 'warn', text: `${accessLead(it)}: ${tail}`, itemIds: [it.id, ...new Set(blockedBy.map((o) => o.id))] })
      }
    }
  }

  // 9. Things kept in place (nice-to-know ok lines)
  const stayed = solid.filter((i) => ['dresser', 'desk', 'shelf'].includes(i.kind))
  if (stayed.length === 3) checks.push({ level: 'ok', text: 'Dresser, desk and shelf stay in place', itemIds: stayed.map((i) => i.id) })

  const order = { bad: 0, warn: 1, ok: 2 }
  return checks.sort((a, b) => order[a.level] - order[b.level])
}
