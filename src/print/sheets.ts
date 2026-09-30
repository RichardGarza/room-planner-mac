import { houseBounds, roomOnPlan, type HouseDoc } from '../house'
import { closetInside, closetRecessPolygon, doorSwing, floorBounds, isRugKind, isSide, offsetPolygon, rectOf, roomPolygon, wallAxes, wallPoint, wallStripRect } from '../geometry'
import type { AnyWall, Door, Item, Opening, Room, Wall } from '../types'
import type { Unit } from '../units'
import { asciiLength, asciiSize, asciiText, checkBar, dateText, scaleNote } from './labels'
import { SCALES, esc, mmPerCm, packPieces, pageSize, printableArea, r2, rectsOverlap, shade, textWidth, tint, type PlacedPiece } from './layout'
import type { Box, PageSize, Product, Sheet, SheetInput, SheetOptions } from './types'

/**
 * SVG page builders for the two print products. Everything is drawn in page
 * millimetres so a sheet prints at 1:1 and svg2pdf.js can place it as-is.
 * Text is ASCII only (see labels.ts) so the PDF core fonts can draw it.
 */

const FONT = 'Helvetica, Arial, sans-serif'
const INK = '#2f2a26'
const MUTED = '#7a726b'
const RULE = '#d8d0c7'
const PINK = '#e5407a'
const PAPER = '#ffffff'

/** Smallest text on paper: 2.5 mm is about 7 pt. */
const F_MIN = 2.5
const F_BODY = 2.8
const F_TITLE = 5
const TITLE_H = 15
const FOOTER_H = 9
/** distance from the wall's outer face to the overall dimension lines */
const DIM_OFF = 8.5
/** dashed cut line sits this far outside a cut-out piece */
const CUT = 1
const PACK_GAP = 5

interface Frame {
  page: PageSize
  /** inside the margins */
  area: Box
  /** between the title block and the footer */
  draw: Box
}

function frame(page: PageSize): Frame {
  const area = printableArea(page)
  const draw = { x: area.x, y: area.y + TITLE_H, w: area.w, h: area.h - TITLE_H - FOOTER_H }
  return { page, area, draw }
}

/* ---------- primitives ---------- */

interface TextOpts {
  size?: number
  anchor?: 'start' | 'middle' | 'end'
  bold?: boolean
  italic?: boolean
  fill?: string
  rotate?: number
}

function text(x: number, y: number, s: string, o: TextOpts = {}): string {
  const size = o.size ?? F_BODY
  const attrs = [
    `font-size="${r2(size)}"`,
    o.anchor ? `text-anchor="${o.anchor}"` : '',
    o.bold ? 'font-weight="bold"' : '',
    o.italic ? 'font-style="italic"' : '',
    `fill="${o.fill ?? INK}"`,
  ].filter(Boolean).join(' ')
  const pos = o.rotate ? `transform="translate(${r2(x)} ${r2(y)}) rotate(${o.rotate})"` : `x="${r2(x)}" y="${r2(y)}"`
  return `<text ${pos} ${attrs}>${esc(asciiText(s))}</text>`
}

function line(x1: number, y1: number, x2: number, y2: number, stroke = INK, width = 0.25, dash?: string): string {
  return `<line x1="${r2(x1)}" y1="${r2(y1)}" x2="${r2(x2)}" y2="${r2(y2)}" stroke="${stroke}" stroke-width="${width}"${dash ? ` stroke-dasharray="${dash}"` : ''}/>`
}

function rect(b: Box, attrs: string): string {
  return `<rect x="${r2(b.x)}" y="${r2(b.y)}" width="${r2(b.w)}" height="${r2(b.h)}" ${attrs}/>`
}

function svgDoc(page: PageSize, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${page.w}mm" height="${page.h}mm" viewBox="0 0 ${page.w} ${page.h}" font-family="${FONT}" fill="${INK}">` +
    `<defs><pattern id="rp-hatch" width="1.2" height="1.2" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="1.2" stroke="#9a8f86" stroke-width="0.3"/></pattern></defs>` +
    rect({ x: 0, y: 0, w: page.w, h: page.h }, `fill="${PAPER}"`) +
    body +
    '</svg>'
  )
}

function titleBlock(f: Frame, title: string, sub: string[], pageNo: number, pageCount: number): string {
  const { area } = f
  const pages = `page ${pageNo} of ${pageCount}`
  return [
    text(area.x, area.y + 5.2, title, { size: F_TITLE, bold: true }),
    text(area.x, area.y + 10.4, sub.filter(Boolean).join('   |   '), { size: F_BODY, fill: MUTED }),
    text(area.x + area.w, area.y + 10.4, pages, { size: F_BODY, fill: MUTED, anchor: 'end' }),
    line(area.x, area.y + 12.6, area.x + area.w, area.y + 12.6, INK, 0.4),
  ].join('')
}

/** "Print at 100%" note with a bar of an exact length to check the printer did not shrink the page. */
function footer(f: Frame, unit: Unit): string {
  const { area } = f
  const bar = checkBar(unit)
  const y = area.y + area.h - FOOTER_H
  const label = `Print at 100% / actual size. Check: this bar is ${bar.label}`
  const tw = textWidth(label, F_BODY)
  const bx = area.x + tw + 4
  const by = y + 4.6
  return [
    line(area.x, y, area.x + area.w, y, RULE, 0.25),
    text(area.x, y + 5.5, label, { size: F_BODY }),
    line(bx, by, bx + bar.mm, by, INK, 0.35),
    line(bx, by - 1.6, bx, by + 1.6, INK, 0.35),
    line(bx + bar.mm, by - 1.6, bx + bar.mm, by + 1.6, INK, 0.35),
    text(bx + bar.mm / 2, by - 0.9, bar.label, { size: F_MIN, anchor: 'middle', fill: MUTED }),
    // the credit only when it clears the bar (a narrow portrait page has no room for it)
    bx + bar.mm + 4 + textWidth('Room Planner', F_MIN) <= area.x + area.w ? text(area.x + area.w, y + 5.5, 'Room Planner', { size: F_MIN, anchor: 'end', fill: MUTED }) : '',
  ].join('')
}

/* ---------- the room ---------- */

export interface RoomPlacement {
  scale: number
  /** mm per cm */
  k: number
  /** page position of the room's inner top-left corner */
  ox: number
  oy: number
  /** inner size in mm */
  W: number
  D: number
  /** wall thickness in mm */
  WT: number
  fits: boolean
  pads: { l: number; t: number; r: number; b: number }
}

