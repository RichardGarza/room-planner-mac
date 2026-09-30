import * as THREE from 'three'
import { useMemo } from 'react'
import { CLOSET_HEIGHT, closetInside, fractionInCloset, isRugKind, polygonOf, wallFacing } from '../geometry'
import { useStore } from '../store'
import type { Closet as ClosetSpec, Room } from '../types'
import { brushed, chrome, paint, wallMat, type Detail } from './Shell'
import { cm, mergedBoxes, shadeColor, useDisposable, WALL_T, type BoxSpec } from './util'

/*
 * A closet in a wall's local frame (x along the wall, y up, +z into the room). The wall slab
 * occupies z ∈ [-WALL_T, 0] and WallFace has already cut the opening out of it; the recess is
 * built behind that, from the wall line back to -depth, so it stays inside the wall's group and
 * disappears with the wall when the outside view hides it.
 */

const LEAF_T = 0.035
const ROD_Y = 1.68
const SHELF_Y = 1.86
const GARMENTS = ['#c9d6e3', '#e8d3c4', '#b9c8b0', '#d8c9dd', '#f0e6d2']

/** A soft dark gradient (alpha 1 → 0 across v) for faking the shade inside the recess. */
let shadeMap: THREE.Texture | null = null
function shadeTexture() {
  if (shadeMap) return shadeMap
  const c = document.createElement('canvas')
  c.width = 4
  c.height = 64
  const ctx = c.getContext('2d')!
  const g = ctx.createLinearGradient(0, 0, 0, 64)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 4, 64)
  shadeMap = new THREE.CanvasTexture(c)
  return shadeMap
}
const shadeMat = () => new THREE.MeshBasicMaterial({ color: '#2a2420', transparent: true, opacity: 0.32, alphaMap: shadeTexture(), depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 })

