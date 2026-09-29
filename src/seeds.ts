import { DOC_VERSION } from './migrate'
import type { Item, Room, RoomDoc } from './types'

/** inches → whole centimetres */
export const inch = (v: number) => Math.round(v * 2.54)

/** Bump when the seed changes so unedited copies in existing libraries are refreshed. */
const SEED_TIME = '2026-09-25T00:00:00.000Z'

/**
 * Forest's Room — a nursery measured in inches with a tape:
 * room 141 × 116, ceiling 96; window 60 wide, 36 tall, sill 44; door 32 wide;
 * a bi-fold closet on the right wall, 58 from the back wall, 24 deep, running to the front corner.
 * Everything is stored in cm (the app's unit) and shown in inches when that unit is selected.
 */
export function forestsRoom(): RoomDoc {
  const W = inch(141) // 358
  const D = inch(116) // 295
  const winW = inch(60)
  const doorW = inch(32)
  const room: Room = {
    name: "Forest's Room",
    subtitle: 'Nursery · 11′9″ × 9′8″',
    w: W,
    d: D,
    h: inch(96),
    windows: [{ id: 'w1', wall: 'top', offset: Math.round((W - winW) / 2), width: winW, height: inch(36), sill: inch(44) }],
    // door in the front-left corner; hinge on the corner side so it swings left as you walk in
    doors: [{ id: 'd1', wall: 'bottom', offset: 10, width: doorW, height: inch(80), sill: 0, hinge: 'left', swing: 'in' }],
    radiators: [],
    // the closet was measured 60 wide, but 58 + 60 overshoots the 116 in wall: it runs to the front corner
    closets: [{ id: 'c1', wall: 'right', offset: inch(58), width: Math.min(inch(60), D - inch(58)), depth: inch(24), doors: 'bifold' }],
    wallColors: { left: '#d8e2d3', right: '#d8e2d3', top: '#f3efe8', bottom: '#f3efe8' },
    floorColor: '#b08968',
  }

  const piece = (
    id: string,
    name: string,
    kind: Item['kind'],
    wIn: number,
    dIn: number,
    hIn: number,
    x: number,
    y: number,
    rot: Item['rot'],
    color: string,
    extra: Partial<Item> = {},
  ): Item => ({
    id,
    name,
    kind,
    w: inch(wIn),
    d: inch(dIn),
    h: inch(hIn),
    x,
    y,
    rot,
    color,
    inRoom: true,
    note: `${wIn} × ${dIn} × ${hIn} in`,
    ...extra,
  })

  // Positions are footprint centres in cm; x from the left wall, y from the back (window) wall.
  const items: Item[] = [
    // dresser under the window: 30 in tall against a 44 in sill
    piece('forest-dresser', 'Dresser', 'dresser', 58, 16, 30, W / 2, inch(16) / 2, 0, '#f7f4ef'),
    // changing table on the back wall, left of the dresser
    piece('forest-changing', 'Changing table', 'dresser', 30, 30, 40, 15 + inch(30) / 2, inch(30) / 2, 0, '#f7f4ef'),
    // crib along the right wall, up by the window wall
    piece('forest-crib', 'Crib', 'bed', 54, 30, 35, W - inch(30) / 2, inch(54) / 2, 90, '#e9dccd'),
    // tall cabinet on the left wall, between the changing table and the door swing
    piece('forest-cabinet', 'Tall cabinet', 'wardrobe', 46, 18, 79, inch(18) / 2, 148, 270, '#efe9df'),
    // recliner on the front wall to the right of the door swing, side table and hamper beside it
    piece('forest-recliner', 'Recliner', 'sofa', 41, 39, 40, 100 + inch(41) / 2, D - inch(39) / 2, 180, '#9aa88f', {
      note: '41 × 39 × 40 in. Reclines to 64 in deep (38 in closed).',
    }),
    piece('forest-side', 'Side table', 'nightstand', 22, 18, 25, 100 + inch(41) + 10 + inch(22) / 2, D - inch(18) / 2, 180, '#c9a27e'),
    // hamper squeezed between the side table and the closet doors' clearance
    piece('forest-hamper', 'Hamper', 'box', 13, 22, 24, 100 + inch(41) + 10 + inch(22) + 2 + inch(13) / 2, D - inch(22) / 2, 180, '#e5e0d8'),
    // the same recliner fully reclined, kept out of the room to test clearance
    piece('forest-recliner-open', 'Recliner, reclined', 'sofa', 41, 64, 40, 60, D + 90, 0, '#9aa88f', {
      inRoom: false,
      note: '41 × 64 × 40 in — the recliner fully open. Drag it in to check the clearance.',
    }),
  ]

  return {
    id: 'room-forest',
    name: "Forest's Room",
    group: 'Home',
    notes: 'Nursery. Sizes measured in inches; the window is centred on the back wall, the door is in the front-left corner and swings left as you walk in, and the bi-fold closet is on the right wall by the front corner (set its doors to "No doors" to test the room without them). Move anything that does not match the real room.',
    createdAt: SEED_TIME,
    updatedAt: SEED_TIME,
    room,
    items,
    layouts: [],
    settings: { daytime: true, doorAngle: 70, blinds: 30, bedding: true, walkHeight: 'adult', quality: 'best' },
    version: DOC_VERSION,
  }
}