/** Space (mm) needed around the room for wall labels, overall dimensions and out-swinging door arcs. */
function roomPads(room: Room, k: number) {
  const outSwing = (wall: Wall) => Math.max(0, ...room.doors.filter((d) => d.swing === 'out' && d.wall === wall).map((d) => d.width * k + 2))
  const wt = wallThickness(k)
  // closets reach out past the walls
  const fb = floorBounds(room)
  const out = { l: -fb.x0 * k, t: -fb.y0 * k, r: (fb.x1 - room.w) * k, b: (fb.y1 - room.d) * k }
  return {
    l: Math.max(wt + 7, outSwing('left'), out.l + wt + 2),
    t: Math.max(wt + 7, outSwing('top'), out.t + wt + 2),
    r: Math.max(wt + DIM_OFF + 5.5, outSwing('right')) + out.r,
    b: Math.max(wt + DIM_OFF + 5.5, outSwing('bottom')) + out.b,
  }
}

const wallThickness = (k: number) => Math.min(3, Math.max(1.6, 12 * k))

/** Pick the scale and centre the room (with its label margins) in the drawing box. */
export function placeRoom(room: Room, draw: Box): RoomPlacement {
  // the pads depend on the scale (out-swinging door arcs), so try each scale with its own pads
  let placement: RoomPlacement | null = null
  for (const scale of SCALES) {
    const k = mmPerCm(scale)
    const pads = roomPads(room, k)
    const W = room.w * k, D = room.d * k
    const fits = W + pads.l + pads.r <= draw.w && D + pads.t + pads.b <= draw.h
    placement = {
      scale, k, W, D, WT: wallThickness(k), pads, fits,
      ox: draw.x + pads.l + Math.max(0, (draw.w - pads.l - pads.r - W) / 2),
      oy: draw.y + pads.t,
    }
    if (fits) return placement
  }
  return placement!
}

/** The four corners (mm) an opening covers across the wall thickness, on any wall. */
function wallBand(p: RoomPlacement, room: Room, wall: AnyWall, offset: number, width: number): [number, number][] {
  const { normal } = wallAxes(wall, room)
  const at = (t: number, out: number): [number, number] => {
    const [x, y] = wallPoint(room, wall, t)
    return [p.ox + x * p.k - normal[0] * out, p.oy + y * p.k - normal[1] * out]
  }
  return [at(offset, 0), at(offset + width, 0), at(offset + width, p.WT), at(offset, p.WT)]
}

function polygonSvg(pts: [number, number][], attrs: string): string {
  return `<polygon points="${pts.map(([x, y]) => `${r2(x)},${r2(y)}`).join(' ')}" ${attrs}/>`
}

/** Box (mm) an opening occupies across the wall thickness. */
function wallBox(p: RoomPlacement, wall: Wall, offset: number, width: number): Box {
  const { ox, oy, W, D, WT, k } = p
  switch (wall) {
    case 'top': return { x: ox + offset * k, y: oy - WT, w: width * k, h: WT }
    case 'bottom': return { x: ox + offset * k, y: oy + D, w: width * k, h: WT }
    case 'left': return { x: ox - WT, y: oy + offset * k, w: WT, h: width * k }
    case 'right': return { x: ox + W, y: oy + offset * k, w: WT, h: width * k }
  }
}

/** Text outside a wall, centred on `t` cm along it, `dist` mm from the wall's outer face. */
function wallText(p: RoomPlacement, room: Room, wall: AnyWall, t: number, s: string, dist: number, opts: TextOpts = {}): string {
  const [cx, cy] = wallPoint(room, wall, t)
  const { normal, along } = wallAxes(wall, room)
  const size = opts.size ?? F_MIN
  const x = p.ox + cx * p.k
  const y = p.oy + cy * p.k
  const off = p.WT + dist
  if (!isSide(wall)) {
    // along a wall of a drawn outline, outside it, the right way up
    let deg = (Math.atan2(along[1], along[0]) * 180) / Math.PI
    if (deg > 90) deg -= 180
    if (deg < -90) deg += 180
    const d = off + size * 0.4
    return text(x - normal[0] * d, y - normal[1] * d + size * 0.35, s, { ...opts, size, anchor: 'middle', rotate: deg })
  }
  switch (wall) {
    case 'top': return text(x, y - off, s, { ...opts, size, anchor: 'middle' })
    case 'bottom': return text(x, y + off + size * 0.75, s, { ...opts, size, anchor: 'middle' })
    case 'left': return text(x - normal[0] * 0 - off, y, s, { ...opts, size, anchor: 'middle', rotate: -90 })
    case 'right': return text(x + off + size * 0.75, y, s, { ...opts, size, anchor: 'middle', rotate: 90 })
  }
}

function windowLabel(o: Opening, unit: Unit) {
  return `Window ${asciiLength(o.width, unit)}, sill ${asciiLength(o.sill, unit)}`
}
function doorLabel(d: Door, unit: Unit) {
  return `Door ${asciiLength(d.width, unit)}`
}

function arcPath(hx: number, hy: number, r: number, leafDir: (deg: number) => [number, number]) {
  const [x0, y0] = leafDir(0)
  const [x1, y1] = leafDir(90)
  const [mx, my] = leafDir(45)
  const cross = x0 * my - y0 * mx
  return `M ${r2(hx + x0 * r)} ${r2(hy + y0 * r)} A ${r2(r)} ${r2(r)} 0 0 ${cross > 0 ? 1 : 0} ${r2(hx + x1 * r)} ${r2(hy + y1 * r)}`
}