export function Closet({ room, closet: c, detail }: { room: Room; closet: ClosetSpec; detail: Detail }) {
  const doorAngle = useStore((s) => s.doorAngle)
  const view = useStore((s) => s.view)
  // furniture standing in the closet: the rail and the clothes make way for it (the shelf stays)
  const occupied = useStore((s) => s.items.some((it) => it.inRoom && !isRugKind(it.kind) && fractionInCloset(room, c, polygonOf(it)) > 0.02))
  // the opening (doors, jambs) and the inside (recess, floor, shelf, rail), which is wider in a walk-in
  const x0 = cm(c.offset), ww = cm(c.width), dd = cm(c.depth), hh = cm(c.height ?? CLOSET_HEIGHT), H = cm(room.h)
  const cx = x0 + ww / 2
  const inside = closetInside(c)
  const ix0 = cm(inside.offset), iww = cm(inside.width), icx = ix0 + iww / 2
  const zMid = -dd / 2
  const phi = (doorAngle * Math.PI) / 180
  const insideMat = wallMat('#f4f1eb', detail)
  const outside = wallMat(room.wallColors[wallFacing(room, c.wall)], detail)
  const trim = paint('#fbfaf7', 0.5)
  const leafPaint = paint('#f9f7f3', 0.5)
  const panelPaint = paint('#f2efe9', 0.6)
  const floor = paint(shadeColor(room.floorColor, 0.92), 0.8)
  const metal = chrome()
  const rod = brushed()
  const shade = useDisposable(useMemo(shadeMat, []))

  // recess shell: floor, back wall and two sides (boxes, so the outside faces read as wall from behind)
  const shell = useMemo(() => ({
    back: mergedBoxes([[icx, H / 2, -dd - WALL_T / 2, iww + 2 * WALL_T, H, WALL_T]]),
    sides: mergedBoxes([
      [ix0 - WALL_T / 2, H / 2, (-dd - WALL_T) / 2, WALL_T, H, dd - WALL_T],
      [ix0 + iww + WALL_T / 2, H / 2, (-dd - WALL_T) / 2, WALL_T, H, dd - WALL_T],
    ]),
  }), [icx, ix0, iww, dd, H])
  useDisposable(useMemo(() => [shell.back, shell.sides], [shell]))

  // jamb lining through the wall thickness and an architrave on the room face
  const jamb = useDisposable(useMemo(() => mergedBoxes([
    [x0 + 0.02, hh / 2, -WALL_T / 2, 0.04, hh, WALL_T],
    [x0 + ww - 0.02, hh / 2, -WALL_T / 2, 0.04, hh, WALL_T],
    [cx, hh + 0.02, -WALL_T / 2, ww + 0.08, 0.04, WALL_T],
  ]), [x0, ww, hh, cx]))
  const architrave = useDisposable(useMemo(() => mergedBoxes([
    [x0 - 0.045, hh / 2 + 0.02, 0.012, 0.085, hh + 0.04, 0.024],
    [x0 + ww + 0.045, hh / 2 + 0.02, 0.012, 0.085, hh + 0.04, 0.024],
    [cx, hh + 0.085, 0.012, ww + 0.2, 0.09, 0.024],
  ]), [x0, ww, hh, cx]))

  // shelf above the rod, the rod with its end brackets, a few hangers and some clothes on them
  const shelfY = Math.min(SHELF_Y, hh - 0.12)
  const rodY = Math.min(ROD_Y, shelfY - 0.18)
  const rodZ = zMid - 0.02
  const hangers = useMemo(() => {
    const n = Math.max(0, Math.min(7, Math.floor((iww - 0.3) / 0.11)))
    const start = ix0 + 0.2
    const metalBoxes: BoxSpec[] = [
      [ix0 + 0.03, rodY, rodZ, 0.03, 0.05, 0.05],
      [ix0 + iww - 0.03, rodY, rodZ, 0.03, 0.05, 0.05],
    ]
    const clothes: { color: string; x: number; h: number; w: number }[] = []
    for (let i = 0; i < n; i++) {
      const x = start + i * 0.11
      metalBoxes.push([x, rodY - 0.035, rodZ, 0.005, 0.07, 0.005]) // hook
      metalBoxes.push([x, rodY - 0.075, rodZ, 0.008, 0.014, Math.min(0.42, dd - 0.12)]) // shoulders
      if (i % 2 === 0) clothes.push({ color: GARMENTS[(i / 2) % GARMENTS.length], x, h: 0.62 + ((i * 7) % 3) * 0.12, w: Math.min(0.4, dd - 0.14) })
    }
    return { metal: mergedBoxes(metalBoxes), clothes }
  }, [iww, dd, ix0, rodY, rodZ])
  useDisposable(hangers.metal)

  const q = ww / 4
  const track = paint('#d9d5cd', 0.6)

  return (
    <group>
      {/* the recess */}
      <mesh geometry={shell.back} material={outside} castShadow receiveShadow />
      <mesh geometry={shell.sides} material={outside} castShadow receiveShadow />
      <mesh position={[icx, H / 2, -dd + 0.002]} material={insideMat} receiveShadow><planeGeometry args={[iww, H]} /></mesh>
      <mesh position={[ix0 + 0.002, H / 2, (-dd - WALL_T) / 2]} rotation={[0, Math.PI / 2, 0]} material={insideMat} receiveShadow><planeGeometry args={[dd - WALL_T, H]} /></mesh>
      <mesh position={[ix0 + iww - 0.002, H / 2, (-dd - WALL_T) / 2]} rotation={[0, -Math.PI / 2, 0]} material={insideMat} receiveShadow><planeGeometry args={[dd - WALL_T, H]} /></mesh>
      {/* in a walk-in, the back of the room wall on either side of the opening */}
      {ix0 < x0 && <mesh position={[(ix0 + x0) / 2, H / 2, -WALL_T - 0.002]} rotation={[0, Math.PI, 0]} material={insideMat} receiveShadow><planeGeometry args={[x0 - ix0, H]} /></mesh>}
      {ix0 + iww > x0 + ww && <mesh position={[(x0 + ww + ix0 + iww) / 2, H / 2, -WALL_T - 0.002]} rotation={[0, Math.PI, 0]} material={insideMat} receiveShadow><planeGeometry args={[ix0 + iww - x0 - ww, H]} /></mesh>}
      <mesh position={[icx, 0.001, zMid]} rotation={[-Math.PI / 2, 0, 0]} material={floor} receiveShadow><planeGeometry args={[iww, dd]} /></mesh>
      {view === 'walk' && (
        <mesh position={[icx, H - 0.001, zMid]} rotation={[Math.PI / 2, 0, 0]} material={paint('#f3efe9', 1)}><planeGeometry args={[iww, dd]} /></mesh>
      )}
      {/* soft shade on the floor and the back wall */}
      <mesh position={[icx, 0.004, zMid]} rotation={[-Math.PI / 2, 0, Math.PI]} material={shade}><planeGeometry args={[iww, dd]} /></mesh>
      <mesh position={[icx, 0.35, -dd + 0.006]} rotation={[0, 0, Math.PI]} material={shade}><planeGeometry args={[iww, 0.7]} /></mesh>
      {/* jamb, architrave, threshold */}
      <mesh geometry={jamb} material={trim} receiveShadow />
      <mesh geometry={architrave} material={trim} castShadow receiveShadow />
      <mesh position={[cx, 0.006, -WALL_T / 2]} material={paint('#c9b79c', 0.6)}><boxGeometry args={[ww, 0.012, WALL_T + 0.02]} /></mesh>
      {/* shelf, rod, hangers, clothes */}
      <mesh position={[icx, shelfY, (-dd - WALL_T) / 2]} material={trim} castShadow receiveShadow><boxGeometry args={[iww, 0.022, Math.max(0.1, dd - WALL_T - 0.04)]} /></mesh>
      {!occupied && <mesh position={[icx, rodY, rodZ]} rotation={[0, 0, Math.PI / 2]} material={rod} castShadow><cylinderGeometry args={[0.014, 0.014, iww - 0.02, 12]} /></mesh>}
      {!occupied && <mesh geometry={hangers.metal} material={metal} castShadow />}
      {!occupied && hangers.clothes.map((g, i) => (
        <mesh key={i} position={[g.x, rodY - 0.085 - g.h / 2, rodZ]} material={paint(g.color, 0.95)} castShadow receiveShadow>
          <boxGeometry args={[0.035, g.h, g.w]} />
        </mesh>
      ))}

      {/* doors */}
      {c.doors === 'hinged' && (
        <>
          {[0, 1].map((side) => (
            <group key={side} position={[side ? x0 + ww : x0, 0, 0]} rotation={[0, side ? Math.PI + phi : -phi, 0]}>
              <Leaf w={ww / 2} h={hh} paint={leafPaint} panel={panelPaint} />
              <mesh position={[ww / 2 - 0.06, 1.0, LEAF_T + 0.02]} material={metal}><sphereGeometry args={[0.018, 12, 10]} /></mesh>
            </group>
          ))}
        </>
      )}
      {c.doors === 'bifold' && (
        <>
          <mesh position={[cx, hh - 0.012, -0.03]} material={track}><boxGeometry args={[ww, 0.024, 0.05]} /></mesh>
          {[0, 1].map((side) => (
            <group key={side} position={[side ? x0 + ww : x0, 0, 0]} rotation={[0, side ? Math.PI + phi : -phi, 0]}>
              <Leaf w={q} h={hh - 0.03} paint={leafPaint} panel={panelPaint} />
              <group position={[q, 0, 0]} rotation={[0, side ? -2 * phi : 2 * phi, 0]}>
                <Leaf w={q} h={hh - 0.03} paint={leafPaint} panel={panelPaint} />
                <mesh position={[q - 0.05, 1.0, LEAF_T + 0.014]} material={metal}><sphereGeometry args={[0.014, 12, 10]} /></mesh>
              </group>
            </group>
          ))}
        </>
      )}
      {c.doors === 'sliding' && (
        <SlidingDoors x0={x0} ww={ww} hh={hh} slide={doorAngle / 90} paint={leafPaint} panel={panelPaint} track={track} metal={metal} />
      )}
    </group>
  )
}

