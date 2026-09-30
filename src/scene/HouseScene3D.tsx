import { OrbitControls } from '@react-three/drei'
import { Canvas, type ThreeEvent } from '@react-three/fiber'
import { useEffect, useMemo, useState } from 'react'
import * as THREE from 'three'
import { CLOSET_HEIGHT, closetRecessPolygon, isRugKind, roomPolygon, roomWalls, wallFacing, wallFrame, wallLength, type Polygon } from '../geometry'
import { houseBounds, levelOf, type HouseDoc, type HouseRoom } from '../house'
import type { AnyWall, Item, Room, RoomDoc } from '../types'
import { cm, shadeColor, useDisposable, WALL_T } from './util'

/*
 * The whole house in 3D, as a mass model: every room at its place on the house map, with its floor,
 * its walls (cut away at waist height by default, so you look in from above), door and window gaps,
 * closets, and its furniture as blocks of the right size and colour. Orbit and zoom like the room's
 * outside view; hover a room to light it up, click it to open it in the planner.
 *
 * It does not use the planner's 3D pieces (those follow the one room open in the planner); the
 * detailed room is one click away.
 */

/** How high the walls stand when cut away (m). */
const CUT = 1.1

interface Props {
  house: HouseDoc
  rooms: Record<string, RoomDoc>
  cutaway: boolean
  /** show the floors up to this one (a floor's rooms stand one storey above the one below) */
  upTo?: number
  onOpen: (roomId: string) => void
}

/** How high one storey is (m): the tallest ceiling in the house and a floor slab. */
function storeyHeight(rooms: Record<string, RoomDoc>) {
  return Math.max(2.4, ...Object.values(rooms).map((d) => cm(d.room.h))) + 0.3
}

export function HouseScene3D({ house: whole, rooms, cutaway, upTo = Infinity, onOpen }: Props) {
  // the floors up to the one on screen, each a storey above the last
  const house = useMemo(() => ({ ...whole, rooms: whole.rooms.filter((p) => levelOf(p) <= upTo) }), [whole, upTo])
  const storey = storeyHeight(rooms)
  const [hover, setHover] = useState<string | null>(null)
  const roomMap = useMemo(() => new Map(Object.entries(rooms).map(([id, d]) => [id, d.room] as [string, Room])), [rooms])
  const b = houseBounds(house, roomMap) ?? { x0: 0, y0: 0, x1: 600, y1: 400 }
  const cx = cm((b.x0 + b.x1) / 2), cz = cm((b.y0 + b.y1) / 2)
  const size = Math.max(cm(b.x1 - b.x0), cm(b.y1 - b.y0), 4)
  // aim at the middle of the floors shown: halfway up to the top one
  const top = house.rooms.length ? Math.max(0, ...house.rooms.map(levelOf)) * storey : 0
  const cy = top / 2
  const camera = useMemo(() => [cx - size * 0.55, cy + size * 0.95, cz + size * 1.05] as [number, number, number], [cx, cy, cz, size])

  return (
    <Canvas shadows dpr={[1, 2]} camera={{ position: camera, fov: 40, near: 0.1, far: 500 }} style={{ background: '#efe9e1' }} onPointerMissed={() => setHover(null)}>
      <hemisphereLight args={['#fffaf2', '#b9ab9a', 1.25]} />
      <directionalLight
        position={[cx - size, size * 1.6, cz + size * 0.8]}
        intensity={1.6}
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-size}
        shadow-camera-right={size}
        shadow-camera-top={size}
        shadow-camera-bottom={-size}
        shadow-bias={-0.0004}
      >
        <object3D attach="target" position={[cx, 0, cz]} />
      </directionalLight>
      {/* the ground around the house */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[cx, -0.01, cz]} receiveShadow>
        <planeGeometry args={[size * 6, size * 6]} />
        <meshStandardMaterial color="#e3dbd0" roughness={1} />
      </mesh>
      {house.rooms.map((p) => {
        const doc = rooms[p.roomId]
        if (!doc) return null
        return <HouseRoom3D key={p.roomId} place={p} doc={doc} cutaway={cutaway && levelOf(p) === Math.max(...house.rooms.map(levelOf))} lift={levelOf(p) * storey} lit={hover === p.roomId}
          onHover={(on) => setHover((h) => (on ? p.roomId : h === p.roomId ? null : h))}
          onOpen={() => onOpen(p.roomId)} />
      })}
      <OrbitControls makeDefault target={[cx, cy, cz]} maxPolarAngle={Math.PI / 2 - 0.08} minDistance={2} maxDistance={size * 4} enableDamping dampingFactor={0.12} />
    </Canvas>
  )
}