/** Walls, openings, radiators, wall labels and the overall room dimensions. */
export function drawRoom(room: Room, p: RoomPlacement, unit: Unit, opts: { hint?: string } = {}): string {
  const { ox, oy, W, D, WT, k } = p
  const out: string[] = []
  // floor
  out.push(rect({ x: ox, y: oy, w: W, h: D }, `fill="#fdfbf8"`))
  // grid every 50 cm (or 24 in) in a faint line
  const step = unit === 'in' ? 60.96 : 50
  for (let g = step; g < room.w - 0.5; g += step) out.push(line(ox + g * k, oy, ox + g * k, oy + D, '#eee8e1', 0.15))
  for (let g = step; g < room.d - 0.5; g += step) out.push(line(ox, oy + g * k, ox + W, oy + g * k, '#eee8e1', 0.15))
  if (opts.hint) out.push(text(ox + W / 2, oy + D / 2, opts.hint, { size: 3.2, anchor: 'middle', fill: '#b8afa5', italic: true }))

  // radiators
  for (const rad of room.radiators) {
    const r = wallStripRect(room, rad.wall, rad.offset, rad.width, rad.depth)
    const b = { x: ox + r.x0 * k, y: oy + r.y0 * k, w: (r.x1 - r.x0) * k, h: (r.y1 - r.y0) * k }
    out.push(rect(b, `fill="url(#rp-hatch)" stroke="#9a8f86" stroke-width="0.25"`))
  }

  // closets: the inside beyond the wall, as floor (furniture may stand in it)
  for (const c of room.closets ?? []) {
    const pts = closetRecessPolygon(room, c).map(([x, y]): [number, number] => [ox + x * k, oy + y * k])
    out.push(polygonSvg(pts, `fill="#fdfbf8" stroke="${INK}" stroke-width="0.35"`))
  }

  // walls: the outline pushed out by the wall thickness, minus the outline (cut corners included)
  const inner = roomPolygon(room).map(([x, y]): [number, number] => [ox + x * k, oy + y * k])
  const ring = (pts: [number, number][]) => `M ${pts.map(([x, y]) => `${r2(x)} ${r2(y)}`).join(' L ')} Z`
  out.push(`<path d="${ring(offsetPolygon(inner, WT))} ${ring(inner)}" fill="${INK}" fill-rule="evenodd"/>`)

  // windows: white gap with a double line
  for (const win of room.windows) {
    if (!isSide(win.wall)) {
      const [a, b, c, d] = wallBand(p, room, win.wall, win.offset, win.width)
      out.push(polygonSvg([a, b, c, d], `fill="${PAPER}" stroke="${INK}" stroke-width="0.25"`))
      for (const f of [0.35, 0.65]) out.push(line(a[0] + (d[0] - a[0]) * f, a[1] + (d[1] - a[1]) * f, b[0] + (c[0] - b[0]) * f, b[1] + (c[1] - b[1]) * f, INK, 0.25))
      out.push(wallText(p, room, win.wall, win.offset + win.width / 2, windowLabel(win, unit), 1.4))
      continue
    }
    const b = wallBox(p, win.wall, win.offset, win.width)
    const horizontal = win.wall === 'top' || win.wall === 'bottom'
    out.push(rect(b, `fill="${PAPER}" stroke="${INK}" stroke-width="0.25"`))
    for (const f of [0.35, 0.65]) {
      if (horizontal) out.push(line(b.x, b.y + b.h * f, b.x + b.w, b.y + b.h * f, INK, 0.25))
      else out.push(line(b.x + b.w * f, b.y, b.x + b.w * f, b.y + b.h, INK, 0.25))
    }
    out.push(wallText(p, room, win.wall, win.offset + win.width / 2, windowLabel(win, unit), 1.4))
  }

  // doors: gap, leaf and swing arc
  for (const door of room.doors) {
    if (!isSide(door.wall)) out.push(polygonSvg(wallBand(p, room, door.wall, door.offset, door.width), `fill="${PAPER}"`))
    else out.push(rect(wallBox(p, door.wall, door.offset, door.width), `fill="${PAPER}"`))
    const s = doorSwing(room, door)
    const hx = ox + s.hx * k, hy = oy + s.hy * k, r = s.r * k
    const [lx, ly] = s.leafDir(90)
    out.push(`<path d="${arcPath(hx, hy, r, s.leafDir)}" fill="none" stroke="#9a8f86" stroke-width="0.25" stroke-dasharray="1 0.8"/>`)
    out.push(line(hx, hy, hx + lx * r, hy + ly * r, INK, 0.5))
    const dist = door.swing === 'out' ? door.width * k + 1.4 : 1.4
    out.push(wallText(p, room, door.wall, door.offset + door.width / 2, doorLabel(door, unit), dist))
  }

  // closets: the opening through the wall and a label inside
  for (const c of room.closets ?? []) {
    out.push(polygonSvg(wallBand(p, room, c.wall, c.offset, c.width), `fill="#fdfbf8"`))
    const inside = closetInside(c)
    const { normal } = wallAxes(c.wall, room)
    const [mx, my] = wallPoint(room, c.wall, inside.offset + inside.width / 2)
    const depth = c.depth * k / 2 + WT / 2
    out.push(text(ox + mx * k - normal[0] * depth, oy + my * k - normal[1] * depth + F_MIN * 0.35, 'Closet', { size: F_MIN, anchor: 'middle', fill: MUTED }))
  }

  // overall dimensions: right and bottom, clear of closets that stick out on those sides
  const fb = floorBounds(room)
  const dimStroke = INK
  const xr = ox + Math.max(W, fb.x1 * k) + WT + DIM_OFF
  out.push(line(ox + W + WT + 1, oy, xr + 1.5, oy, RULE, 0.2), line(ox + W + WT + 1, oy + D, xr + 1.5, oy + D, RULE, 0.2))
  out.push(line(xr, oy, xr, oy + D, dimStroke, 0.3), line(xr - 1.2, oy, xr + 1.2, oy, dimStroke, 0.3), line(xr - 1.2, oy + D, xr + 1.2, oy + D, dimStroke, 0.3))
  out.push(text(xr + 1.2 + F_BODY * 0.75, oy + D / 2, asciiLength(room.d, unit, { feet: true }), { size: F_BODY, bold: true, anchor: 'middle', rotate: 90 }))
  const yb = oy + Math.max(D, fb.y1 * k) + WT + DIM_OFF
  out.push(line(ox, oy + D + WT + 1, ox, yb + 1.5, RULE, 0.2), line(ox + W, oy + D + WT + 1, ox + W, yb + 1.5, RULE, 0.2))
  out.push(line(ox, yb, ox + W, yb, dimStroke, 0.3), line(ox, yb - 1.2, ox, yb + 1.2, dimStroke, 0.3), line(ox + W, yb - 1.2, ox + W, yb + 1.2, dimStroke, 0.3))
  out.push(text(ox + W / 2, yb + 1.2 + F_BODY * 0.75, asciiLength(room.w, unit, { feet: true }), { size: F_BODY, bold: true, anchor: 'middle' }))

  return out.join('')
}

/* ---------- item labels ---------- */

interface LabelResult {
  svg: string
  /** page boxes the text occupies (so dimension labels can avoid them) */
  boxes: Box[]
  /** true when at least the first line was drawn */
  drawn: boolean
}

