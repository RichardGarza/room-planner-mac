import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { useLayoutEffect, useMemo, useRef } from 'react'
import { CLOSET_HEIGHT, cornerWalls, isCorner, roomPolygon, roomWalls, wallFrame, wallLength, wallSpan } from '../geometry'
import { useStore } from '../store'
import type { AnyWall, Door, Opening, Radiator as RadiatorSpec, Room } from '../types'
import { Closet } from './Closet'
import { PENDANT_DROP } from './Lights'
import { HALL_STENCIL, MASK_ORDER, MaskPlane, Outside, stencilTest, WORLD_ORDER } from './Outside'
import { ceilingMaps, fabricMaps, plasterMaps } from './textures'
import { cm, mergedBoxes, profileAlongX, seeded, starShape, useDisposable, WALL_T, worldUvBox, type BoxSpec } from './util'

/* ---------------------------------- shell --------------------------------- */

/**
 * Each wall gets a group whose local x runs along the wall (increasing offset),
 * local y is up and local +z points into the room. Everything on the wall is built
 * in those local coordinates, so a window or door can sit on any wall.
 */
export function wallTransform(room: Room, wall: AnyWall): { position: [number, number, number]; rotation: [number, number, number]; scale: [number, number, number] } {
  const W = cm(room.w), D = cm(room.d)
  switch (wall) {
    case 'top': return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
    case 'bottom': return { position: [0, 0, D], rotation: [0, Math.PI, 0], scale: [-1, 1, 1] }
    case 'left': return { position: [0, 0, 0], rotation: [0, -Math.PI / 2, 0], scale: [1, 1, -1] }
    case 'right': return { position: [W, 0, 0], rotation: [0, -Math.PI / 2, 0], scale: [1, 1, 1] }
    default: {
      // an angled corner wall: local x runs along it from its start, local +z into the room
      const { start, along, normal } = wallFrame(room, wall)
      const theta = Math.atan2(-along[1], along[0])
      // turning local x onto `along` puts local +z on (-along.y, along.x); mirror z when that faces out
      const flip = -along[1] * normal[0] + along[0] * normal[1] < 0
      return { position: [cm(start[0]), 0, cm(start[1])], rotation: [0, theta, 0], scale: [1, 1, flip ? -1 : 1] }
    }
  }
}

/**
 * How far each end of a wall's box reaches past its span so the outside corners close: the full
 * wall thickness at a square corner, WALL_T · tan(turn / 2) where it meets an angled wall.
 */
function wallEnds(room: Room, wall: AnyWall): [number, number] {
  const walls = roomWalls(room)
  const i = walls.indexOf(wall)
  const dirOf = (w: AnyWall) => wallFrame(room, w).along
  // the angle the wall line turns through at the joint: 90° at a square corner, 45° into a 45° cut
  const turn = (a: AnyWall, b: AnyWall) => {
    const u = dirOf(a), v = dirOf(b)
    return Math.acos(Math.min(1, Math.abs(u[0] * v[0] + u[1] * v[1])))
  }
  // the two ends of the part of a wall that is there (a side shortened by the cuts at its corners)
  const ends = (w: AnyWall): [[number, number], [number, number]] => {
    const f = wallFrame(room, w)
    const [s0, s1] = wallSpan(room, w)
    return [[f.start[0] + f.along[0] * s0, f.start[1] + f.along[1] * s0], [f.start[0] + f.along[0] * s1, f.start[1] + f.along[1] * s1]]
  }
  const neighbours = [walls[(i + walls.length - 1) % walls.length], walls[(i + 1) % walls.length]]
  const ext = (p: [number, number]) => {
    const other = neighbours.find((w) => ends(w).some((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < 1))
    return other ? WALL_T * Math.tan(turn(wall, other) / 2) : WALL_T
  }
  const [startPt, endPt] = ends(wall)
  return [ext(startPt), ext(endPt)]
}

export type Detail = 'best' | 'fast'

/* Shared materials: one instance per look, reused by every mesh that needs it. */
const matCache = new Map<string, THREE.Material>()
function sharedMat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = matCache.get(key) as T | undefined
  if (!m) { m = make(); matCache.set(key, m) }
  return m
}
export const paint = (color: string, roughness = 0.55) => sharedMat(`paint-${color}-${roughness}`, () => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0 }))
export const chrome = () => sharedMat('chrome', () => new THREE.MeshStandardMaterial({ color: '#b9bcc2', metalness: 0.9, roughness: 0.28 }))
export const brushed = () => sharedMat('brushed', () => new THREE.MeshStandardMaterial({ color: '#8f9094', metalness: 0.85, roughness: 0.42 }))
function clothMat(color: string, detail: Detail) {
  return sharedMat(`cloth-${color}-${detail}`, () => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 1, side: THREE.DoubleSide })
    if (detail === 'best') {
      const f = fabricMaps()
      f.bumpMap.repeat.set(10, 10)
      m.bumpMap = f.bumpMap
      m.bumpScale = 0.0025
    }
    return m
  })
}
/** A roller blind lit from behind by daylight: pale cloth with a soft glow of its own. */
function litBlindMat(detail: Detail) {
  return sharedMat(`blind-lit-${detail}`, () => {
    const m = new THREE.MeshStandardMaterial({ color: '#f1ece4', roughness: 1, side: THREE.DoubleSide, emissive: '#fff2dc', emissiveIntensity: 0.35 })
    if (detail === 'best') {
      const f = fabricMaps()
      m.bumpMap = f.bumpMap
      m.bumpScale = 0.0025
    }
    return m
  })
}
export function wallMat(color: string, detail: Detail) {
  return sharedMat(`wall-${color}-${detail}`, () => {
    const m = new THREE.MeshStandardMaterial({ color, roughness: 0.92, metalness: 0 })
    if (detail === 'best') {
      const p = plasterMaps(detail)
      p.bumpMap.repeat.set(1.7, 1.7)
      p.roughnessMap.repeat.set(1.7, 1.7)
      m.bumpMap = p.bumpMap
      m.bumpScale = 0.0035
      m.roughnessMap = p.roughnessMap
      m.roughness = 1
    }
    return m
  })
}
/* The outside of the walls, seen from the outside presets: neutral render, a paler top. */
const wallOuter = () => paint('#e6e0d8', 0.9)
const wallTop = () => paint('#f3efe9', 0.9)