function HouseRoom3D({ place, doc, cutaway, lift, lit, onHover, onOpen }: {
  place: HouseRoom
  doc: RoomDoc
  cutaway: boolean
  /** how high its floor stands (m): its storey */
  lift: number
  lit: boolean
  onHover: (on: boolean) => void
  onOpen: () => void
}) {
  const { room, items } = doc
  const H = cutaway ? Math.min(CUT, cm(room.h)) : cm(room.h)
  // a click that ended an orbit drag is not a click
  const click = (e: ThreeEvent<MouseEvent>) => { e.stopPropagation(); if (e.delta < 6) onOpen() }
  const over = (e: ThreeEvent<PointerEvent>) => { e.stopPropagation(); onHover(true); document.body.style.cursor = 'pointer' }
  const out = () => { onHover(false); document.body.style.cursor = '' }
  const middle = useMemo(() => {
    const pts = roomPolygon(room)
    return [cm(pts.reduce((a, q) => a + q[0], 0) / pts.length), cm(pts.reduce((a, q) => a + q[1], 0) / pts.length)] as [number, number]
  }, [room])

  return (
    // plan x → world x, plan y → world z; a clockwise turn on the plan is a turn about -y
    <group position={[cm(place.x), lift, cm(place.y)]} rotation={[0, (-place.rot * Math.PI) / 180, 0]} onClick={click} onPointerOver={over} onPointerOut={out}>
      <FloorShape outline={roomPolygon(room)} color={room.floorColor} lit={lit} />
      {(room.closets ?? []).map((c) => <FloorShape key={c.id} outline={closetRecessPolygon(room, c)} color={shadeColor(room.floorColor, 0.92)} lit={lit} />)}
      {roomWalls(room).map((w) => <Wall key={w} room={room} wall={w} height={H} />)}
      {(room.closets ?? []).map((c) => <ClosetShell key={c.id} room={room} closetId={c.id} height={H} />)}
      {items.filter((i) => i.inRoom).map((it) => <Block key={it.id} item={it} />)}
      <Label text={doc.name} lit={lit} position={[middle[0], H + 0.45, middle[1]]} />
    </group>
  )
}

/**
 * A room's name floating over it: text drawn on a canvas, on a sprite that always faces the camera
 * (plain three.js, so nothing to mount in the page).
 */
function Label({ text, lit, position }: { text: string; lit: boolean; position: [number, number, number] }) {
  const { material, aspect } = useMemo(() => {
    const px = 44, pad = 22
    const c = document.createElement('canvas')
    const ctx = c.getContext('2d')!
    const font = `900 ${px}px Nunito, system-ui, sans-serif`
    ctx.font = font
    const w = Math.ceil(ctx.measureText(text).width) + pad * 2, h = px + pad * 1.2
    c.width = w
    c.height = h
    ctx.font = font
    ctx.fillStyle = lit ? '#e5407a' : 'rgba(255,255,255,0.92)'
    // a pill (arcs rather than roundRect, which older WebKit lacks)
    const r = h / 2
    ctx.beginPath()
    ctx.arc(r, r, r, Math.PI / 2, (3 * Math.PI) / 2)
    ctx.arc(w - r, r, r, (3 * Math.PI) / 2, Math.PI / 2)
    ctx.closePath()
    ctx.fill()
    ctx.fillStyle = lit ? '#ffffff' : '#2f2a26'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, pad, h / 2 + 2)
    const map = new THREE.CanvasTexture(c)
    map.colorSpace = THREE.SRGBColorSpace
    return { material: new THREE.SpriteMaterial({ map, depthTest: false, transparent: true }), aspect: w / h }
  }, [text, lit])
  useEffect(() => () => { material.map?.dispose(); material.dispose() }, [material])
  const height = 0.32
  return <sprite position={position} scale={[height * aspect, height, 1]} material={material} renderOrder={10} />
}

