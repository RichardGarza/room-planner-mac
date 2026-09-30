import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { ContactShadows, Edges } from '@react-three/drei'
import { Select, Selection } from '@react-three/postprocessing'
import { useEffect, useMemo, useState } from 'react'
import { footprint } from '../geometry'
import { useHouses } from '../houses'
import { useLibrary } from '../library'
import { useStore } from '../store'
import { connectedDoors, walkThrough } from '../walkThrough'
import type { Item } from '../types'
import { Lights } from './Lights'
import { OutsideCamera, WalkControls } from './Cameras'
import { Shell } from './Shell'
import { Floor } from './Floor'
import { Furniture } from './Furniture'
import { Effects } from './Effects'
import { cm } from './util'

/* ---------------------------------- root ---------------------------------- */

const glProps = {
  antialias: true,
  stencil: true, // the world outside the windows is masked through the glass
  powerPreference: 'high-performance' as const,
  toneMapping: THREE.ACESFilmicToneMapping,
  toneMappingExposure: 0.95,
  outputColorSpace: THREE.SRGBColorSpace,
}

export function Scene3D() {
  const quality = useStore((s) => s.quality)
  const view = useStore((s) => s.view)
  return (
    <Canvas
      gl={glProps}
      shadows="percentage"
      frameloop="demand"
      dpr={quality === 'best' ? [1, 1.5] : [1, 1]}
      camera={{ fov: 55, near: 0.05, far: 80, position: [-1.8, 3.6, 5.6] }}
      onPointerMissed={() => useStore.getState().select(null)}
      style={{ cursor: view === 'walk' ? 'move' : 'default' }}
    >
      <SceneContents />
    </Canvas>
  )
}

/** Dev-only: expose renderer stats so a headless run can check the draw-call budget. */
function DevStats() {
  const gl = useThree((s) => s.gl)
  const scene = useThree((s) => s.scene)
  const camera = useThree((s) => s.camera)
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => {
    gl.info.autoReset = false
    const w = window as unknown as { __rpScene?: { scene: THREE.Scene; camera: THREE.Camera; invalidate: () => void } }
    w.__rpScene = { scene, camera, invalidate }
    return () => { gl.info.autoReset = true; delete w.__rpScene }
  }, [gl, scene, camera, invalidate])
  useFrame(() => {
    // runs before this frame renders, so the counters hold the whole previous frame (all passes)
    const w = window as unknown as { __rp?: { calls: number; triangles: number } }
    w.__rp = { calls: gl.info.render.calls, triangles: gl.info.render.triangles }
    gl.info.reset()
  })
  return null
}

/**
 * The canvas renders on demand, and several things change the picture without touching the
 * scene graph in a way r3f notices (a setting that only swaps a material, a store-driven
 * scale, the selection). Any planner store change requests a frame; it is cheap when nothing
 * moved, and it makes the repaint independent of how each component consumes the store.
 */
function StoreInvalidate() {
  const invalidate = useThree((s) => s.invalidate)
  useEffect(() => useStore.subscribe(() => invalidate()), [invalidate])
  return null
}

function SceneContents() {
  const room = useStore((s) => s.room)
  const items = useStore((s) => s.items)
  const view = useStore((s) => s.view)
  const daytime = useStore((s) => s.daytime)
  const quality = useStore((s) => s.quality)
  const selectedId = useStore((s) => s.selectedId)
  // opened from a house: the doors that lead into its other rooms can be walked through
  const roomId = useLibrary((s) => s.currentId)
  const houseRooms = useHouses((s) => s.rooms)
  const doorways = useMemo(
    () => (roomId ? connectedDoors(roomId).map((d) => ({ doorId: d.doorId, enter: () => void walkThrough(roomId, d.doorId) })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roomId, houseRooms, room.doors],
  )
  const [dragId, setDragId] = useState<string | null>(null)
  const W = cm(room.w), D = cm(room.d)
  const best = quality === 'best'

  return (
    <>
      <color attach="background" args={[daytime ? '#e9e3dc' : '#d6cfc8']} />
      <StoreInvalidate />
      <Lights room={room} daytime={daytime} quality={quality} />
      {view === 'outside' ? <OutsideCamera room={room} locked={dragId !== null} /> : <WalkControls room={room} items={items} doorways={doorways} />}
      <Shell room={room} />
      <Floor room={room} />
      <FloorDrag dragId={dragId} onEnd={() => setDragId(null)} />
      <Selection enabled={best}>
        {items.filter((i) => i.inRoom).map((it) => (
          <Select key={it.id} enabled={best && selectedId === it.id}>
            <Furniture item={it} onStartDrag={view === 'outside' ? () => setDragId(it.id) : undefined} />
          </Select>
        ))}
        {best && <Effects daytime={daytime} />}
      </Selection>
      {!best && items.filter((i) => i.inRoom && i.id === selectedId).map((it) => <SelectionBox key={it.id} item={it} />)}
      {/* Rendered once per change rather than every frame: drei's frame counter resets whenever this
          element re-renders, and SceneContents re-renders on every items / room / setting change,
          so a drag re-arms it each step while orbiting costs nothing. */}
      <ContactShadows position={[W / 2, 0.012, D / 2]} scale={[W + 0.6, D + 0.6]} far={1.6} blur={best ? 2.2 : 2} opacity={daytime ? 0.32 : 0.22} resolution={best ? 512 : 256} color="#3a2417" frames={1} />
      {import.meta.env.DEV && <DevStats />}
    </>
  )
}

/**
 * Moves the dragged item under the pointer by intersecting the pointer's ray with the floor plane,
 * and ends the drag wherever the pointer is released. Window-level listeners, not an r3f catcher
 * mesh: the furniture's hover handler stops propagation, so a catcher behind a tall piece never
 * saw the moves while the cursor stayed over the piece, and a release off the canvas never ended
 * the drag (the item kept following and the orbit stayed locked).
 */
function FloorDrag({ dragId, onEnd }: { dragId: string | null; onEnd: () => void }) {
  const camera = useThree((s) => s.camera)
  const gl = useThree((s) => s.gl)
  useEffect(() => {
    if (!dragId) return
    const ray = new THREE.Raycaster()
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
    const hit = new THREE.Vector3()
    const ndc = new THREE.Vector2()
    const move = (e: PointerEvent) => {
      const r = gl.domElement.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, camera)
      if (ray.ray.intersectPlane(floor, hit)) useStore.getState().dragTo(dragId, hit.x * 100, hit.z * 100)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', onEnd)
    window.addEventListener('pointercancel', onEnd)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', onEnd)
      window.removeEventListener('pointercancel', onEnd)
    }
  }, [dragId, onEnd, camera, gl])
  return null
}

/** Fast-quality selection feedback: a pink wire box around the selected item (no post-processing there). */
function SelectionBox({ item }: { item: Item }) {
  const { fw, fd } = footprint(item)
  const w = cm(fw) + 0.03, d = cm(fd) + 0.03, h = cm(item.h) + 0.015
  const geo = useMemo(() => new THREE.BoxGeometry(w, h, d), [w, h, d])
  useEffect(() => () => geo.dispose(), [geo])
  return (
    <group position={[cm(item.x), h / 2, cm(item.y)]}>
      <Edges geometry={geo} color="#e5407a" lineWidth={1.5} toneMapped={false} depthTest={false} renderOrder={5} />
    </group>
  )
}
