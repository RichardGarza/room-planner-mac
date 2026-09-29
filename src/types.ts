export type Wall = 'top' | 'bottom' | 'left' | 'right'
/** A corner of the room's rectangle. "back" is the top wall on the plan, "front" the bottom one. */
export type Corner = 'backLeft' | 'backRight' | 'frontLeft' | 'frontRight'
/**
 * Any wall of the room: the four sides of the rectangle, plus a wall across each corner that is
 * cut off (an angled wall). Windows and doors can sit on any of them.
 */
export type AnyWall = Wall | Corner
/**
 * A cut-off corner: a straight wall from `x` cm along the back or front wall to `y` cm along the
 * side wall. Equal legs make a 45° wall.
 */
export interface CornerCut {
  x: number
  y: number
}
/** Rotation on the plan in degrees, clockwise, normalised to [0, 360). 0 / 90 / 180 / 270 are the axis-aligned cases. */
export type Rot = number
export type ItemKind =
  | 'bed'
  | 'chair'
  | 'desk'
  | 'shelf'
  | 'dresser'
  | 'wardrobe'
  | 'bookcase'
  | 'rug'
  | 'rugRect'
  | 'nightstand'
  | 'sofa'
  | 'table'
  | 'plant'
  | 'box'

/** All lengths are centimetres. x runs left→right, y runs top→bottom on the plan. */
export interface Item {
  id: string
  name: string
  kind: ItemKind
  /** width across the item's own x axis (before rotation) */
  w: number
  /** depth across the item's own y axis (before rotation) */
  d: number
  h: number
  /** footprint centre */
  x: number
  y: number
  rot: Rot
  color: string
  inRoom: boolean
  /** free text shown in the selection panel */
  note?: string
  /** a locked piece stays put: no drag, no rotate, and layout suggestions arrange around it */
  locked?: boolean
}

export interface Opening {
  id: string
  /** a window or door may sit on an angled corner wall; offset then runs along that wall */
  wall: AnyWall
  /** distance along the wall from its left/top end to the opening's start */
  offset: number
  width: number
  height: number
  /** height of the bottom edge above the floor */
  sill: number
}

export interface Door extends Opening {
  /** 'left' = hinge at the smaller offset along the wall, 'right' = at the larger one */
  hinge: 'left' | 'right'
  /** which way the leaf opens: into the room (affects clearance) or out of it */
  swing: 'in' | 'out'
}

export interface Radiator {
  id: string
  wall: Wall
  offset: number
  width: number
  depth: number
  height: number
}

export type ClosetDoors = 'none' | 'hinged' | 'bifold' | 'sliding'

/** A recess in a wall behind an opening. Its front (the doors) sits on the wall line; the recess lies outside the room. */
export interface Closet {
  id: string
  wall: Wall
  /** distance along the wall from its left/top end to the opening's start */
  offset: number
  width: number
  /** how far the recess goes back beyond the wall line */
  depth: number
  doors: ClosetDoors
  /** height of the opening (default 203) */
  height?: number
}

export interface Room {
  name: string
  subtitle: string
  w: number
  d: number
  h: number
  windows: Opening[]
  doors: Door[]
  radiators: Radiator[]
  closets: Closet[]
  wallColors: { left: string; right: string; top: string; bottom: string }
  /** cut-off corners; each adds an angled wall, so a room has 4 to 8 walls */
  corners?: Partial<Record<Corner, CornerCut>>
  floorColor: string
}

export type ItemPlacement = Pick<Item, 'x' | 'y' | 'rot' | 'inRoom'>

export interface Layout {
  id: string
  name: string
  description: string
  recommended?: boolean
  placements: Record<string, ItemPlacement>
  /** saved layouts keep the full furniture list (added items, sizes, names) */
  items?: Item[]
}

export type CheckLevel = 'ok' | 'warn' | 'bad'
export interface Check {
  level: CheckLevel
  text: string
  itemIds: string[]
}

/** Axis-aligned footprint in room coordinates. */
export interface Rect {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** A preset in the furniture catalogue (see src/catalog.ts). Sizes in cm. */
export interface CatalogEntry {
  id: string
  name: string
  kind: ItemKind
  category: string
  w: number
  d: number
  h: number
  color: string
  note?: string
}

/** Everything needed to reopen a room later. Stored by src/storage. */
export interface RoomDoc {
  id: string
  /** e.g. "Mila's room" */
  name: string
  /** free grouping label, e.g. "Home", "Cabin", "2027 renovation" */
  group: string
  notes: string
  createdAt: string
  updatedAt: string
  room: Room
  items: Item[]
  layouts: Layout[]
  settings: {
    daytime: boolean
    doorAngle: number
    blinds: number
    bedding: boolean
    walkHeight: 'adult' | 'child'
    quality: 'best' | 'fast'
    /** walk-mode mouse look multiplier, 0.25..2 (1 = default) */
    lookSensitivity?: number
  }
  /** schema version for future migrations */
  version: number
}

/** Lightweight listing entry so the library screen does not load every document. */
export interface RoomSummary {
  id: string
  name: string
  group: string
  updatedAt: string
  createdAt: string
  w: number
  d: number
  itemCount: number
}
