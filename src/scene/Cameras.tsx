import * as THREE from 'three'
import { useFrame, useThree } from '@react-three/fiber'
import { OrbitControls } from '@react-three/drei'
import { useEffect, useMemo, useRef } from 'react'
import { wallFrame } from '../geometry'
import { WALK_WALL_GAP, useStore, walkBlocked, type OutsideAngle } from '../store'
import type { AnyWall, Item, Room, Wall } from '../types'
import { cm } from './util'

/* --------------------------------- cameras -------------------------------- */

/**
 * The corner preset stands outside a corner looking across the room, so the two far walls are the
 * ones on show. It prefers a corner that shows the window wall (the room's hero view: the window,
 * its blinds and the daylight on the wall beside it), and of the two corners that do, the one whose
 * other visible wall has the door, then a closet, otherwise the corner across from the window so it
 * is seen face on. With no window it frames the door wall the same way; with neither it stands at
 * the bottom left. The "Door side" preset is the one that always faces the door.
 */
function cornerFor(room: Room): [number, number, number] {
  const W = cm(room.w), D = cm(room.d)
  const dx = 1.9, dz = 2.2, y = 3.6
  const closets = room.closets ?? []
  const hero = room.windows[0] ?? room.doors[0]
  // a camera on the left sees the right wall, one at the bottom sees the top wall
  const corners: { x: 'left' | 'right'; z: 'top' | 'bottom' }[] = [
    { x: 'left', z: 'bottom' }, { x: 'right', z: 'bottom' }, { x: 'left', z: 'top' }, { x: 'right', z: 'top' },
  ]
  const score = (c: (typeof corners)[number]) => {
    const seen: Wall[] = [c.x === 'left' ? 'right' : 'left', c.z === 'bottom' ? 'top' : 'bottom']
    const walls = (list: { wall: AnyWall }[]) => seen.filter((wall) => list.some((o) => o.wall === wall)).length
    let s = walls(room.windows) * 100 + walls(room.doors) * 10 + walls(closets)
    if (hero) {
      const mid = hero.offset + hero.width / 2
      const across = hero.wall === 'top' || hero.wall === 'bottom' ? (mid > room.w / 2 ? 'left' : 'right') === c.x : (mid > room.d / 2 ? 'top' : 'bottom') === c.z
      if (across) s += 0.5
    }
    return s
  }
  let best = corners[0], bestScore = -1
  for (const c of corners) {
    const s = score(c)
    if (s > bestScore) { best = c; bestScore = s }
  }
  return [best.x === 'left' ? -dx : W + dx, y, best.z === 'top' ? -dz : D + dz]
}

export const anglePositions = (room: Room): Record<OutsideAngle, [number, number, number]> => {
  const W = cm(room.w), D = cm(room.d)
  return {
    corner: cornerFor(room),
    above: [W / 2, 6.2, D / 2 + 0.01],
    window: [W / 2, 2.6, -3.2],
    door: [W / 2, 2.4, D + 3.4],
  }
}

export function OutsideCamera({ room, locked }: { room: Room; locked: boolean }) {
  const angle = useStore((s) => s.outsideAngle)
  const camera = useThree((s) => s.camera)
  const controls = useRef<any>(null)
  const W = cm(room.w), D = cm(room.d)
  // Only the room's size (and where its door sits) moves the orbit: typing a name or picking a colour must not reset it.
  const target = useMemo(() => new THREE.Vector3(W / 2, 0.8, D / 2), [W, D])
  const presetKey = `${room.doors[0]?.wall ?? ''}:${room.doors[0]?.offset ?? 0}:${room.windows.map((w) => w.wall).join()}:${(room.closets ?? []).map((c) => c.wall).join()}`
  const roomRef = useRef(room)
  roomRef.current = room
  useEffect(() => {
    const p = anglePositions(roomRef.current)[angle]
    camera.position.set(...p)
    camera.lookAt(target)
    controls.current?.target.copy(target)
    controls.current?.update()
  }, [angle, W, D, presetKey, camera, target])
  return <OrbitControls ref={controls} makeDefault enabled={!locked} target={target} maxPolarAngle={Math.PI / 2 - 0.05} minDistance={1.5} maxDistance={14} enableDamping dampingFactor={0.12} />
}

/** First-person field of view: wide enough to feel like standing in the room, not peering through a lens. */
const WALK_FOV = 75
/** radians of turn per pixel of mouse drag while walking (lower = calmer) */
const LOOK_SENSITIVITY = 0.0022