/** A door leaf built along local +x from its hinge edge, with two raised panels on the room face. */
function Leaf({ w, h, paint: leafPaint, panel }: { w: number; h: number; paint: THREE.Material; panel: THREE.Material }) {
  const panels = useDisposable(useMemo(() => {
    const boxes: BoxSpec[] = []
    const pw = w - 0.12
    for (const [y, ph] of [[h * 0.7, h * 0.4], [h * 0.26, h * 0.32]] as [number, number][]) {
      boxes.push([w / 2, y, LEAF_T + 0.004, pw, ph, 0.008])
    }
    return mergedBoxes(boxes)
  }, [w, h]))
  return (
    <group>
      <mesh position={[w / 2, h / 2 + 0.005, LEAF_T / 2]} material={leafPaint} castShadow receiveShadow>
        <boxGeometry args={[w - 0.008, h - 0.01, LEAF_T]} />
      </mesh>
      <mesh geometry={panels} material={panel} />
    </group>
  )
}

/** Two panels in the wall thickness on a top track; the back one slides behind the front one. */
function SlidingDoors({ x0, ww, hh, slide, paint: leafPaint, panel, track, metal }: { x0: number; ww: number; hh: number; slide: number; paint: THREE.Material; panel: THREE.Material; track: THREE.Material; metal: THREE.Material }) {
  const pw = ww / 2 + 0.03
  const cx = x0 + ww / 2
  const zFront = -0.03, zBack = -0.075
  const frontX = x0 + ww - pw / 2
  const backX = x0 + pw / 2 + slide * (ww - pw)
  const panels = useDisposable(useMemo(() => mergedBoxes([
    [0, hh * 0.5, 0.017, pw - 0.16, hh * 0.86, 0.006],
  ]), [pw, hh]))
  return (
    <group>
      <mesh position={[cx, hh - 0.015, -WALL_T / 2]} material={track}><boxGeometry args={[ww, 0.03, WALL_T - 0.01]} /></mesh>
      {[[frontX, zFront], [backX, zBack]].map(([x, z], i) => (
        <group key={i} position={[x, 0, z]}>
          <mesh position={[0, hh / 2 - 0.01, 0]} material={leafPaint} castShadow receiveShadow><boxGeometry args={[pw, hh - 0.05, 0.03]} /></mesh>
          <mesh geometry={panels} material={panel} />
          <mesh position={[i === 0 ? -pw / 2 + 0.06 : pw / 2 - 0.06, 1.0, 0.018]} material={metal}><boxGeometry args={[0.02, 0.1, 0.006]} /></mesh>
        </group>
      ))}
    </group>
  )
}