function wrapWords(s: string, maxW: number, size: number, bold: boolean): string[] | null {
  const words = s.split(/\s+/).filter(Boolean)
  const lines: string[] = []
  let cur = ''
  for (const w of words) {
    if (textWidth(w, size, bold) > maxW) return null
    const next = cur ? `${cur} ${w}` : w
    if (textWidth(next, size, bold) <= maxW) cur = next
    else { lines.push(cur); cur = w }
  }
  if (cur) lines.push(cur)
  return lines
}

/**
 * Text centred in a fw x fd mm box: the bold name (wrapped onto two lines when
 * needed) plus extra lines. `extras` lists alternative sets of extra lines in
 * order of preference (say with and without the height); trailing extra lines
 * are dropped and the font shrinks from 3.2 mm to 2.5 mm before giving up.
 * Text runs along the long axis of a tall box.
 */
function boxLabel(cx: number, cy: number, fw: number, fd: number, name: string, extras: string[][] = [[]], fill = INK): LabelResult {
  const rotate = fd > fw * 1.25
  const along = (rotate ? fd : fw) - 1.6
  const cross = (rotate ? fw : fd) - 1
  const first = asciiText(name)
  const sizes = [3.2, 2.8, F_MIN]
  const maxKeep = Math.max(...extras.map((e) => e.length))
  for (let keep = maxKeep; keep >= 0; keep--) {
    for (const alt of extras) {
      if (alt.length < keep) continue
      for (const size of sizes) {
        const nameLines = wrapWords(first, along, size, true)
        if (!nameLines || nameLines.length > 2) continue
        const restSize = Math.max(F_MIN, size * 0.9)
        const rest = alt.slice(0, keep).map(asciiText)
        if (rest.some((r) => textWidth(r, restSize) > along)) continue
        const all = [...nameLines.map((n) => ({ t: n, bold: true, s: size })), ...rest.map((r) => ({ t: r, bold: false, s: restSize }))]
        const total = all.reduce((acc, l) => acc + l.s * 1.18, 0)
        if (total > cross) continue
        const out: string[] = []
        let y = -total / 2
        const wMax = Math.max(...all.map((l) => textWidth(l.t, l.s, l.bold)))
        for (const l of all) {
          out.push(text(0, y + l.s * 0.95, l.t, { size: l.s, bold: l.bold, anchor: 'middle', fill }))
          y += l.s * 1.18
        }
        const g = `<g transform="translate(${r2(cx)} ${r2(cy)})${rotate ? ' rotate(-90)' : ''}">${out.join('')}</g>`
        const box = rotate ? { x: cx - total / 2, y: cy - wMax / 2, w: total, h: wMax } : { x: cx - wMax / 2, y: cy - total / 2, w: wMax, h: total }
        return { svg: g, boxes: [box], drawn: true }
      }
    }
  }
  return { svg: '', boxes: [], drawn: false }
}

function numberBadge(x: number, y: number, n: number): string {
  return `<circle cx="${r2(x)}" cy="${r2(y)}" r="2" fill="${PAPER}" stroke="${INK}" stroke-width="0.25"/>` + text(x, y + 0.9, `${n}`, { size: F_MIN, bold: true, anchor: 'middle' })
}

/** The item's outline in its own (unrotated) coordinates, centred on 0,0, in mm. */
function itemShape(it: Item, k: number, opts: { cutLine?: boolean } = {}): string {
  const w = it.w * k, d = it.d * k
  const fill = tint(it.color, isRugKind(it.kind) ? 0.45 : 0.62)
  const stroke = `stroke="${INK}" stroke-width="0.3"`
  const out: string[] = []
  const cut = opts.cutLine ? `stroke="#8f867d" stroke-width="0.25" stroke-dasharray="1.4 0.9" fill="none"` : ''
  if (it.kind === 'rug' || (it.kind === 'table' && it.w === it.d)) {
    out.push(`<circle r="${r2(w / 2)}" fill="${fill}" ${stroke}/>`)
    if (cut) out.push(`<circle r="${r2(w / 2 + CUT)}" ${cut}/>`)
  } else if (it.kind === 'rugRect') {
    out.push(`<rect x="${r2(-w / 2)}" y="${r2(-d / 2)}" width="${r2(w)}" height="${r2(d)}" rx="1.5" fill="${fill}" ${stroke} stroke-dasharray="0.8 0.5"/>`)
    if (cut) out.push(`<rect x="${r2(-w / 2 - CUT)}" y="${r2(-d / 2 - CUT)}" width="${r2(w + 2 * CUT)}" height="${r2(d + 2 * CUT)}" rx="2.2" ${cut}/>`)
  } else {
    out.push(`<rect x="${r2(-w / 2)}" y="${r2(-d / 2)}" width="${r2(w)}" height="${r2(d)}" rx="0.4" fill="${fill}" ${stroke}/>`)
    if (cut) out.push(`<rect x="${r2(-w / 2 - CUT)}" y="${r2(-d / 2 - CUT)}" width="${r2(w + 2 * CUT)}" height="${r2(d + 2 * CUT)}" rx="1" ${cut}/>`)
    if (it.kind === 'bed') {
      const hb = Math.min(d, 8 * k)
      out.push(`<rect x="${r2(-w / 2)}" y="${r2(-d / 2)}" width="${r2(w)}" height="${r2(hb)}" fill="${shade(it.color, 0.28)}"/>`)
    }
    if (it.kind === 'sofa') {
      const back = Math.min(20 * k, d * 0.25)
      out.push(`<rect x="${r2(-w / 2)}" y="${r2(-d / 2)}" width="${r2(w)}" height="${r2(back)}" fill="${shade(it.color, 0.2)}"/>`)
    }
    if (it.kind === 'wardrobe' || it.kind === 'dresser' || it.kind === 'bookcase' || it.kind === 'shelf') {
      // the back (wall side) of storage pieces
      out.push(`<line x1="${r2(-w / 2)}" y1="${r2(-d / 2 + 0.7)}" x2="${r2(w / 2)}" y2="${r2(-d / 2 + 0.7)}" stroke="${shade(it.color, 0.3)}" stroke-width="0.5"/>`)
    }
  }
  return out.join('')
}

/** A small arrow inside the piece pointing at its back edge (headboard / wall side). */
function backArrow(it: Item, k: number): string {
  const d = it.d * k
  const y0 = -d / 2
  if (isRugKind(it.kind) || (it.kind === 'table' && it.w === it.d)) return ''
  const s = Math.min(2, d / 4)
  return `<path d="M 0 ${r2(y0 + 0.6)} L ${r2(-s * 0.55)} ${r2(y0 + 0.6 + s)} L ${r2(s * 0.55)} ${r2(y0 + 0.6 + s)} Z" fill="${INK}"/>`
}