const typing = (t: EventTarget | null) => {
  const el = t as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/**
 * Walk mode. `doorways`: this room's doors that lead into another room of the house; walking into one
 * calls its `enter` (which opens the next room).
 */
export function WalkControls({ room, items, doorways = [] }: { room: Room; items: Item[]; doorways?: { doorId: string; enter: () => void }[] }) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  const invalidateView = useThree((s) => s.invalidate)

  // widen the lens while walking; the outside camera keeps its narrower view
  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    const previous = cam.fov
    cam.fov = WALK_FOV
    cam.updateProjectionMatrix()
    invalidateView()
    return () => {
      cam.fov = previous
      cam.updateProjectionMatrix()
      invalidateView()
    }
  }, [camera, invalidateView])
  const invalidate = useThree((s) => s.invalidate)
  const keys = useRef<Set<string>>(new Set())
  const walkHeight = useStore((s) => s.walkHeight)
  const lookScale = useStore((s) => s.lookSensitivity ?? 1)

  useEffect(() => {
    const el = gl.domElement
    const held = keys.current
    let last: { x: number; y: number } | null = null
    const down = (e: PointerEvent) => { last = { x: e.clientX, y: e.clientY }; el.setPointerCapture(e.pointerId) }
    const move = (e: PointerEvent) => {
      if (!last) return
      const dx = e.clientX - last.x, dy = e.clientY - last.y
      last = { x: e.clientX, y: e.clientY }
      const p = useStore.getState().walkPose
      useStore.getState().setWalkPose({ yaw: p.yaw - dx * LOOK_SENSITIVITY * lookScale, pitch: THREE.MathUtils.clamp(p.pitch - dy * LOOK_SENSITIVITY * lookScale, -1.2, 1.2) })
      invalidate()
    }
    const up = () => { last = null }
    const kd = (e: KeyboardEvent) => { if (!typing(e.target)) { held.add(e.key.toLowerCase()); invalidate() } }
    const ku = (e: KeyboardEvent) => held.delete(e.key.toLowerCase())
    // losing focus with W held must not leave the walker moving (and the demand loop spinning)
    const clear = () => held.clear()
    const vis = () => { if (document.visibilityState !== 'visible') held.clear() }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    window.addEventListener('keydown', kd)
    window.addEventListener('keyup', ku)
    window.addEventListener('blur', clear)
    document.addEventListener('visibilitychange', vis)
    return () => {
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      window.removeEventListener('keydown', kd)
      window.removeEventListener('keyup', ku)
      window.removeEventListener('blur', clear)
      document.removeEventListener('visibilitychange', vis)
      held.clear()
    }
  }, [gl, invalidate])

  // The canvas renders on demand: a walk preset or eye-height change must request a frame.
  useEffect(() => useStore.subscribe((s, prev) => { if (s.walkPose !== prev.walkPose || s.walkHeight !== prev.walkHeight) invalidate() }), [invalidate])

  useFrame((_, dt) => {
    const st = useStore.getState()
    const p = st.walkPose
    const k = keys.current
    const speed = 130 * Math.min(dt, 0.05) // cm per second
    let fwd = 0, side = 0
    if (k.has('w') || k.has('arrowup')) fwd += 1
    if (k.has('s') || k.has('arrowdown')) fwd -= 1
    if (k.has('d') || k.has('arrowright')) side += 1
    if (k.has('a') || k.has('arrowleft')) side -= 1
    let x = p.x, y = p.y
    if (fwd || side) {
      // camera looks along (-sin yaw, -cos yaw) in plan (x, y=z)
      const fx = -Math.sin(p.yaw), fy = -Math.cos(p.yaw)
      const rx = Math.cos(p.yaw), ry = -Math.sin(p.yaw)
      const nx = x + (fx * fwd + rx * side) * speed
      const ny = y + (fy * fwd + ry * side) * speed
      // the walls of the room's shape (a drawn one too) and the furniture keep you in
      const blocked = (px: number, py: number) => walkBlocked(room, items, px, py)
      // stepping into a door that leads into another room goes through it
      const through = doorways.find(({ doorId }) => {
        const door = room.doors.find((d) => d.id === doorId)
        if (!door) return false
        const f = wallFrame(room, door.wall)
        const t = (nx - f.start[0]) * f.along[0] + (ny - f.start[1]) * f.along[1]
        const depth = (nx - f.start[0]) * f.normal[0] + (ny - f.start[1]) * f.normal[1]
        return t > door.offset + 15 && t < door.offset + door.width - 15 && depth < WALK_WALL_GAP + 2
      })
      if (through) {
        keys.current.clear()
        through.enter()
        return
      }
      if (!blocked(nx, y)) x = nx
      if (!blocked(x, ny)) y = ny
      if (x !== p.x || y !== p.y) st.setWalkPose({ x, y })
      invalidate() // keep walking while a key is held (the canvas renders on demand)
    }
    const eye = walkHeight === 'adult' ? 1.62 : 1.08
    camera.position.set(cm(x), eye, cm(y))
    camera.rotation.order = 'YXZ'
    camera.rotation.set(p.pitch, p.yaw, 0)
  })
  return null
}