/**
 * Bedroom 2 — 11 × 11 ft with an 8 ft ceiling, sizes in inches:
 * window 66 wide, 24 tall, sill 58; two doors, both 32 wide; a closet.
 * Bed 67 × 85 × 24, desk 81 × 34 × 27, dresser 14½ × 19 × 46, side table 16 × 23 × 24.
 * A drawn room with five walls: the square with its front-right corner cut off by a 45° wall
 * (28 in along each side, about 40 in across), where door 1 is. Door 2 is at the right end of the
 * back wall and the closet (60 wide, 24 deep, sliding) at the back end of the right wall, where
 * the room's owner put them. Walls go round clockwise from the back wall: 1 back, 2 right,
 * 3 the angled wall, 4 front (measured from its right end), 5 left.
 * The bed, side table and dresser stand where the layout suggestions put them. The 81 in desk
 * blocks a door or a clearance wherever it goes in this room, so it starts parked beside the plan.
 */
const BEDROOM_2_SEED_TIME = '2026-09-29T23:00:00.000Z'

export function bedroomTwo(): RoomDoc {
  const S = inch(132) // 335
  const winW = inch(66)
  const doorW = inch(32)
  const cut = inch(28) // 71: the angled wall is about 40 in across
  const angled = Math.hypot(cut, cut)
  const room: Room = {
    name: 'Bedroom 2',
    subtitle: 'Bedroom',
    w: S,
    d: S,
    h: inch(96),
    outline: [[0, 0], [S, 0], [S, S - cut], [S - cut, S], [0, S]],
    windows: [{ id: 'w1', wall: 'e0', offset: Math.round((S - winW) / 2), width: winW, height: inch(24), sill: inch(58) }],
    doors: [
      // centred on the angled wall, hinged at its end on the right wall
      { id: 'd1', wall: 'e2', offset: Math.round((angled - doorW) / 2), width: doorW, height: inch(80), sill: 0, hinge: 'left', swing: 'in' },
      { id: 'd2', wall: 'e0', offset: S - doorW - 2, width: doorW, height: inch(80), sill: 0, hinge: 'right', swing: 'in' },
    ],
    radiators: [],
    closets: [{ id: 'c1', wall: 'e1', offset: 5, width: inch(60), depth: inch(24), doors: 'sliding' }],
    wallColors: { left: '#e4e1da', right: '#e4e1da', top: '#f2efe9', bottom: '#f2efe9' },
    floorColor: '#a47e5c',
  }

  const piece = (id: string, name: string, kind: Item['kind'], wIn: number, dIn: number, hIn: number, x: number, y: number, rot: Item['rot'], color: string, extra: Partial<Item> = {}): Item => ({
    id, name, kind, w: inch(wIn), d: inch(dIn), h: inch(hIn), x, y, rot, color, inRoom: true, note: `${wIn} × ${dIn} × ${hIn} in`, ...extra,
  })

  // Positions are footprint centres in cm; x from the left wall, y from the back (window) wall.
  const items: Item[] = [
    // bed under the left half of the window, head against the back wall (24 in bed, 58 in sill)
    piece('b2-bed', 'Bed', 'bed', 67, 85, 24, 85, 108, 0, '#d9d2c5'),
    piece('b2-side', 'Side table', 'nightstand', 16, 23, 24, 191, 29, 0, '#b88b62'),
    // narrow tall dresser in the front-left corner against the left wall, drawers facing the room
    piece('b2-dresser', 'Dresser', 'dresser', 14.5, 19, 46, 24, 316, 270, '#efe9df'),
    // parked below the plan: see the doc comment
    piece('b2-desk', 'Desk', 'desk', 81, 34, 27, S / 2, S + 40 + inch(34) / 2, 0, '#8a6a4f', {
      inRoom: false,
      note: '81 × 34 × 27 in. Too long to stand anywhere in this room without blocking a door or the walkway; drag it in to see what it costs.',
    }),
  ]

  return {
    id: 'room-bedroom-2',
    name: 'Bedroom 2',
    group: 'Home',
    notes: 'Sizes in inches. Door 1 is on the angled wall across the front-right corner, door 2 at the right end of the back wall, the 60 in sliding closet on the right wall and the window centred on the back wall. The 81 in desk starts parked beside the plan because it blocks a door wherever it goes.',
    createdAt: BEDROOM_2_SEED_TIME,
    updatedAt: BEDROOM_2_SEED_TIME,
    room,
    items,
    layouts: [],
    settings: { daytime: true, doorAngle: 70, blinds: 30, bedding: true, walkHeight: 'adult', quality: 'best' },
    version: DOC_VERSION,
  }
}