/* ---------- measured plan ---------- */

interface LegendRow {
  n: number
  item: Item
}

const LEGEND_RH = 4.4
const LEGEND_HEAD = 5.5

/** The furniture table in the given horizontal span (defaults to the full drawing width). */
function legendTable(f: Frame, rows: LegendRow[], y: number, unit: Unit, span?: { x: number; w: number }): string {
  const draw = span ?? f.draw
  const compact = draw.w < 150
  const cols = [
    { title: '#', w: 7, align: 'middle' as const },
    { title: 'Item', w: 0, align: 'start' as const },
    { title: compact ? 'Size (w x d x h)' : 'Size (w x d x h)', w: compact ? 34 : 40, align: 'start' as const },
    { title: compact ? 'From left' : 'From left wall', w: compact ? 20 : 28, align: 'end' as const },
    { title: compact ? 'From back' : 'From back wall', w: compact ? 20 : 28, align: 'end' as const },
  ]
  const fixed = cols.reduce((a, c) => a + c.w, 0)
  cols[1].w = Math.max(20, draw.w - fixed)
  const xs: number[] = []
  let x = draw.x
  for (const c of cols) { xs.push(x); x += c.w }
  const cell = (ci: number, yy: number, s: string, o: TextOpts = {}) => {
    const c = cols[ci]
    const cx = c.align === 'start' ? xs[ci] + 1.5 : c.align === 'end' ? xs[ci] + c.w - 1.5 : xs[ci] + c.w / 2
    return text(cx, yy, s, { size: F_MIN, anchor: c.align, ...o })
  }
  const out: string[] = []
  out.push(rect({ x: draw.x, y, w: draw.w, h: LEGEND_HEAD }, `fill="#f1ece6"`))
  cols.forEach((c, i) => out.push(cell(i, y + 3.7, c.title, { bold: true })))
  let yy = y + LEGEND_HEAD
  rows.forEach((r, i) => {
    if (i % 2 === 1) out.push(rect({ x: draw.x, y: yy, w: draw.w, h: LEGEND_RH }, `fill="#faf7f3"`))
    const rc = rectOf(r.item)
    const base = yy + LEGEND_RH * 0.72
    out.push(cell(0, base, `${r.n}`, { bold: true }))
    out.push(cell(1, base, r.item.name))
    out.push(cell(2, base, asciiSize(r.item.w, r.item.d, unit, isRugKind(r.item.kind) ? undefined : r.item.h)))
    out.push(cell(3, base, asciiLength(Math.max(0, rc.x0), unit)))
    out.push(cell(4, base, asciiLength(Math.max(0, rc.y0), unit)))
    yy += LEGEND_RH
  })
  out.push(line(draw.x, yy, draw.x + draw.w, yy, RULE, 0.25))
  return out.join('')
}

/**
 * Distance ticks from every solid item to its nearest side wall and nearest
 * back/front wall. A run is slid along its item so it does not cross other
 * items' text, and labels dodge each other and the item text.
 */
