import * as THREE from 'three'
import { Environment, Lightformer } from '@react-three/drei'
import { useLayoutEffect, useMemo, useRef, type RefObject } from 'react'
import { wallAxes, wallPoint } from '../geometry'
import { useStore } from '../store'
import type { Room } from '../types'
import { cm } from './util'

/* --------------------------------- lights --------------------------------- */

/*
 * Day and evening share one light rig (sun/moon, sky fill, ambient, pendant spot + spill)
 * and only change colours and intensities, so toggling never recompiles the materials.
 */

type Quality = 'best' | 'fast'

/** How far below the ceiling the pendant's light source sits (the shade's centre; the fixture is drawn in Shell). */
export const PENDANT_DROP = 0.3

/** Direction (world) from the room out through the first window, and the window's centre. */
function windowFrame(room: Room) {
  const win = room.windows[0]
  const W = cm(room.w)
  if (!win) return { centre: new THREE.Vector3(W / 2, 1.5, 0), out: new THREE.Vector3(0, 0, -1), along: new THREE.Vector3(1, 0, 0) }
  const [px, py] = wallPoint(room, win.wall, win.offset + win.width / 2)
  const { normal, along } = wallAxes(win.wall, room)
  return {
    centre: new THREE.Vector3(cm(px), cm(win.sill + win.height / 2), cm(py)),
    out: new THREE.Vector3(-normal[0], 0, -normal[1]), // wallAxes' normal points into the room
    along: new THREE.Vector3(along[0], 0, along[1]),
  }
}

/**
 * Shadow maps are re-rendered only when the planner store changes (a moved item, a setting, the
 * room), never for a plain orbit or walk frame: those redraw the same casters from the same light.
 */
function useShadowOnDemand(ref: RefObject<THREE.DirectionalLight | THREE.SpotLight | null>) {
  useLayoutEffect(() => {
    const l = ref.current
    if (!l) return
    l.shadow.autoUpdate = false
    l.shadow.needsUpdate = true
    return useStore.subscribe(() => { l.shadow.needsUpdate = true })
  }, [ref])
}

/** Sun (or moon): a directional light outside the window whose shadow frustum is fitted to the room box. */
function Sun({ room, quality, color, intensity, elevation, dir }: { room: Room; quality: Quality; color: string; intensity: number; elevation: number; dir: THREE.Vector3 }) {
  const ref = useRef<THREE.DirectionalLight>(null)
  const W = cm(room.w), D = cm(room.d), H = cm(room.h)
  const { position, target } = useMemo(() => {
    const { centre } = windowFrame(room)
    const d = dir.clone()
    d.y = 0
    d.normalize().multiplyScalar(Math.cos(elevation))
    d.y = Math.sin(elevation)
    return { target: new THREE.Vector3(W / 2, 0.4, D / 2), position: centre.clone().add(d.multiplyScalar(9)) }
  }, [room, dir, elevation, W, D])

  useLayoutEffect(() => {
    const light = ref.current
    if (!light) return
    light.target.position.copy(target)
    light.target.updateMatrixWorld()
    // Fit the orthographic shadow camera to the room's bounding box as seen from the light.
    const f = target.clone().sub(position).normalize()
    const right = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize()
    const up = new THREE.Vector3().crossVectors(right, f).normalize()
    let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity, n = Infinity, fa = -Infinity
    const m = 0.3
    for (const [x, y, z] of [[-m, -m, -m], [W + m, -m, -m], [-m, H + m, -m], [W + m, H + m, -m], [-m, -m, D + m], [W + m, -m, D + m], [-m, H + m, D + m], [W + m, H + m, D + m]]) {
      const v = new THREE.Vector3(x, y, z).sub(position)
      const px = v.dot(right), py = v.dot(up), pz = v.dot(f)
      l = Math.min(l, px); r = Math.max(r, px); b = Math.min(b, py); t = Math.max(t, py); n = Math.min(n, pz); fa = Math.max(fa, pz)
    }
    const cam = light.shadow.camera
    cam.left = l; cam.right = r; cam.bottom = b; cam.top = t
    cam.near = Math.max(0.1, n - 0.5); cam.far = fa + 0.5
    cam.updateProjectionMatrix()
    light.shadow.needsUpdate = true
  }, [position, target, W, D, H])
  useShadowOnDemand(ref)

  const size = quality === 'best' ? 2048 : 1024
  return (
    <directionalLight
      ref={ref}
      position={position}
      color={color}
      intensity={intensity}
      castShadow
      shadow-mapSize={[size, size]}
      shadow-bias={-0.00015}
      shadow-normalBias={0.025}
      shadow-radius={quality === 'best' ? 3 : 1}
    />
  )
}