/** A floor in the shape of an outline (cm, on the plan). */
function FloorShape({ outline, color, lit }: { outline: Polygon; color: string; lit: boolean }) {
  // turned flat by the mesh (-90° about x), shape y becomes -z: the outline goes in with y negated
  const geo = useDisposable(useMemo(() => new THREE.ShapeGeometry(new THREE.Shape(outline.map(([x, y]) => new THREE.Vector2(cm(x), -cm(y))))), [outline]))
  return (
    <mesh geometry={geo} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.002, 0]} receiveShadow>
      <meshStandardMaterial color={color} roughness={0.85} emissive={lit ? '#e5407a' : '#000000'} emissiveIntensity={lit ? 0.18 : 0} />
    </mesh>
  )
}

/** Ends of a wall's boxes: the mitre at an outside corner, nothing at an inside one (as the room's 3D view does). */
function wallEnds(room: Room, wall: AnyWall): [number, number] {
  const walls = roomWalls(room)
  const n = walls.length
  const i = walls.indexOf(wall)
  const ext = (a: AnyWall, b: AnyWall) => {
    const u = wallFrame(room, a).along, v = wallFrame(room, b).along
    const cross = u[0] * v[1] - u[1] * v[0]
    if (cross < -1e-9) return 0
    const turn = Math.acos(Math.max(-1, Math.min(1, u[0] * v[0] + u[1] * v[1])))
    return Math.min(WALL_T * Math.tan(turn / 2), WALL_T * 4)
  }
  return [ext(walls[(i + n - 1) % n], wall), ext(wall, walls[(i + 1) % n])]
}

/**
 * One wall: solid boxes between its openings, the wall under each window's sill and over each
 * opening's head, all no higher than `height`; glass in the windows.
 */