function drawTicks(room: Room, items: Item[], p: RoomPlacement, unit: Unit, textBoxes: Box[]): string {
  const { ox, oy, k } = p
  const out: string[] = []
  const size = F_MIN
  const taken: Box[] = [...textBoxes]
  const crossesText = (b: Box) => textBoxes.some((t) => rectsOverlap(t, b, 0.4))

  // wall labels (window / door text) are off limits for the outside-the-wall fallback
  for (const o of [...room.windows, ...room.doors]) {
    const isDoor = 'hinge' in o
    const s = isDoor ? doorLabel(o as Door, unit) : windowLabel(o, unit)
    const tw = textWidth(s, size) + 1
    const dist = isDoor && (o as Door).swing === 'out' ? o.width * k + 1.4 : 1.4
    const [cx, cy] = wallPoint(room, o.wall, o.offset + o.width / 2)
    const X = ox + cx * k, Y = oy + cy * k
    const along = { x: X - tw / 2, w: tw }
    if (o.wall === 'top') taken.push({ ...along, y: Y - p.WT - dist - size, h: size + 0.6 })
    else if (o.wall === 'bottom') taken.push({ ...along, y: Y + p.WT + dist - 0.4, h: size + 0.6 })
    else if (o.wall === 'left') taken.push({ x: X - p.WT - dist - size, y: Y - tw / 2, w: size + 0.6, h: tw })
    else taken.push({ x: X + p.WT + dist - 0.4, y: Y - tw / 2, w: size + 0.6, h: tw })
  }

  type Placed = { box: Box; rotate: number }
  const place = (cx: number, cy: number, run: number, s: string, axis: 'x' | 'y', wall: Wall): Placed => {
    const w = textWidth(s, size, true) + 1.6
    const h = size + 1.1
    // a label longer than its run slides toward the room side so it does not sit on the wall
    const slide = Math.max(0, (w - run) / 2 + 0.6)
    const step = axis === 'x' ? h + 0.5 : w / 2 + 0.6
    const near = axis === 'x'
      ? [-(h / 2 + 0.5), h / 2 + 0.5, -(step + h / 2 + 0.5), step + h / 2 + 0.5, -(2 * step + h / 2 + 0.5), 2 * step + h / 2 + 0.5]
      : [w / 2 + 0.8, -(w / 2 + 0.8), w / 2 + 0.8 + h + 0.4, -(w / 2 + 0.8 + h + 0.4), 0]
    const far = axis === 'x'
      ? [-(3 * step + h / 2 + 0.5), 3 * step + h / 2 + 0.5, -(4 * step + h / 2 + 0.5), 4 * step + h / 2 + 0.5]
      : [w / 2 + 2 * (h + 0.4) + 0.8, -(w / 2 + 2 * (h + 0.4) + 0.8)]
    const alongs = [0, -run * 0.2, run * 0.2, -run * 0.35, run * 0.35]
    const free = (box: Box) => !taken.some((t) => rectsOverlap(t, box, 0.3))
    const tryOffsets = (offsets: number[]): Placed | null => {
      for (const off of offsets) {
        for (const a of alongs) {
          const box = axis === 'x'
            ? { x: cx + a + (wall === 'left' ? slide : -slide) - w / 2, y: cy + off - h / 2, w, h }
            : { x: cx + off - w / 2, y: cy + a + (wall === 'top' ? slide : -slide) - h / 2, w, h }
          if (free(box)) { taken.push(box); return { box, rotate: 0 } }
        }
      }
      return null
    }
    const nearHit = tryOffsets(near)
    if (nearHit) return nearHit
    // just outside the wall the run starts from, reading along the wall
    const outside: Placed = wall === 'left'
      ? { box: { x: ox - p.WT - 1 - h, y: cy - w / 2, w: h, h: w }, rotate: -90 }
      : wall === 'right'
        ? { box: { x: ox + p.W + p.WT + 1, y: cy - w / 2, w: h, h: w }, rotate: 90 }
        : wall === 'top'
          ? { box: { x: cx - w / 2, y: oy - p.WT - 1 - h, w, h }, rotate: 0 }
          : { box: { x: cx - w / 2, y: oy + p.D + p.WT + 1, w, h }, rotate: 0 }
    if (free(outside.box)) { taken.push(outside.box); return outside }
    const farHit = tryOffsets(far)
    if (farHit) return farHit
    const box = { x: cx - w / 2, y: cy - h / 2, w, h }
    taken.push(box)
    return { box, rotate: 0 }
  }
  const label = ({ box: b, rotate }: Placed, s: string) =>
    rect(b, `fill="${PAPER}" stroke="${PINK}" stroke-width="0.15" rx="0.6"`) +
    (rotate
      ? text(b.x + b.w / 2 + (rotate > 0 ? -size * 0.36 : size * 0.36), b.y + b.h / 2, s, { size, bold: true, anchor: 'middle', fill: PINK, rotate })
      : text(b.x + b.w / 2, b.y + b.h / 2 + size * 0.36, s, { size, bold: true, anchor: 'middle', fill: PINK }))
  const tick = (x1: number, y1: number, x2: number, y2: number, axis: 'x' | 'y') => {
    const t = 0.9
    return (
      line(x1, y1, x2, y2, PINK, 0.25) +
      (axis === 'x' ? line(x1, y1 - t, x1, y1 + t, PINK, 0.3) + line(x2, y2 - t, x2, y2 + t, PINK, 0.3) : line(x1 - t, y1, x1 + t, y1, PINK, 0.3) + line(x2 - t, y2, x2 + t, y2, PINK, 0.3))
    )
  }
  /** first of the candidate positions (cm) whose run does not cross another item's text */
  const route = (cands: number[], seg: (c: number) => Box) => cands.find((c) => !crossesText(seg(c))) ?? cands[0]

  const solid = items.filter((i) => i.inRoom && !isRugKind(i.kind))
  const runs: { svg: string; s: string; cx: number; cy: number; run: number; axis: 'x' | 'y'; wall: Wall }[] = []
  for (const it of solid) {
    const r = rectOf(it)
    const left = r.x0, right = room.w - r.x1, top = r.y0, bottom = room.d - r.y1
    const fw = r.x1 - r.x0, fd = r.y1 - r.y0
    const my = (r.y0 + r.y1) / 2, mx = (r.x0 + r.x1) / 2
    const horiz = left <= right ? { x1: 0, x2: r.x0, v: left } : { x1: r.x1, x2: room.w, v: right }
    const vert = top <= bottom ? { y1: 0, y2: r.y0, v: top } : { y1: r.y1, y2: room.d, v: bottom }
    if (horiz.v > 1) {
      const cy = route(
        [my, my - fd * 0.25, my + fd * 0.25, my - fd * 0.4, my + fd * 0.4],
        (c) => ({ x: ox + horiz.x1 * k, y: oy + c * k - 0.3, w: horiz.v * k, h: 0.6 }),
      )
      runs.push({
        svg: tick(ox + horiz.x1 * k, oy + cy * k, ox + horiz.x2 * k, oy + cy * k, 'x'),
        s: asciiLength(horiz.v, unit), cx: ox + ((horiz.x1 + horiz.x2) / 2) * k, cy: oy + cy * k, run: horiz.v * k, axis: 'x',
        wall: left <= right ? 'left' : 'right',
      })
    }
    if (vert.v > 1) {
      const cx = route(
        [mx, mx - fw * 0.25, mx + fw * 0.25, mx - fw * 0.4, mx + fw * 0.4],
        (c) => ({ x: ox + c * k - 0.3, y: oy + vert.y1 * k, w: 0.6, h: vert.v * k }),
      )
      runs.push({
        svg: tick(ox + cx * k, oy + vert.y1 * k, ox + cx * k, oy + vert.y2 * k, 'y'),
        s: asciiLength(vert.v, unit), cx: ox + cx * k, cy: oy + ((vert.y1 + vert.y2) / 2) * k, run: vert.v * k, axis: 'y',
        wall: top <= bottom ? 'top' : 'bottom',
      })
    }
  }
  for (const r of runs) out.push(r.svg)
  // short runs first: their labels have the fewest places to go
  for (const r of [...runs].sort((a, b) => a.run - b.run)) out.push(label(place(r.cx, r.cy, r.run, r.s, r.axis, r.wall), r.s))
  return out.join('')
}

interface ItemsResult {
  svg: string
  rows: LegendRow[]
  boxes: Box[]
}