/** Pendant: a wide warm spot down from the shade (one shadow pass) plus a small unshadowed spill. */
function Pendant({ position, quality, on }: { position: [number, number, number]; quality: Quality; on: boolean }) {
  const ref = useRef<THREE.SpotLight>(null)
  useLayoutEffect(() => {
    const l = ref.current
    if (!l) return
    l.target.position.set(position[0], 0, position[2])
    l.target.updateMatrixWorld()
  }, [position])
  useShadowOnDemand(ref)
  const size = quality === 'best' ? 1024 : 512
  return (
    <>
      <spotLight
        ref={ref}
        position={position}
        intensity={on ? 6 : 0}
        color="#ffcf98"
        angle={1.25}
        penumbra={0.75}
        distance={6}
        decay={2}
        castShadow
        shadow-mapSize={[size, size]}
        shadow-bias={-0.0015}
        shadow-normalBias={0.03}
        shadow-camera-near={0.2}
        shadow-camera-far={8}
      />
      <pointLight position={[position[0], position[1] - 0.2, position[2]]} intensity={on ? 1.2 : 0} color="#ffd8b0" distance={5} decay={2} />
    </>
  )
}

export function Lights({ room, daytime, quality }: { room: Room; daytime: boolean; quality: Quality }) {
  const W = cm(room.w), D = cm(room.d), H = cm(room.h)
  const { out, along } = useMemo(() => windowFrame(room), [room])
  // The sun sits a little to one side of the window's normal, so the wedge it throws through the
  // opening lands on the floor across the room rather than sliding along the wall beside it.
  const sunDir = useMemo(() => out.clone().add(along.clone().multiplyScalar(-0.3)), [out, along])
  const moonDir = useMemo(() => out.clone().add(along.clone().multiplyScalar(-0.5)), [out, along])
  const envRes = quality === 'best' ? 128 : 64
  // Lightformer positions describe directions in the world frame (the env cube sits at the origin).
  const winDir: [number, number, number] = [out.x * 5, 1.2, out.z * 5]

  return (
    <>
      {/* With the roof closed the sun only reaches the room through the window, so the fill
          (ambient + hemisphere + environment) carries the general daylight and the sun draws the wedge. */}
      <ambientLight intensity={daytime ? 0.38 : 0.3} color={daytime ? '#fff1e4' : '#cfb8a6'} />
      {/* day: a cool sky over a pale warm floor bounce (so the ceiling reads bright, not tan);
          evening: a neutral warm-grey dusk, keeping the blue for the window only */}
      <hemisphereLight color={daytime ? '#d9e6ff' : '#6d6674'} groundColor={daytime ? '#e9e1d8' : '#6b4f3f'} intensity={daytime ? 1.1 : 0.4} />
      <Sun
        room={room}
        quality={quality}
        color={daytime ? '#fff1d8' : '#8fa3ff'}
        intensity={daytime ? 4 : 0.3}
        elevation={daytime ? 0.5 : 0.5}
        dir={daytime ? sunDir : moonDir}
      />
      <Pendant position={[W / 2, H - PENDANT_DROP, D / 2]} quality={quality} on={!daytime} />
      {/* image-based light: bright window, sky above, warm floor bounce, neutral sides (day);
          a warm lamp overhead with a faint blue window (evening) */}
      {daytime ? (
        <Environment key="day" resolution={envRes} frames={1} environmentIntensity={0.6}>
          <Lightformer form="rect" intensity={2.2} color="#fff6ea" scale={[3.2, 2.4, 1]} position={winDir} target={[0, 0, 0]} />
          <Lightformer form="circle" intensity={1.2} color="#dfe9ff" scale={9} position={[0, 6, 0]} rotation-x={Math.PI / 2} />
          <Lightformer form="rect" intensity={0.9} color="#eadfd2" scale={[10, 10, 1]} position={[0, -6, 0]} rotation-x={-Math.PI / 2} />
          <Lightformer form="rect" intensity={0.4} color="#f3ece5" scale={[6, 3, 1]} position={[-6, 1, 0]} rotation-y={Math.PI / 2} />
          <Lightformer form="rect" intensity={0.4} color="#f3ece5" scale={[6, 3, 1]} position={[6, 1, 0]} rotation-y={-Math.PI / 2} />
          <Lightformer form="rect" intensity={0.35} color="#efe6dd" scale={[6, 3, 1]} position={[0, 1, 6]} rotation-y={Math.PI} />
        </Environment>
      ) : (
        <Environment key="night" resolution={envRes} frames={1} environmentIntensity={0.5}>
          <Lightformer form="circle" intensity={2.5} color="#ffc98f" scale={2.2} position={[0, 5, 0]} rotation-x={Math.PI / 2} />
          <Lightformer form="rect" intensity={0.6} color="#5d6fbf" scale={[3, 2.2, 1]} position={winDir} target={[0, 0, 0]} />
          <Lightformer form="rect" intensity={0.3} color="#6b5a4e" scale={[10, 10, 1]} position={[0, -6, 0]} rotation-x={-Math.PI / 2} />
          <Lightformer form="rect" intensity={0.2} color="#5a4f48" scale={[6, 3, 1]} position={[-6, 1, 0]} rotation-y={Math.PI / 2} />
          <Lightformer form="rect" intensity={0.2} color="#5a4f48" scale={[6, 3, 1]} position={[6, 1, 0]} rotation-y={-Math.PI / 2} />
        </Environment>
      )}
    </>
  )
}