const SKIRT_H = 0.12
const skirtProfile: [number, number][] = [[0, 0], [0.018, 0], [0.018, 0.092], [0.015, 0.1], [0.011, 0.104], [0.011, 0.111], [0.005, 0.118], [0, SKIRT_H]]
function corniceProfile(H: number): [number, number][] {
  const r = 0.075
  const pts: [number, number][] = [[0, H - r], [0, H], [r, H]]
  for (let i = 1; i <= 6; i++) {
    const a = Math.PI / 2 + (i / 6) * (Math.PI / 2)
    pts.push([r + r * Math.cos(a), H - r + r * Math.sin(a)])
  }
  return pts
}

export function Shell({ room }: { room: Room }) {
  const view = useStore((s) => s.view)
  const daytime = useStore((s) => s.daytime)
  const quality = useStore((s) => s.quality)
  const W = cm(room.w), D = cm(room.d), H = cm(room.h)
  const walls = useRef<Partial<Record<AnyWall, THREE.Group | null>>>({})
  const wallList = roomWalls(room)
  // each wall's line on the plan (m), to hide the walls between an outside camera and the room
  const frames = useMemo(() => wallList.map((w) => ({ wall: w, f: wallFrame(room, w) })), [room, wallList.join()])
  const ceiling = useRef<THREE.Group>(null)
  const pendant = useRef<THREE.Group>(null)
  const dir = useMemo(() => new THREE.Vector3(), [])

  useFrame(({ camera }) => {
    const c = camera.position
    const outside = view === 'outside'
    for (const { wall, f } of frames) {
      const g = walls.current[wall]
      if (!g) continue
      // how far the camera stands in front of the wall, on the room side (negative: outside it)
      const inFront = (c.x - cm(f.start[0])) * f.normal[0] + (c.z - cm(f.start[1])) * f.normal[1]
      g.visible = !(outside && inFront < -0.2)
    }
    // The ceiling faces down, so from above it is culled by itself; from outside below the
    // ceiling line it would hide the room, so it goes away there.
    if (ceiling.current) ceiling.current.visible = !(outside && c.y < H)
    // Looking steeply down from above the ceiling, the pendant reads as a white disc over the bed.
    camera.getWorldDirection(dir)
    if (pendant.current) pendant.current.visible = !(outside && c.y > H && -dir.y > 0.8)
  })

  // the ceiling follows the floor outline (cut corners included); UVs run 0..1 over the room box
  const outlineKey = JSON.stringify(roomPolygon(room))
  const ceilGeo = useDisposable(useMemo(() => {
    const g = new THREE.ShapeGeometry(new THREE.Shape(roomPolygon(room).map(([x, y]) => new THREE.Vector2(cm(x), cm(y)))))
    const pos = g.attributes.position
    const uv = new Float32Array(pos.count * 2)
    for (let i = 0; i < pos.count; i++) { uv[i * 2] = pos.getX(i) / W; uv[i * 2 + 1] = pos.getY(i) / D }
    g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
    return g
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outlineKey, W, D]))
  const ceilMat = useDisposable(useMemo(() => {
    const m = new THREE.MeshStandardMaterial({ color: '#f7f4ef', roughness: 1, envMapIntensity: 1.3, emissive: '#fffaf2', emissiveIntensity: 0 })
    if (quality === 'best') {
      const c = ceilingMaps()
      m.bumpMap = c.bumpMap
      m.bumpScale = 0.003
      m.roughnessMap = c.roughnessMap
    }
    return m
  }, [quality]))
  useLayoutEffect(() => {
    if (ceilMat.bumpMap) ceilMat.bumpMap.repeat.set(W, D)
    if (ceilMat.roughnessMap) ceilMat.roughnessMap.repeat.set(W, D)
  }, [ceilMat, W, D])
  useLayoutEffect(() => {
    // by day the ceiling is the brightest large surface in a room; a faint self-glow keeps it from going tan
    ceilMat.emissiveIntensity = daytime ? 0.07 : 0
  }, [ceilMat, daytime])

  return (
    <group>
      {/* shadow-only lid: always mounted, draws nothing, but stops the sun entering over the walls
          (the visible ceiling is hidden in some views and hidden objects cast no shadow) */}
      <mesh position={[W / 2, H + 0.01, D / 2]} rotation={[-Math.PI / 2, 0, 0]} castShadow>
        <planeGeometry args={[W + 2 * WALL_T + 0.1, D + 2 * WALL_T + 0.1]} />
        <meshBasicMaterial colorWrite={false} depthWrite={false} side={THREE.DoubleSide} />
      </mesh>
      {/* ceiling (underside only) */}
      <group ref={ceiling}>
        <mesh position={[0, H, 0]} rotation={[Math.PI / 2, 0, 0]} geometry={ceilGeo} material={ceilMat} receiveShadow />
      </group>
      <group ref={pendant}>
        <Pendant position={[W / 2, H, D / 2]} daytime={daytime} />
      </group>

      {wallList.map((wall) => {
        const t = wallTransform(room, wall)
        return (
          <group key={wall} ref={(g) => { walls.current[wall] = g }} position={t.position} rotation={t.rotation} scale={t.scale}>
            <WallFace room={room} wall={wall} daytime={daytime} detail={quality} />
          </group>
        )
      })}
    </group>
  )
}