/** Every in-room item with a tint, outline, name and size (or a number when there is no room for text). */
function drawItems(items: Item[], p: RoomPlacement, unit: Unit): ItemsResult {
  const { ox, oy, k } = p
  const inRoom = items.filter((i) => i.inRoom)
  const ordered = [...inRoom.filter((i) => isRugKind(i.kind)), ...inRoom.filter((i) => !isRugKind(i.kind))]
  const rows: LegendRow[] = inRoom.map((item, i) => ({ n: i + 1, item }))
  const numberOf = new Map(rows.map((r) => [r.item.id, r.n]))
  const out: string[] = []
  const boxes: Box[] = []
  const solidRects: Box[] = inRoom.filter((i) => !isRugKind(i.kind)).map((i) => {
    const r = rectOf(i)
    return { x: ox + r.x0 * k, y: oy + r.y0 * k, w: (r.x1 - r.x0) * k, h: (r.y1 - r.y0) * k }
  })
  for (const it of ordered) {
    const cx = ox + it.x * k, cy = oy + it.y * k
    out.push(`<g transform="translate(${r2(cx)} ${r2(cy)}) rotate(${it.rot})">${itemShape(it, k)}</g>`)
    const rc = rectOf(it)
    const fw = (rc.x1 - rc.x0) * k, fd = (rc.y1 - rc.y0) * k
    const round = it.kind === 'rug' || (it.kind === 'table' && it.w === it.d)
    const rug = isRugKind(it.kind)
    // a rug lies under other furniture: put its label on a part that shows
    const spots: [number, number][] = rug
      ? [[0, 0], [0, fd * 0.3], [0, -fd * 0.3], [-fw * 0.3, 0], [fw * 0.3, 0], [-fw * 0.25, fd * 0.25], [fw * 0.25, fd * 0.25], [-fw * 0.25, -fd * 0.25], [fw * 0.25, -fd * 0.25]]
      : [[0, 0]]
    let lab: LabelResult = { svg: '', boxes: [], drawn: false }
    for (const [dx, dy] of spots) {
      const shrink = rug ? 0.55 : 1
      const cand = boxLabel(cx + dx, cy + dy, fw * shrink, fd * shrink, it.name, [[asciiSize(it.w, it.d, unit)]])
      if (!cand.drawn) break
      if (!cand.boxes.some((b) => solidRects.some((s) => rectsOverlap(s, b)))) { lab = cand; break }
      if (dx === spots[spots.length - 1][0] && dy === spots[spots.length - 1][1]) lab = cand
    }
    const n = numberOf.get(it.id)!
    if (lab.drawn) {
      out.push(lab.svg)
      boxes.push(...lab.boxes)
      if (fw >= 16 && fd >= 12) {
        const bx = round ? cx - fw * 0.31 : ox + rc.x0 * k + 3
        const by = round ? cy - fd * 0.31 : oy + rc.y0 * k + 3
        out.push(numberBadge(bx, by, n))
        boxes.push({ x: bx - 2, y: by - 2, w: 4, h: 4 })
      }
    } else {
      out.push(numberBadge(cx, cy, n))
      boxes.push({ x: cx - 2, y: cy - 2, w: 4, h: 4 })
    }
  }
  return { svg: out.join(''), rows, boxes }
}

function subtitleParts(input: SheetInput, scale: number): string[] {
  const unitName = input.unit === 'in' ? 'inches' : 'centimetres'
  return [input.group ?? '', input.date ?? dateText(), unitName, `Scale ${scaleNote(scale, input.unit)}`]
}

/** The measured floor plan: room, furniture, distance ticks, legend. */
export function buildPlanSheets(input: SheetInput, opts: SheetOptions): Sheet[] {
  const { room, unit } = input
  const page = pageSize(opts.paper, opts.orientation, room)
  const f = frame(page)
  let p = placeRoom(room, f.draw)
  const title = `${input.title ?? room.name} - floor plan`
  const sub = subtitleParts(input, p.scale)

  // a wide page with room to spare puts the legend beside the plan instead of below it
  const SIDE_MIN = 120
  const spare = f.draw.w - (p.pads.l + p.pads.r + p.W)
  const side = spare >= SIDE_MIN ? { x: f.draw.x + p.pads.l + p.W + p.pads.r + 4, w: spare - 4 } : null
  if (side) p = { ...p, ox: f.draw.x + p.pads.l }

  const items = drawItems(input.items, p, unit)
  const ticks = drawTicks(room, input.items, p, unit, [...items.boxes])
  const roomSvg = drawRoom(room, p, unit)

  // legend: beside or below the room when the whole table fits there, otherwise on the following pages
  const rows = items.rows
  const perPage = Math.max(1, Math.floor((f.draw.h - LEGEND_HEAD - 2) / LEGEND_RH))
  const belowTop = p.oy + p.D + p.pads.b + 2
  const onBelow = Math.floor((f.draw.y + f.draw.h - belowTop - LEGEND_HEAD - 2) / LEGEND_RH)
  const onSide = side ? perPage : 0
  const chunks: LegendRow[][] = []
  let rest = rows
  let firstChunk: LegendRow[] = []
  let legendTop = belowTop
  let legendSpan: { x: number; w: number } | undefined
  if (rows.length > 0 && side && onSide >= rows.length) {
    firstChunk = rows
    rest = []
    legendTop = f.draw.y + 2
    legendSpan = side
  } else if (rows.length > 0 && onBelow >= rows.length) {
    firstChunk = rows
    rest = []
  }
  while (rest.length > 0) {
    chunks.push(rest.slice(0, perPage))
    rest = rest.slice(perPage)
  }
  const pageCount = 1 + chunks.length
  const notes: string[] = []
  if (!p.fits) notes.push('The room does not fit this paper even at 1:50; the plan is clipped.')

  const sheets: Sheet[] = []
  const body1 = [
    titleBlock(f, title, sub, 1, pageCount),
    roomSvg,
    items.svg,
    ticks,
    firstChunk.length > 0 ? legendTable(f, firstChunk, legendTop, unit, legendSpan) : '',
    firstChunk.length === 0 && chunks.length > 0 ? text(f.draw.x, belowTop + 3, `Furniture list on page 2.`, { size: F_MIN, fill: MUTED, italic: true }) : '',
    footer(f, unit),
  ].join('')
  sheets.push({ svg: svgDoc(page, body1), w: page.w, h: page.h, notes })
  chunks.forEach((chunk, i) => {
    const body = [
      titleBlock(f, `${input.title ?? room.name} - furniture list`, sub, i + 2, pageCount),
      legendTable(f, chunk, f.draw.y + 2, unit),
      footer(f, unit),
    ].join('')
    sheets.push({ svg: svgDoc(page, body), w: page.w, h: page.h })
  })
  return sheets
}

/* ---------- cut-out kit ---------- */

