import { type ThreeEvent } from '@react-three/fiber'
import { useMemo, useState } from 'react'
import { isRugKind } from '../geometry'
import { useStore } from '../store'
import type { Item } from '../types'
import { cm } from './util'
import { Bed } from './furniture/Bed'
import { BoxItem } from './furniture/Boxes'
import { Chair } from './furniture/Chair'
import { Desk, Table } from './furniture/Desk'
import { FxContext, type Fx } from './furniture/materials'
import { PlantItem } from './furniture/Plant'
import { RectRug, RoundRug } from './furniture/Rug'
import { Bookcase, CubeShelf } from './furniture/Shelves'
import { Sofa } from './furniture/Sofa'
import { Dresser, Nightstand, Wardrobe } from './furniture/Storage'

/* -------------------------------- furniture ------------------------------- */

/**
 * One piece of furniture in the 3D scene. The outer group is positioned by the
 * item's footprint centre and rotation and handles select / drag / hover; the
 * kind-specific components under src/scene/furniture build the actual shape.
 */
export function Furniture({ item, onStartDrag }: { item: Item; onStartDrag?: () => void }) {
  const selected = useStore((s) => s.selectedId === item.id)
  const quality = useStore((s) => s.quality)
  const daytime = useStore((s) => s.daytime)
  // stable stacking order among the rugs so overlapping rugs never z-fight
  const stack = useStore((s) => (isRugKind(item.kind) ? s.items.filter((i) => i.inRoom && isRugKind(i.kind)).findIndex((i) => i.id === item.id) : 0))
  const select = useStore((s) => s.select)
  const snapshot = useStore((s) => s.snapshot)
  const [hover, setHover] = useState(false)

  const onDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation()
    select(item.id)
    if (onStartDrag) { snapshot(); onStartDrag() }
  }

  // The tint is deliberately subtle: selection is carried by the floor outline
  // (and the post-processing outline on best quality), not by recolouring bedding.
  const fx = useMemo<Fx>(
    () => ({
      emissive: selected || hover ? '#ff7a3d' : '#000000',
      ei: selected ? 0.08 : hover ? 0.04 : 0,
      fast: quality === 'fast',
      night: !daytime,
    }),
    [selected, hover, quality, daytime],
  )

  return (
    <group
      position={[cm(item.x), 0, cm(item.y)]}
      rotation={[0, (-item.rot * Math.PI) / 180, 0]}
      onPointerDown={onDown}
      onPointerOver={(e) => { e.stopPropagation(); setHover(true) }}
      onPointerOut={() => setHover(false)}
    >
      <FxContext.Provider value={fx}>
        <Piece item={item} stack={Math.max(0, stack)} />
        {selected && <Footprint item={item} />}
      </FxContext.Provider>
    </group>
  )
}

export default Furniture

/**
 * A piece as it looks in its room, to look at only (the whole-house 3D view): the same model,
 * placed by its footprint centre and rotation, with no selecting or dragging.
 */
export function FurnitureModel({ item, stack = 0, bedding }: { item: Item; stack?: number; bedding?: boolean }) {
  const fx = useMemo<Fx>(() => ({ emissive: '#000000', ei: 0, fast: false, night: false }), [])
  return (
    <group position={[cm(item.x), 0, cm(item.y)]} rotation={[0, (-item.rot * Math.PI) / 180, 0]}>
      <FxContext.Provider value={fx}>
        <Piece item={item} stack={stack} bedding={bedding} />
      </FxContext.Provider>
    </group>
  )
}

function Piece({ item, stack, bedding }: { item: Item; stack: number; bedding?: boolean }) {
  switch (item.kind) {
    case 'bed': return <Bed item={item} bedding={bedding} />
    case 'chair': return <Chair item={item} />
    case 'desk': return <Desk item={item} />
    case 'table': return <Table item={item} />
    case 'dresser': return <Dresser item={item} />
    case 'nightstand': return <Nightstand item={item} />
    case 'wardrobe': return <Wardrobe item={item} />
    case 'bookcase': return <Bookcase item={item} />
    case 'shelf': return <CubeShelf item={item} />
    case 'sofa': return <Sofa item={item} />
    case 'rug': return <RoundRug item={item} stack={stack} />
    case 'rugRect': return <RectRug item={item} stack={stack} />
    case 'plant': return <PlantItem item={item} />
    default: return <BoxItem item={item} />
  }
}

/**
 * Pink outline of the footprint on the floor while the item is selected: a bold
 * band with a soft outer halo, drawn just above rug height so it stays visible
 * when the piece stands on a rug.
 */
function Footprint({ item }: { item: Item }) {
  const w = cm(item.w) + 0.06, d = cm(item.d) + 0.06
  const t = 0.035
  const halo = 0.06
  const y = 0.02
  if (item.kind === 'rug') {
    const R = w / 2
    return (
      <group position={[0, y, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <mesh>
          <ringGeometry args={[R, R + t, 64]} />
          <meshBasicMaterial color="#e5407a" depthWrite={false} toneMapped={false} />
        </mesh>
        <mesh>
          <ringGeometry args={[R + t, R + t + halo, 64]} />
          <meshBasicMaterial color="#e5407a" transparent opacity={0.22} depthWrite={false} toneMapped={false} />
        </mesh>
      </group>
    )
  }
  const band = (ww: number, dd: number, tt: number): [number, number, number, number][] => [
    [0, -dd / 2 + tt / 2, ww, tt], [0, dd / 2 - tt / 2, ww, tt], [-ww / 2 + tt / 2, 0, tt, dd - 2 * tt], [ww / 2 - tt / 2, 0, tt, dd - 2 * tt],
  ]
  return (
    <group position={[0, y, 0]}>
      {band(w + 2 * t, d + 2 * t, t).map(([x, z, sx, sz], i) => (
        <mesh key={i} position={[x, 0, z]}>
          <boxGeometry args={[sx, 0.004, sz]} />
          <meshBasicMaterial color="#e5407a" depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
      {band(w + 2 * t + 2 * halo, d + 2 * t + 2 * halo, halo).map(([x, z, sx, sz], i) => (
        <mesh key={`h${i}`} position={[x, -0.001, z]}>
          <boxGeometry args={[sx, 0.004, sz]} />
          <meshBasicMaterial color="#e5407a" transparent opacity={0.22} depthWrite={false} toneMapped={false} />
        </mesh>
      ))}
    </group>
  )
}