/**
 * Pendant lamp: ceiling rose, a short flex, a fabric drum shade (an outer skin and a slightly
 * warmer inner skin so it has volume) and the bulb inside. The shade hangs PENDANT_DROP below
 * the ceiling, so its bottom clears 2.05 m in a 2.44 m room.
 */
function Pendant({ position, daytime }: { position: [number, number, number]; daytime: boolean }) {
  const SHADE_H = 0.18
  const top = -PENDANT_DROP + SHADE_H / 2
  const flexLen = -0.024 - top
  // by day a fabric shade; at night the lit shade is an even warm glow (unlit material), the bulb blooms
  const mats = useDisposable(useMemo(() => ({
    outerDay: new THREE.MeshStandardMaterial({ color: '#f6efe6', roughness: 1, side: THREE.FrontSide }),
    innerDay: new THREE.MeshStandardMaterial({ color: '#ece1d2', roughness: 1, side: THREE.BackSide }),
    outerNight: new THREE.MeshBasicMaterial({ color: '#f0c08a', side: THREE.FrontSide }),
    innerNight: new THREE.MeshBasicMaterial({ color: '#ffe2b8', side: THREE.BackSide }),
    bulb: new THREE.MeshStandardMaterial({ color: '#fff9ee', roughness: 0.4, emissive: '#ffd9a6', emissiveIntensity: 0 }),
    rose: new THREE.MeshStandardMaterial({ color: '#f1ece5', roughness: 0.7, emissive: '#ffcf98', emissiveIntensity: 0 }),
    dispose() { for (const m of [this.outerDay, this.innerDay, this.outerNight, this.innerNight, this.bulb, this.rose]) m.dispose() },
  }), []))
  const { outerDay, innerDay, outerNight, innerNight, bulb, rose } = mats
  useLayoutEffect(() => {
    bulb.emissiveIntensity = daytime ? 0 : 2.4
    rose.emissiveIntensity = daytime ? 0 : 0.3 // otherwise the rose sits in the spot's own shadow as a black crescent
  }, [daytime, bulb, rose])
  return (
    <group position={position}>
      <mesh position={[0, -0.012, 0]} material={rose}><cylinderGeometry args={[0.06, 0.07, 0.024, 20]} /></mesh>
      <mesh position={[0, -0.024 - flexLen / 2, 0]} material={paint('#6a6560', 0.8)}><cylinderGeometry args={[0.004, 0.004, flexLen, 8]} /></mesh>
      <mesh position={[0, -PENDANT_DROP, 0]} material={daytime ? outerDay : outerNight}>
        <cylinderGeometry args={[0.14, 0.16, SHADE_H, 28, 1, true]} />
      </mesh>
      <mesh position={[0, -PENDANT_DROP, 0]} material={daytime ? innerDay : innerNight}>
        <cylinderGeometry args={[0.137, 0.157, SHADE_H - 0.004, 28, 1, true]} />
      </mesh>
      <mesh position={[0, top, 0]} material={paint('#f1ece5', 0.7)}><cylinderGeometry args={[0.14, 0.14, 0.006, 28]} /></mesh>
      <mesh position={[0, -PENDANT_DROP + 0.02, 0]} material={bulb}><sphereGeometry args={[0.032, 16, 12]} /></mesh>
    </group>
  )
}