/** Every item (in the room or parked) as a piece to cut out, plus the empty room at the same scale on the last page. */
export function buildKitSheets(input: SheetInput, opts: SheetOptions): Sheet[] {
  const { room, unit } = input
  const page = pageSize(opts.paper, opts.orientation, room)
  const f = frame(page)
  const p = placeRoom(room, f.draw)
  const k = p.k
  const name = input.title ?? room.name
  const sub = subtitleParts(input, p.scale)

  const byId = new Map(input.items.map((i) => [i.id, i]))
  const pieces = input.items.map((it) => ({ id: it.id, w: it.w * k + 2 * CUT, h: it.d * k + 2 * CUT }))
  const packing = packPieces(pieces, f.draw.w, f.draw.h - 5, PACK_GAP)
  const pageCount = packing.pages.length + 1
  const notes: string[] = []
  if (packing.unplaced.length > 0) {
    const names = packing.unplaced.map((id) => {
      const it = byId.get(id)!
      return `${it.name} (${asciiSize(it.w, it.d, unit)})`
    })
    notes.push(`Too big for one page at this scale: ${names.join(', ')}.`)
  }
  if (!p.fits) notes.push('The room does not fit this paper even at 1:50; the room page is clipped.')

  const sheets: Sheet[] = []
  packing.pages.forEach((placed: PlacedPiece[], pi) => {
    const out: string[] = []
    out.push(titleBlock(f, `${name} - cut-out kit`, sub, pi + 1, pageCount))
    out.push(text(f.draw.x, f.draw.y + 3, 'Cut along the dashed lines. The small arrow marks the back of each piece (headboard / wall side).', { size: F_MIN, fill: MUTED, italic: true }))
    for (const pc of placed) {
      const it = byId.get(pc.id)!
      const cx = f.draw.x + pc.x + pc.w / 2
      const cy = f.draw.y + 5 + pc.y + pc.h / 2
      const arrow = backArrow(it, k)
      out.push(`<g transform="translate(${r2(cx)} ${r2(cy)})${pc.rotated ? ' rotate(90)' : ''}">${itemShape(it, k, { cutLine: true })}${arrow}</g>`)
      const fw = pc.w - 2 * CUT, fd = pc.h - 2 * CUT
      // keep the text clear of the back arrow (top edge, or the right edge of a turned piece)
      const arrowH = arrow ? Math.min(2, (it.d * k) / 4) + 1 : 0
      const parked = it.inRoom ? [] : ['not in room yet']
      const flat = asciiSize(it.w, it.d, unit)
      const extras = isRugKind(it.kind) ? [[flat, ...parked]] : [[asciiSize(it.w, it.d, unit, it.h), ...parked], [flat, ...parked]]
      out.push(pc.rotated
        ? boxLabel(cx - arrowH / 2, cy, fw - arrowH, fd, it.name, extras).svg
        : boxLabel(cx, cy + arrowH / 2, fw, fd - arrowH, it.name, extras).svg)
    }
    out.push(footer(f, unit))
    sheets.push({ svg: svgDoc(page, out.join('')), w: page.w, h: page.h, notes: pi === 0 ? notes : undefined })
  })

  const roomBody = [
    titleBlock(f, `${name} - empty room`, sub, pageCount, pageCount),
    drawRoom(room, p, unit, { hint: 'Arrange the paper furniture here' }),
    notes.length > 0 ? text(f.draw.x, f.draw.y + f.draw.h - 1, notes.join(' '), { size: F_MIN, fill: MUTED, italic: true }) : '',
    footer(f, unit),
  ].join('')
  sheets.push({ svg: svgDoc(page, roomBody), w: page.w, h: page.h, notes: packing.pages.length === 0 ? notes : undefined })
  return sheets
}

export function buildSheets(product: Product, input: SheetInput, opts: SheetOptions): Sheet[] {
  return product === 'kit' ? buildKitSheets(input, opts) : buildPlanSheets(input, opts)
}

/** The scale the room page uses on this paper (for the dialog). */
export function planScale(room: Room, opts: SheetOptions): number {
  const page = pageSize(opts.paper, opts.orientation, room)
  return placeRoom(room, frame(page).draw).scale
}

/* ---------- the whole house on one page ---------- */

/** Scales for a whole house: finer ones first, down to 1:200 for a big home on a small page. */
const HOUSE_SCALES = [...SCALES, 75, 100, 150, 200]

export interface HouseSheetInput {
  house: HouseDoc
  /** the house's rooms, by id (a room missing here is left off the page) */
  rooms: Record<string, { name: string; room: Room; items: Item[] }>
  unit: Unit
  date?: string
}

/**
 * The house plan: every room at its place on one page, each drawn as on its own floor plan (walls,
 * doors, windows, closets, labelled furniture) and turned with the room, its name the right way up,
 * at the finest scale that fits.
 */
export function buildHouseSheet(input: HouseSheetInput, opts: SheetOptions): Sheet {
  const { house, rooms, unit } = input
  const roomMap = new Map(Object.entries(rooms).map(([id, r]) => [id, r.room] as [string, Room]))
  const b = houseBounds(house, roomMap) ?? { x0: 0, y0: 0, x1: 100, y1: 100 }
  const bw = b.x1 - b.x0, bd = b.y1 - b.y0
  const page = pageSize(opts.paper, opts.orientation, { w: bw, d: bd })
  const f = frame(page)
  // room for the wall labels and each room's dimension lines round the edge
  const PAD = 14
  const scale = HOUSE_SCALES.find((s) => bw * mmPerCm(s) + PAD * 2 <= f.draw.w && bd * mmPerCm(s) + PAD * 2 <= f.draw.h) ?? HOUSE_SCALES[HOUSE_SCALES.length - 1]
  const k = mmPerCm(scale)
  const ox = f.draw.x + (f.draw.w - bw * k) / 2 - b.x0 * k
  const oy = f.draw.y + PAD - b.y0 * k
  const body: string[] = []
  const names: string[] = []
  for (const p of house.rooms) {
    const r = rooms[p.roomId]
    if (!r) continue
    // each room drawn in its own frame at the page origin, then moved and turned into place
    const place: RoomPlacement = { scale, k, ox: 0, oy: 0, W: r.room.w * k, D: r.room.d * k, WT: wallThickness(k), pads: roomPads(r.room, k), fits: true }
    const items = drawItems(r.items, place, unit)
    body.push(`<g transform="translate(${r2(ox + p.x * k)} ${r2(oy + p.y * k)}) rotate(${p.rot})">${drawRoom(r.room, place, unit)}${items.svg}</g>`)
    // the name, upright, in the middle of the room
    const out = roomOnPlan(r.room, p)
    const cx = out.reduce((s, q) => s + q[0], 0) / out.length, cy = out.reduce((s, q) => s + q[1], 0) / out.length
    names.push(text(ox + cx * k, oy + cy * k, r.name, { size: F_BODY * 1.4, bold: true, anchor: 'middle', fill: INK }))
  }
  const sub = [input.date ?? dateText(), unit === 'in' ? 'inches' : 'centimetres', `Scale ${scaleNote(scale, unit)}`]
  const svg = svgDoc(page, [titleBlock(f, `${house.name} - house plan`, sub, 1, 1), ...body, ...names, footer(f, unit)].join(''))
  const fits = bw * k + PAD * 2 <= f.draw.w && bd * k + PAD * 2 <= f.draw.h
  return { svg, w: page.w, h: page.h, notes: fits ? [] : ['The house does not fit this paper even at 1:200; the plan is clipped.'] }
}
