# House view roadmap

Put every room of a home together into one model: see the whole house as a map and in 3D, jump
straight into any room by clicking it, and move furniture from one room to another right there.

## Principles

- **Rooms stay the source of truth.** Each room keeps its own file, furniture and saved layouts,
  exactly as today. A house only says *where* each room sits; it never copies a room. Editing a
  room in the planner shows up in the house, and the other way round.
- **Same folder.** Houses live next to the rooms, in `~/Documents/Room Planner/Houses/`, read and
  written by the Mac app and the dev server the same way rooms are. Room listings never see them.
- **Nothing gets lost.** Houses are included in the automatic backups. Deleting a house never
  deletes a room. A room missing from the folder shows as a gap in the house, never an error.
- **Small sprints.** Each step is tested, documented, committed and pushed on its own.

## Data model

```ts
interface HouseDoc {
  id: string            // "house-…"
  name: string          // "Home"
  createdAt: string
  updatedAt: string
  version: 1
  /** where each room sits: its (0, 0) corner in house centimetres, turned by `rot` about it */
  rooms: { roomId: string; x: number; y: number; rot: 0 | 90 | 180 | 270 }[]
}
```

A room point `(px, py)` lands in the house at its placement turned by `rot` (clockwise on the
plan) and moved by `(x, y)`. Two rooms that share a wall stand a wall's thickness apart
(`WALL_GAP`, 12 cm by default, the thickness the 3D view already draws).

## Pieces

| Piece | What it is |
|---|---|
| House documents | `HouseDoc`, loading old/partial files safely (`migrateHouse`), transforms room ↔ house |
| House storage | `Houses/<name>--<id>.json` via the Tauri fs plugin, a `/__rooms/_houses` API on the dev server, local storage in a hosted browser build |
| Backups | the automatic backups copy `Houses/` too |
| Seed house | "Home", with Forest's Room and Bedroom 2 side by side, added once like the seed rooms |
| House map | a 2D plan of every room at its place: walls, doors, windows, closets, furniture; pan and zoom |
| Jump in | click a room on the map to open it in the planner; "House" in the planner's top bar goes back |
| Arrange | drag rooms, turn them 90°, snap walls together (a wall's thickness apart) and line doors up |
| Furniture across rooms | drag a piece from one room into another on the map: it moves between the room files |
| 3D house | all rooms in one 3D scene; walls toward the camera hide; click a room to jump in |
| Connections | a door that meets another room's door joins them; walk mode goes from room to room |
| Floors | houses with several levels, each its own map, stacked in 3D |
| Library | a "Your house" entry on the start screen, with a thumbnail of the map |

## Sprints

### Sprint 1: the house on a map (done when you can open "Home" and click into a room)
- `HouseDoc` type, `migrateHouse`, room ↔ house transforms, tests.
- House storage in all three backends, tests; backups include `Houses/`.
- Seed house "Home" with Forest's Room and Bedroom 2 side by side, added once.
- House map screen: rooms drawn at their places with their furniture, pan and zoom, room names.
- Click a room to open it; a "House" button in the planner goes back to the map.
- Start screen: "Your house" entry.

### Sprint 2: arrange the house
- Drag a room on the map; turn it 90° with a button or the R key.
- Snapping: a wall dropped near another room's wall snaps a wall's thickness away, parallel;
  outside walls line up when close. (Lining doors up moved to sprint 5, with connected doors.)
- Add a room to the house from the library; take one out (the room itself stays).
- Saved on every change, like rooms.

### Sprint 3: move furniture between rooms on the map
- Drag a piece from one room and drop it into another: it moves from one room file to the other,
  at the spot it was dropped (turned with the room), and both rooms save.
- A piece dropped outside every room snaps back.
- Selection, rotate and lock work on the map as in the planner.

### Sprint 4: the house in 3D
- All rooms in one 3D scene at their places, sharing one sun and sky.
- Outside view orbits the whole house; the walls between the camera and a room hide.
- Click a room in 3D to jump into it.
- Rooms not in view drop to the fast quality level so the whole house stays smooth.

### Sprint 5: connections and walking through
- Doors that meet across a shared wall join the two rooms (shown on the map); a door dragged
  near another room's door lines up with it.
- Walk mode walks through a joined door into the next room.
- Hallways and open areas as rooms with no furniture.

### Sprint 6: polish
- Several floors (levels): a floor switcher on the map, stacked in 3D.
- Print or save the whole house as a PDF.
- Export and import a house with all its rooms.

## Status

- [x] Sprint 1: the house on a map. "Your house" on the start screen opens the map of "Home" (Forest's Room and Bedroom 2 side by side); scroll to zoom, drag to move, click a room to open it, "‹ Home" goes back. Houses are saved in `Houses/` and backed up.
- [x] Sprint 2: arranging. "Arrange rooms" on the map: drag rooms (walls snap a wall's thickness apart, outside walls line up; ⌥ places freely), select one to turn it (R) or take it out, add rooms from the library; overlapping rooms show in red. Saved on every change.
- [x] Sprint 3: furniture across rooms. On the map, drag a piece into another room (or around its own); it keeps its look on the plan, is written into the new room before it leaves the old one, and snaps back when dropped outside every room. Click a piece to pick it: R turns it, the toolbar shows what it gets wrong where it stands, and opens its room. Locked pieces stay put.
- [ ] Sprint 4
- [ ] Sprint 5
- [ ] Sprint 6