/** One wall in its local frame: solid plaster pieces around any openings, plus what hangs on it. */
export function WallFace({ room, wall, daytime, detail }: { room: Room; wall: AnyWall; daytime: boolean; detail: Detail }) {
  const L = cm(wallLength(room, wall)), H = cm(room.h)
  // the part of the wall that is there: a side stops where a cut corner starts
  const [span0, span1] = wallSpan(room, wall).map(cm)
  const [ext0, ext1] = wallEnds(room, wall)
  // an angled wall takes the colour of the side wall it turns into
  const color = room.wallColors[isCorner(wall) ? cornerWalls(wall).side : wall]
  const windows = room.windows.filter((o) => o.wall === wall)
  const doors = room.doors.filter((o) => o.wall === wall)
  const radiators = room.radiators.filter((o) => o.wall === wall)
  const closets = (room.closets ?? []).filter((o) => o.wall === wall)
  // a closet opening is cut like a door: from the floor up to its height
  const cuts = closets.map((c) => ({ offset: c.offset, width: c.width, sill: 0, height: c.height ?? CLOSET_HEIGHT }))
  const openings = [...windows, ...doors, ...cuts].sort((a, b) => a.offset - b.offset)
  const mat = wallMat(color, detail)
  const trim = paint('#f8f6f2', 0.5)
  // worldUvBox face order: +x, -x, +y, -y, +z (the room side), -z (outdoors)
  const faces = useMemo(() => [wallOuter(), wallOuter(), wallTop(), wallOuter(), mat, wallOuter()], [mat])

  // Solid pieces: split the wall at each opening's edges (overlapping openings just merge).
  const openingsKey = JSON.stringify(openings)
  const pieces = useMemo(() => {
    const out: { x: number; y: number; w: number; h: number }[] = []
    let cursor = span0
    for (const o of openings) {
      const o0 = Math.max(cursor, cm(o.offset)), o1 = Math.min(span1, cm(o.offset + o.width))
      if (o1 <= o0) continue
      const s = cm(o.sill), t = cm(o.sill + o.height)
      if (o0 > cursor) out.push({ x: (cursor + o0) / 2, y: H / 2, w: o0 - cursor, h: H })
      if (s > 0) out.push({ x: (o0 + o1) / 2, y: s / 2, w: o1 - o0, h: s })
      if (t < H) out.push({ x: (o0 + o1) / 2, y: (t + H) / 2, w: o1 - o0, h: H - t })
      cursor = o1
    }
    if (cursor < span1) out.push({ x: (cursor + span1) / 2, y: H / 2, w: span1 - cursor, h: H })
    // the end pieces reach past the wall's ends so the outside corners close up (see wallEnds)
    return out.map((p, i) => {
      const a = i === 0 && p.x - p.w / 2 <= span0 + 1e-6 ? ext0 : 0
      const b = i === out.length - 1 && p.x + p.w / 2 >= span1 - 1e-6 ? ext1 : 0
      return { ...p, x: p.x + (b - a) / 2, w: p.w + a + b, geo: worldUvBox(p.w + a + b, p.h, WALL_T) }
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [L, H, openingsKey, span0, span1, ext0, ext1])
  useDisposable(useMemo(() => pieces.map((p) => p.geo), [pieces]))

  // Skirting and cornice run along the wall; the skirting stops at each door and closet.
  const doorsKey = JSON.stringify(doors), cutsKey = JSON.stringify(cuts)
  const skirting = useDisposable(useMemo(() => {
    const runs: [number, number][] = []
    let sc = span0
    for (const d of [...doors, ...cuts].sort((a, b) => a.offset - b.offset)) {
      const d0 = cm(d.offset) - 0.05, d1 = cm(d.offset + d.width) + 0.05
      if (d0 > sc) runs.push([sc, d0])
      sc = Math.max(sc, d1)
    }
    if (sc < span1) runs.push([sc, span1])
    return runs.map(([a, b]) => profileAlongX(skirtProfile, a, b))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [span0, span1, doorsKey, cutsKey]))
  const cornice = useDisposable(useMemo(() => profileAlongX(corniceProfile(H), span0, span1), [H, span0, span1]))

  return (
    <group>
      {pieces.map((p, i) => (
        <mesh key={i} geometry={p.geo} material={faces} position={[p.x, p.y, -WALL_T / 2]} receiveShadow castShadow />
      ))}
      {skirting.map((g, i) => <mesh key={i} geometry={g} material={trim} castShadow receiveShadow />)}
      <mesh geometry={cornice} material={paint('#f9f7f3', 0.8)} />
      {windows.length > 0 && <Outside windows={windows} wallLength={L} daytime={daytime} detail={detail} />}
      {windows.map((w) => <Window key={w.id} win={w} daytime={daytime} detail={detail} />)}
      {radiators.map((r) => <Radiator key={r.id} radiator={r} />)}
      {doors.map((d) => <Doorway key={d.id} room={room} door={d} daytime={daytime} />)}
      {closets.map((c) => <Closet key={c.id} room={room} closet={c} detail={detail} />)}
      {(wall === 'left' || wall === 'right') && <Stars room={room} side={wall} span={[span0, span1]} />}
    </group>
  )
}

/** A pleated curtain: a plane whose depth follows a sine wave across its width, each fold a little different. */
function useCurtainGeometry(width: number, height: number, detail: Detail) {
  return useDisposable(useMemo(() => {
    const seg = detail === 'best' ? 48 : 16
    const g = new THREE.PlaneGeometry(width, height, seg, 3)
    const pos = g.getAttribute('position') as THREE.BufferAttribute
    const folds = Math.max(2, Math.round(width / 0.09))
    const rnd = seeded(Math.round(width * 1000) + 3)
    const foldAmp = Array.from({ length: folds + 1 }, () => 0.028 + rnd() * 0.014)
    const foldShift = Array.from({ length: folds + 1 }, () => (rnd() - 0.5) * 0.6)
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i)
      const t = (x / width + 0.5) * folds
      const f = Math.min(folds, Math.max(0, Math.floor(t)))
      const u = t * Math.PI * 2 + foldShift[f]
      const taper = 0.75 + 0.25 * ((y / height) + 0.5) // pleats get slightly flatter toward the hem
      pos.setZ(i, Math.sin(u) * foldAmp[f] * taper)
    }
    pos.needsUpdate = true
    g.computeVertexNormals()
    return g
  }, [width, height, detail]))
}

/** Unit-height blind cloth hanging from y = 0; the mesh scales it to the blind's drop. */
function useBlindGeometry(width: number) {
  return useDisposable(useMemo(() => new THREE.PlaneGeometry(width, 1).translate(0, -0.5, 0), [width]))
}

export function Window({ win, daytime, detail }: { win: Opening; daytime: boolean; detail: Detail }) {
  const blinds = useStore((s) => s.blinds)
  const x0 = cm(win.offset), ww = cm(win.width), s = cm(win.sill), hh = cm(win.height)
  const cx = x0 + ww / 2, cy = s + hh / 2
  const blindH = (hh * blinds) / 100
  const panes = Math.max(1, Math.round(win.width / 55))
  const transom = s + hh * 0.66
  const zMid = -WALL_T / 2
  const frame = paint('#fbfbfa', 0.45)
  const lining = paint('#f5f3ef', 0.7)
  const metal = chrome()
  const rodMetal = brushed()
  const cloth = clothMat('#e4dcd3', detail)
  const blindCloth = daytime ? litBlindMat(detail) : clothMat('#f1ece4', detail)
  const curtainTop = s + hh + 0.22
  const curtainBottom = Math.max(0.04, s - 0.28)
  const curtainH = curtainTop - curtainBottom
  const curtainW = 0.42
  const curtain = useCurtainGeometry(curtainW, curtainH, detail)
  const blindGeo = useBlindGeometry(ww + 0.08)
  const rings = useRef<THREE.InstancedMesh>(null)
  const ringCount = 12

  // Frame + transom + mullions as one geometry; the outer frame sits deep in the reveal.
  const sash = useDisposable(useMemo(() => {
    const boxes: BoxSpec[] = [
      [cx, s + 0.035, zMid + 0.01, ww, 0.07, 0.08],
      [cx, s + hh - 0.035, zMid + 0.01, ww, 0.07, 0.08],
      [x0 + 0.035, cy, zMid + 0.01, 0.07, hh, 0.08],
      [x0 + ww - 0.035, cy, zMid + 0.01, 0.07, hh, 0.08],
      [cx, transom, zMid + 0.01, ww, 0.04, 0.07],
    ]
    for (let i = 1; i < panes; i++) boxes.push([x0 + (i * ww) / panes, cy, zMid + 0.01, 0.04, hh, 0.07])
    // thin glazing beads around every pane
    for (let i = 0; i < panes; i++) {
      const px0 = x0 + (i * ww) / panes + 0.035, px1 = x0 + ((i + 1) * ww) / panes - 0.035
      boxes.push([(px0 + px1) / 2, s + 0.075, zMid + 0.035, px1 - px0, 0.012, 0.02])
      boxes.push([(px0 + px1) / 2, s + hh - 0.075, zMid + 0.035, px1 - px0, 0.012, 0.02])
    }
    return mergedBoxes(boxes)
  }, [cx, cy, s, hh, ww, x0, transom, panes, zMid]))

  const reveal = useDisposable(useMemo(() => mergedBoxes([
    [cx, s + 0.012, zMid, ww + 0.05, 0.024, WALL_T + 0.01],
    [cx, s + hh - 0.012, zMid, ww + 0.05, 0.024, WALL_T + 0.01],
    [x0 + 0.012, cy, zMid, 0.024, hh, WALL_T + 0.01],
    [x0 + ww - 0.012, cy, zMid, 0.024, hh, WALL_T + 0.01],
  ]), [cx, cy, s, hh, ww, x0, zMid]))

  // by night the glass is more of a mirror: the lit room reflects in it instead of a black void
  const glass = useDisposable(useMemo(() => new THREE.MeshPhysicalMaterial({
    color: daytime ? '#dbeeff' : '#8fa1c4',
    transparent: true,
    opacity: daytime ? 0.16 : 0.45,
    roughness: 0.04,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.04,
    envMapIntensity: daytime ? 1.6 : 3,
    side: THREE.DoubleSide,
    depthWrite: false,
  }), [daytime]))

  // curtain rings sit on the rod above each curtain's header
  useLayoutEffect(() => {
    const m = rings.current
    if (!m) return
    const o = new THREE.Object3D()
    const per = ringCount / 2
    let i = 0
    for (const x of [x0 - 0.2, x0 + ww + 0.2]) {
      for (let k = 0; k < per; k++) {
        o.position.set(x - curtainW / 2 + ((k + 0.5) / per) * curtainW, curtainTop + 0.02, 0.14)
        o.rotation.set(0, Math.PI / 2, 0)
        o.updateMatrix()
        m.setMatrixAt(i++, o.matrix)
      }
    }
    m.instanceMatrix.needsUpdate = true
  }, [x0, ww, curtainTop])

  return (
    <group>
      {/* reveal: the wall thickness lining the opening */}
      <mesh geometry={reveal} material={lining} receiveShadow />
      {/* glazing */}
      <mesh position={[cx, cy, zMid + 0.01]} material={glass} renderOrder={2}>
        <planeGeometry args={[ww, hh]} />
      </mesh>
      {/* frame, transom, mullions and beads */}
      <mesh geometry={sash} material={frame} castShadow receiveShadow />
      {/* window handle on the first pane */}
      <group position={[x0 + ww / panes - 0.08, transom - 0.13, zMid + 0.06]}>
        <mesh rotation={[Math.PI / 2, 0, 0]} material={metal}><cylinderGeometry args={[0.022, 0.022, 0.014, 14]} /></mesh>
        <mesh position={[0, -0.06, 0.014]} material={metal}><boxGeometry args={[0.014, 0.13, 0.014]} /></mesh>
      </group>
      {/* inner sill with a nosing and a small apron beneath */}
      <mesh position={[cx, s - 0.012, 0.075]} material={frame} castShadow receiveShadow><boxGeometry args={[ww + 0.2, 0.024, 0.27]} /></mesh>
      <mesh position={[cx, s - 0.034, 0.2]} material={frame}><boxGeometry args={[ww + 0.2, 0.02, 0.02]} /></mesh>
      <mesh position={[cx, s - 0.06, 0.008]} material={frame}><boxGeometry args={[ww + 0.14, 0.05, 0.016]} /></mesh>
      {/* roller blind: housing, cloth (always mounted, scaled to its drop so it casts a matching shadow), bottom bar and pull cord */}
      <mesh position={[cx, s + hh + 0.06, 0.05]} material={paint('#ecebe7', 0.7)} castShadow><boxGeometry args={[ww + 0.12, 0.09, 0.09]} /></mesh>
      <mesh geometry={blindGeo} position={[cx, s + hh + 0.02, 0.048]} scale={[1, Math.max(0.001, blindH + 0.02), 1]} material={blindCloth} castShadow />
      <mesh position={[cx, s + hh - blindH, 0.048]} material={paint('#dcd7cd', 0.8)}><boxGeometry args={[ww + 0.08, 0.02, 0.022]} /></mesh>
      <mesh position={[x0 + ww + 0.045, s + hh / 2 + 0.02, 0.09]} material={paint('#cfcac2', 0.9)}><cylinderGeometry args={[0.003, 0.003, hh, 6]} /></mesh>
      {/* curtain rod with finials and brackets, rings, and a pleated curtain with a header each side */}
      <mesh position={[cx, curtainTop + 0.02, 0.14]} rotation={[0, 0, Math.PI / 2]} material={rodMetal}><cylinderGeometry args={[0.013, 0.013, ww + 1.1, 12]} /></mesh>
      {[cx - ww / 2 - 0.55, cx + ww / 2 + 0.55].map((x, i) => (
        <mesh key={i} position={[x, curtainTop + 0.02, 0.14]} material={rodMetal}><sphereGeometry args={[0.03, 14, 10]} /></mesh>
      ))}
      {[cx - ww / 2 - 0.35, cx + ww / 2 + 0.35].map((x, i) => (
        <mesh key={i} position={[x, curtainTop + 0.02, 0.07]} rotation={[Math.PI / 2, 0, 0]} material={rodMetal}><cylinderGeometry args={[0.008, 0.008, 0.14, 8]} /></mesh>
      ))}
      <instancedMesh ref={rings} args={[undefined, undefined, ringCount]} material={rodMetal}>
        <torusGeometry args={[0.022, 0.004, 6, 14]} />
      </instancedMesh>
      {[x0 - 0.2, x0 + ww + 0.2].map((x, i) => (
        <group key={i}>
          <mesh geometry={curtain} material={cloth} position={[x, (curtainTop + curtainBottom) / 2, 0.12]} castShadow receiveShadow />
          <mesh position={[x, curtainTop - 0.03, 0.12]} material={cloth} castShadow><boxGeometry args={[curtainW + 0.02, 0.07, 0.06]} /></mesh>
        </group>
      ))}
    </group>
  )
}

export function Radiator({ radiator: r }: { radiator: RadiatorSpec }) {
  const x0 = cm(r.offset), w = cm(r.width), h = cm(r.height), d = cm(r.depth)
  const finCount = Math.max(4, Math.floor(r.width / 8))
  const y0 = 0.14 // bottom edge above the floor
  const white = paint('#f7f7f5', 0.45)
  const metal = chrome()
  const pipeLen = y0 + 0.08
  const fins = useDisposable(useMemo(() => mergedBoxes(Array.from({ length: finCount }, (_, i): BoxSpec => [-w / 2 + (i + 0.5) * (w / finCount), 0, 0, w / finCount - 0.012, h * 0.92, d])), [finCount, w, h, d]))
  return (
    <group position={[x0 + w / 2, y0 + h / 2, d / 2 + 0.02]}>
      {/* back panel and front convector fins */}
      <mesh material={white} castShadow><boxGeometry args={[w, h, d * 0.5]} /></mesh>
      <mesh geometry={fins} material={paint('#ffffff', 0.4)} castShadow receiveShadow />
      {/* top grille */}
      <mesh position={[0, h / 2 + 0.006, 0]} material={white}><boxGeometry args={[w, 0.012, d]} /></mesh>
      <mesh position={[0, h / 2 + 0.013, 0]} material={paint('#cfcfcc', 0.6)}><boxGeometry args={[w - 0.04, 0.004, d * 0.55]} /></mesh>
      {/* wall brackets */}
      {[-1, 1].map((sx) => (
        <mesh key={sx} position={[sx * (w / 2 - 0.12), -h * 0.2, -d / 2 - 0.012]} material={metal}><boxGeometry args={[0.03, h * 0.5, 0.024]} /></mesh>
      ))}
      {/* thermostat valve on the right, lockshield on the left, pipes down to the floor */}
      <group position={[w / 2 + 0.05, -h / 2 + 0.08, 0]}>
        <mesh rotation={[0, 0, Math.PI / 2]} material={white}><cylinderGeometry args={[0.024, 0.024, 0.07, 16]} /></mesh>
        <mesh rotation={[0, 0, Math.PI / 2]} position={[0.02, 0, 0]} material={paint('#d33b3b', 0.5)}><cylinderGeometry args={[0.026, 0.026, 0.008, 16]} /></mesh>
      </group>
      <mesh position={[-w / 2 - 0.05, -h / 2 + 0.08, 0]} rotation={[0, 0, Math.PI / 2]} material={metal}><cylinderGeometry args={[0.016, 0.016, 0.05, 12]} /></mesh>
      {[w / 2 + 0.08, -w / 2 - 0.07].map((x, i) => (
        <mesh key={i} position={[x, -h / 2 + 0.08 - pipeLen / 2, 0]} material={metal}><cylinderGeometry args={[0.009, 0.009, pipeLen, 10]} /></mesh>
      ))}
    </group>
  )
}

/* Hall materials are only ever seen through the doorway: they carry the door mask's stencil test. */
const hallMat = (color: string, roughness = 0.95) => sharedMat(`hall-${color}-${roughness}`, () => new THREE.MeshStandardMaterial({ color, roughness, metalness: 0, ...stencilTest(HALL_STENCIL) }))

export function Doorway({ room, door: d, daytime }: { room: Room; door: Door; daytime: boolean }) {
  const doorAngle = useStore((s) => s.doorAngle)
  const view = useStore((s) => s.view)
  const x0 = cm(d.offset), ww = cm(d.width), hh = cm(d.height), H = cm(room.h)
  const hallRef = useRef<THREE.Group>(null)
  const dir = useMemo(() => new THREE.Vector3(), [])
  // Looking steeply down from above the ceiling, the doorway's projection stretches over the hall
  // floor beyond the wall; the hall is for looking through the door, so it goes away there.
  useFrame(({ camera }) => {
    if (!hallRef.current) return
    camera.getWorldDirection(dir)
    hallRef.current.visible = !(view === 'outside' && camera.position.y > H && -dir.y > 0.8)
  })
  const cx = x0 + ww / 2
  // hinge 'left' = smaller offset. The leaf is built along local +x from the hinge and turns about y:
  // a negative turn takes +x toward local +z (into the room), a positive one toward -z (out of the room).
  // That matches doorSwing(), which mirrors the wall normal for swing "out".
  const hingeX = d.hinge === 'left' ? x0 : x0 + ww
  const phi = (doorAngle * Math.PI) / 180
  const into = d.swing === 'out' ? -1 : 1
  const leafRot = d.hinge === 'left' ? -phi * into : Math.PI + phi * into
  const trim = paint('#fbfaf7', 0.5)
  const leafPaint = paint('#f9f7f3', 0.5)
  const panelPaint = paint('#f2efe9', 0.6)
  const leafEdge = paint('#8d857c', 0.7)
  const metal = chrome()
  const hall = hallMat('#ddd6cc')
  const hallTrim = hallMat('#fbfaf7', 0.5)
  const LEAF_T = 0.045

  const jamb = useDisposable(useMemo(() => mergedBoxes([
    [x0 + 0.02, hh / 2, -WALL_T / 2, 0.04, hh, WALL_T],
    [x0 + ww - 0.02, hh / 2, -WALL_T / 2, 0.04, hh, WALL_T],
    [cx, hh + 0.02, -WALL_T / 2, ww + 0.08, 0.04, WALL_T],
  ]), [x0, ww, hh, cx]))
  // architrave on both faces of the wall, with a slightly heavier head piece
  const architrave = useDisposable(useMemo(() => {
    const boxes: BoxSpec[] = []
    for (const z of [0.012, -WALL_T - 0.012]) {
      boxes.push([x0 - 0.045, hh / 2 + 0.02, z, 0.085, hh + 0.04, 0.024])
      boxes.push([x0 + ww + 0.045, hh / 2 + 0.02, z, 0.085, hh + 0.04, 0.024])
      boxes.push([cx, hh + 0.085, z, ww + 0.2, 0.09, 0.024])
      boxes.push([cx, hh + 0.135, z * 1.15, ww + 0.22, 0.012, 0.03])
    }
    return mergedBoxes(boxes)
  }, [x0, ww, hh, cx]))
  // four raised panels on each face of the leaf
  const panels = useMemo(() => {
    const frames: BoxSpec[] = [], raised: BoxSpec[] = []
    const cols = [ww * 0.29, ww * 0.71], colW = ww * 0.31
    const rows: [number, number][] = [[hh * 0.72, hh * 0.36], [hh * 0.27, hh * 0.3]]
    for (const [z, dir] of [[LEAF_T + 0.002, 1], [-0.002, -1]] as [number, number][]) {
      for (const cxp of cols) for (const [y, ph] of rows) {
        frames.push([cxp, y, z, colW, ph, 0.006])
        raised.push([cxp, y, z + dir * 0.006, colW - 0.07, ph - 0.07, 0.008])
      }
    }
    return { frames: mergedBoxes(frames), raised: mergedBoxes(raised) }
  }, [ww, hh])
  useDisposable(useMemo(() => [panels.frames, panels.raised], [panels]))
  const hinges = useDisposable(useMemo(() => mergedBoxes([0.25, hh / 2, hh - 0.25].map((y): BoxSpec => [0.004, y, LEAF_T / 2, 0.012, 0.1, 0.012])), [hh]))

  return (
    <group>
      <mesh geometry={jamb} material={trim} receiveShadow />
      <mesh geometry={architrave} material={trim} castShadow receiveShadow />
      {/* threshold strip */}
      <mesh position={[cx, 0.006, -WALL_T / 2]} material={paint('#c9b79c', 0.6)}><boxGeometry args={[ww, 0.012, WALL_T + 0.02]} /></mesh>
      {/* leaf: panelled, with lever handles on both faces, three hinges and a dark top edge that reads from above */}
      <group position={[hingeX, 0, 0]} rotation={[0, leafRot, 0]}>
        <mesh position={[ww / 2, hh / 2 + 0.005, LEAF_T / 2]} material={leafPaint} castShadow receiveShadow>
          <boxGeometry args={[ww - 0.02, hh - 0.01, LEAF_T]} />
        </mesh>
        <mesh position={[ww / 2, hh - 0.003, LEAF_T / 2]} material={leafEdge}>
          <boxGeometry args={[ww - 0.02, 0.008, LEAF_T + 0.004]} />
        </mesh>
        <mesh geometry={panels.frames} material={panelPaint} position={[0, 0, 0]} />
        <mesh geometry={panels.raised} material={leafPaint} castShadow receiveShadow />
        {[
          [LEAF_T + 0.008, LEAF_T + 0.026],
          [-0.008, -0.026],
        ].map(([zr, zl], i) => (
          <group key={i} position={[ww - 0.09, 1.02, 0]}>
            <mesh position={[0, 0, zr]} rotation={[Math.PI / 2, 0, 0]} material={metal}><cylinderGeometry args={[0.026, 0.026, 0.012, 18]} /></mesh>
            <mesh position={[0, 0, zl]} rotation={[Math.PI / 2, 0, 0]} material={metal}><cylinderGeometry args={[0.008, 0.008, 0.03, 10]} /></mesh>
            <mesh position={[-0.055, 0, zl]} material={metal}><boxGeometry args={[0.12, 0.016, 0.016]} /></mesh>
          </group>
        ))}
        <mesh geometry={hinges} material={metal} />
      </group>
      {/* hallway beyond the door: floor, walls, ceiling, skirting, a picture and its own light.
          It is only drawn where the mask plane in the opening has stamped the stencil (see Outside
          for the same trick; the group orders put the mask ahead of the hall). Nothing here casts
          or receives the sun (its frustum edge would slice it); its own point light lights it day
          and night. */}
      <group ref={hallRef}>
      <group renderOrder={MASK_ORDER}>
        <MaskPlane x={cx} y={hh / 2} w={ww} h={hh} stencil={HALL_STENCIL} />
      </group>
      <group position={[cx, 0, 0]} renderOrder={WORLD_ORDER}>
        <mesh position={[0, 0, -1.2]} rotation={[-Math.PI / 2, 0, 0]} material={hallMat('#7a5443', 0.85)}>
          <planeGeometry args={[3, 2.4]} />
        </mesh>
        <mesh position={[0, H / 2, -2.4]} material={hall}>
          <planeGeometry args={[3, H]} />
        </mesh>
        {[-1.5, 1.5].map((x) => (
          <mesh key={x} position={[x, H / 2, -1.2]} rotation={[0, x < 0 ? Math.PI / 2 : -Math.PI / 2, 0]} material={hall}>
            <planeGeometry args={[2.4, H]} />
          </mesh>
        ))}
        <mesh position={[0, H, -1.2]} rotation={[Math.PI / 2, 0, 0]} material={hallMat('#f3efe9', 1)}>
          <planeGeometry args={[3, 2.4]} />
        </mesh>
        <mesh position={[0, 0.05, -2.385]} material={hallTrim}><boxGeometry args={[3, 0.1, 0.03]} /></mesh>
        {/* a small picture on the hall wall */}
        <mesh position={[0.55, 1.5, -2.38]} material={hallMat('#3b3733', 0.6)}><boxGeometry args={[0.42, 0.34, 0.02]} /></mesh>
        <mesh position={[0.55, 1.5, -2.368]} material={hallMat('#a9c1c8', 0.9)}><planeGeometry args={[0.36, 0.28]} /></mesh>
        <pointLight position={[0, H - 0.4, -1.2]} intensity={daytime ? 1.6 : 2.2} color={daytime ? '#fff1dc' : '#ffd9a8'} distance={4.5} decay={2} />
      </group>
      </group>
    </group>
  )
}

/** Little wall stars like the ones in the photo: subtle painted decals on the side walls. */
export function Stars({ room, side, span }: { room: Room; side: 'left' | 'right'; span: [number, number] }) {
  const ref = useRef<THREE.InstancedMesh>(null)
  const count = 26
  const H = cm(room.h)
  const wallColor = room.wallColors[side]
  const geo = useDisposable(useMemo(() => new THREE.ShapeGeometry(starShape(1), 2), []))
  const mat = useDisposable(useMemo(() => new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.6, transparent: true, opacity: 0.7, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2 }), []))
  useLayoutEffect(() => {
    const m = ref.current
    if (!m) return
    const rnd = seeded(side === 'left' ? 7 : 13)
    const o = new THREE.Object3D()
    const white = new THREE.Color('#ffffff'), wall = new THREE.Color(wallColor), c = new THREE.Color()
    for (let i = 0; i < count; i++) {
      const r = 0.022 + rnd() * 0.05
      o.position.set(span[0] + 0.3 + rnd() * (span[1] - span[0] - 0.6), 0.7 + rnd() * Math.max(0.3, H - 1.0), 0.003)
      o.rotation.set(0, 0, rnd() * Math.PI)
      o.scale.set(r, r, 1)
      o.updateMatrix()
      m.setMatrixAt(i, o.matrix)
      // painted on: each star is a different mix of white and the wall colour, not a grey sticker
      c.copy(wall).lerp(white, 0.5 + rnd() * 0.5)
      m.setColorAt(i, c)
    }
    m.instanceMatrix.needsUpdate = true
    if (m.instanceColor) m.instanceColor.needsUpdate = true
  }, [span[0], span[1], H, side, wallColor])
  return <instancedMesh ref={ref} args={[geo, mat, count]} />
}