function Wall({ room, wall, height }: { room: Room; wall: AnyWall; height: number }) {
  const f = wallFrame(room, wall)
  const L = cm(wallLength(room, wall))
  const [e0, e1] = wallEnds(room, wall)
  const color = room.wallColors[wallFacing(room, wall)]
  const openings = [
    ...room.windows.filter((o) => o.wall === wall).map((o) => ({ t0: cm(o.offset), t1: cm(o.offset + o.width), sill: cm(o.sill), head: cm(o.sill + o.height), glass: true })),
    ...room.doors.filter((o) => o.wall === wall).map((o) => ({ t0: cm(o.offset), t1: cm(o.offset + o.width), sill: 0, head: cm(o.height), glass: false })),
    ...(room.closets ?? []).filter((c) => c.wall === wall).map((c) => ({ t0: cm(c.offset), t1: cm(c.offset + c.width), sill: 0, head: cm(c.height ?? CLOSET_HEIGHT), glass: false })),
  ].sort((a, b) => a.t0 - b.t0)
  const pieces: { t0: number; t1: number; y0: number; y1: number }[] = []
  let cursor = 0
  for (const o of openings) {
    if (o.t0 > cursor) pieces.push({ t0: cursor, t1: o.t0, y0: 0, y1: height })
    if (o.sill > 0) pieces.push({ t0: o.t0, t1: o.t1, y0: 0, y1: Math.min(o.sill, height) })
    if (o.head < height) pieces.push({ t0: o.t0, t1: o.t1, y0: o.head, y1: height })
    cursor = Math.max(cursor, o.t1)
  }
  if (cursor < L) pieces.push({ t0: cursor, t1: L, y0: 0, y1: height })
  // the end pieces reach past the corners so they close up outside
  const first = pieces.reduce((m, p) => Math.min(m, p.t0), Infinity), last = pieces.reduce((m, p) => Math.max(m, p.t1), -Infinity)
  const angle = -Math.atan2(f.along[1], f.along[0])
  // the wall stands outside the room line: its middle is half a thickness out along -normal
  const at = (t: number, y: number): [number, number, number] => [cm(f.start[0]) + f.along[0] * t - f.normal[0] * (WALL_T / 2), y, cm(f.start[1]) + f.along[1] * t - f.normal[1] * (WALL_T / 2)]
  return (
    <group>
      {pieces.filter((p) => p.y1 - p.y0 > 0.005 && p.t1 - p.t0 > 0.005).map((p, i) => {
        const a = p.t0 - (Math.abs(p.t0 - first) < 1e-6 ? e0 : 0), z = p.t1 + (Math.abs(p.t1 - last) < 1e-6 ? e1 : 0)
        return (
          <mesh key={i} position={at((a + z) / 2, (p.y0 + p.y1) / 2)} rotation={[0, angle, 0]} castShadow receiveShadow>
            <boxGeometry args={[z - a, p.y1 - p.y0, WALL_T]} />
            <meshStandardMaterial color={color} roughness={0.9} />
          </mesh>
        )
      })}
      {openings.filter((o) => o.glass && o.sill < height).map((o, i) => {
        const top = Math.min(o.head, height)
        return (
          <mesh key={`g${i}`} position={at((o.t0 + o.t1) / 2, (o.sill + top) / 2)} rotation={[0, angle, 0]}>
            <boxGeometry args={[o.t1 - o.t0, top - o.sill, 0.01]} />
            <meshStandardMaterial color="#bcd6e8" transparent opacity={0.45} roughness={0.1} />
          </mesh>
        )
      })}
    </group>
  )
}

/** A closet's three walls behind the room's wall. */
function ClosetShell({ room, closetId, height }: { room: Room; closetId: string; height: number }) {
  const c = (room.closets ?? []).find((x) => x.id === closetId)!
  const [a, b, bb, aa] = closetRecessPolygon(room, c).map(([x, y]) => [cm(x), cm(y)] as [number, number])
  // a→b is the opening on the wall line; the closet's walls are b→bb, bb→aa, aa→a
  const side = (p: [number, number], q: [number, number], key: string) => {
    const len = Math.hypot(q[0] - p[0], q[1] - p[1])
    return (
      <mesh key={key} position={[(p[0] + q[0]) / 2, height / 2, (p[1] + q[1]) / 2]} rotation={[0, -Math.atan2(q[1] - p[1], q[0] - p[0]), 0]} castShadow receiveShadow>
        <boxGeometry args={[len + 0.06, height, 0.06]} />
        <meshStandardMaterial color={room.wallColors[wallFacing(room, c.wall)]} roughness={0.9} />
      </mesh>
    )
  }
  return <group>{side(b, bb, 's1')}{side(bb, aa, 's2')}{side(aa, a, 's3')}</group>
}

/** A piece of furniture as a block of its size and colour (a rug as a thin mat). */
function Block({ item }: { item: Item }) {
  const rug = isRugKind(item.kind)
  const h = rug ? 0.012 : Math.max(0.02, cm(item.h))
  return (
    <mesh position={[cm(item.x), h / 2 + (rug ? 0.004 : 0), cm(item.y)]} rotation={[0, (-item.rot * Math.PI) / 180, 0]} castShadow={!rug} receiveShadow>
      {item.kind === 'rug'
        ? <cylinderGeometry args={[cm(item.w) / 2, cm(item.w) / 2, h, 40]} />
        : <boxGeometry args={[cm(item.w), h, cm(item.d)]} />}
      <meshStandardMaterial color={item.color} roughness={0.75} />
    </mesh>
  )
}
