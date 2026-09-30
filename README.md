# Room Planner

Will the new bed fit? Room Planner is a small app for trying furniture layouts in a real room before you buy or move anything. Drag furniture around a 2D floor plan, see it in 3D, walk through the room at adult or child eye height, and get a plain-English list of what is in the way. Rooms are saved so you can come back to them when it is time to renovate.

It runs in the browser and as a native Mac app. This repository is the Mac and web edition; the Windows version lives in its own repository.

**The house view.** Your rooms fit together into one house. "Your house" on the start screen opens a map of the whole home, every room at its place with its furniture: scroll to zoom, drag to move around, click a room to open it, and the back button returns to the map. "Arrange rooms" lets you drag rooms into place (their walls snap together a wall's thickness apart), turn them, and add or take out rooms. Drag a piece of furniture from one room into another right on the map (it moves between the room files), or click one to turn it and see what it gets wrong where it stands. "3D" shows the whole house as a mass model (walls cut away so you look in, furniture as blocks); click a room to jump into it. Doors of neighbouring rooms that meet across a shared wall are connected (the map shows the passage, and a dragged room lines its door up with its neighbour's), and walk mode walks you through a connected door into the next room. "+ Add a hallway" adds an empty room for a hallway or open area. "Export" on the map saves the house and all its rooms (layouts too) as one `.house.json` file; "Import room or house file" on the start screen brings it back, as copies when those rooms are already there, so nothing is ever overwritten. "Save as PDF" puts the whole house on one page (every room with its walls, doors, windows, closets and labelled furniture) at the finest scale that fits. Houses are saved in `~/Documents/Room Planner/Houses/` next to the rooms and backed up with them; a house only places rooms, so your rooms and layouts stay exactly as they are. Houses can have several floors: the map shows one at a time (move a room to another floor while arranging), 3D stacks them, and the PDF has a page per floor. The plan and how it was built: [docs/HOUSE_ROADMAP.md](docs/HOUSE_ROADMAP.md).

## What it does

- **Start screen.** The app opens with "Start a new room" and "Open an existing room". A new room starts with the basics (door, window, bed, dresser, rug, desk), empty, or as a copy of the example room. Three rooms are seeded on first launch: the example bedroom, a nursery measured in inches, and an 11 × 11 ft second bedroom with its door on an angled corner wall.
- **Any room shape (3 to 20 walls).** Room → Edit walls opens a wall editor. Draw the shape by clicking corners on a grid (one square is a foot, or 25 cm), then type the real length of each wall and set each corner: 90°, a 45° angled wall (135°), an inside corner (270° or 225°), or any angle in 5° steps. One wall, the last by default, is worked out so the walls always meet, and a preview shows the shape as you type. Doors, windows and closets go on any wall; the plan, 3D view, print sheet, checks, walk mode and layout suggestions all follow the outline, and furniture where there is no floor counts as going through a wall. Rooms saved with the earlier angled corners open as drawn rooms.
- **Rooms library.** Your saved rooms live below the start screen. Create a room with a name and a group (for example "Home" or "2027 renovation"), reopen it later, duplicate it, rename it, export it as JSON, or import one. Every change is saved right away (a drag the moment you let go), so quitting never loses an edit. The first launch seeds an example room.
- **Floor plan.** Drag items, turn them to any angle with the rotate handle (snaps to 15° and to the straight positions, hold Shift for free), press `R` for a quarter turn, type an exact angle in the selection panel, or drag them into the "out of the room" strip to remove them. The selected item shows its distance to the nearest walls.
- **Locks.** Lock a piece in place (selection panel, the padlock on the plan, or `L`) and it can't be dragged or turned. Suggested layouts arrange everything else around it.
- **3D view.** Orbit from outside with the near walls cut away, or walk through the room with the mouse and `WASD`. Day and evening lighting. Click and drag furniture directly in 3D.
- **Furniture catalogue.** About 60 real-size presets: beds from crib to king, dressers and chests, nightstands, wardrobes, desks and chairs, sofas, tables, bookcases and shelves, rugs, kids' pieces, and indoor plants (a baby olive tree, a fiddle-leaf fig, a room bush). New items are placed automatically against a free wall, clear of the door swing. Anything can be renamed, recoloured, resized, or deleted, and "Custom size" adds something that is not in the list.
- **Windows, doors, radiators.** A room can have any number of each, on any wall, with its own size. Doors have a hinge side and swing in or out of the room.
- **Checks.** Overlaps, furniture through walls, whether a dresser fits under a window (and by how much), radiator coverage, how far each door can open, closet door clearance, passage widths beside the bed, whether you can still get out of bed, whether drawers, doors, desks, and sofas have the space in front of them they need, and anything taller than the ceiling.
- **Suggested layouts.** The pink "Suggested layouts" group in the top bar shows the example room's hand-made A, B, C presets (a tight real room, so they carry a few honest warnings), or for your own rooms a "Suggest layouts" button that works out up to three arrangements from your furniture. Generated suggestions respect access space (drawers, doors, desk chairs, legroom, a free side of the bed), keep unrelated pieces at least 45 cm apart, stay out of door swings and closet clearance, keep a walkable path from the door to the bed, and leave locked pieces exactly where they are. They use exactly the furniture in the room: every piece in the room is in every suggestion (one with no clean spot goes where it is in the way least, and the suggestion says so), and pieces taken out of the room are left out. The recommended one scored best on the checks. Add, remove, or resize furniture and a Refresh button offers new ones. Your own saved layouts sit underneath, and a one-time hint points new users at the group.
- **Focus.** Drag the divider between the floor plan and the 3D view to any split, double-click to reset, or use the "Focus 2D / 3D" toggle (or the F key) to give the plan most of the screen while you arrange things. The right panel collapses (`\`) to a slim tab on the edge, and every card in it folds. All of it is remembered.
- **Your name.** The first launch asks for a name and the home page becomes, say, "Richard's Room Planner". Click the title to change it.
- **Layouts.** Undo and redo, saved layouts per room, and (in the browser version) a Share button that puts the whole room in a link. The Mac app hides it, since its links only open in the browser version; use Export room file there.
- **Units.** A cm | in toggle in the top bar and on the start screen. Lengths are stored in centimetres and shown in the unit you pick: feet and inches for long distances (11′ 9″), inches to the nearest half for sizes (53½ in). Every size field accepts what you type, in either unit: 150, 150 in, 150", 12' 6", 12 ft 6 in, 6 1/2", 150 cm, 1.5 m. The value converts when you tab or click away.
- **Closets.** A closet is a recess in a wall with an opening, with its own inside depth and, for a walk-in, an inside width wider than the opening. It can have no doors, hinged doors, bi-fold doors, or sliding doors, and each needs a different amount of free floor in front, which the checks enforce. Its floor is floor too: drag furniture into it. Without doors a piece may stick out into the room (half a desk slid in); with doors it has to fit inside, or the checks say the doors can't close; the wall beside a walk-in's opening stays solid. Closets show on the plan, in 3D (the rail and clothes make way for furniture) and on the print sheet.
- **Print / PDF.** Two products: a measured floor plan (every item with its name, size, and distance to the nearest walls, the openings, a legend, a scale note, and a check bar to confirm the printout is at actual size), and a cut-out kit (every item at scale on one page to cut out, then the empty room at exactly the same scale on the last page). Letter or A4, Save PDF or Print, ⌘P.
- **Copy to another room.** Select a piece and copy or move it into any other saved room. It lands against a free wall there, or parked beside the plan if it does not fit, with a one-click "Open" to go and look.
- **Display settings.** Door opening angle, blind height, render quality, and while walking, eye height and mouse look sensitivity.

## Run it in the browser

```bash
npm install
npm run dev
```

Then open the printed local URL. The dev server (and `npm run preview`) saves rooms to `~/Documents/Room Planner/`, the same folder the Mac app uses, so every copy of the app on this Mac shares one set of rooms: a new clone, another port, another browser, or the Mac app. Rooms an older version kept in browser storage are copied into the folder the first time. Set `ROOM_PLANNER_DIR` to use a different folder. `npm run build` produces a static site in `dist/`; hosted on its own, without the dev server, it keeps rooms in the browser's local storage.

## Run it as a Mac app

The Mac app is built with [Tauri v2](https://v2.tauri.app). You need Rust (via rustup) and the Xcode command line tools.

```bash
npm run app:dev     # native window with hot reload
npm run app:build   # release build
```

The build produces `src-tauri/target/release/bundle/macos/Room Planner.app` and a disk image at `src-tauri/target/release/bundle/dmg/Room Planner_<version>_aarch64.dmg` (Apple Silicon; add `-- --target x86_64-apple-darwin` for Intel Macs). If the dmg step fails on your machine, which can happen because it drives Finder to lay out the image window, `npx tauri build --bundles app` builds just the app.

In the Mac app every room is a JSON file in `~/Documents/Room Planner/`, named `<room-name>--<id>.json`, with its saved layouts inside. The folder lives outside the app, so rebuilding, reinstalling, or deleting the app never touches your rooms. You can back up, sync, or share that folder. `seeded-rooms.txt` in the same folder records which built-in rooms have been added, so one you delete stays deleted. Export and Import use the normal macOS save and open dialogs. macOS asks once for permission to use your Documents folder.

**Your rooms are safe across updates.** Rooms and their saved layouts live only in that folder, never inside the app. Each time the app starts, if any room changed since the last backup, every room file is copied into `~/Documents/Room Planner/Backups/<date time>/` (the newest 30 are kept); to restore one, copy its file back into the folder. Closing the window or quitting the app (⌘Q, or a rebuild) first saves whatever edit was still waiting to be written; the browser version sends its last save as the page closes.

The app is not code-signed or notarized. The first time you open it, right-click (or Control-click) `Room Planner.app` and choose Open, then confirm. After that it opens normally.

To regenerate the app icon from a 1024×1024 PNG: `npx tauri icon src-tauri/app-icon.png`.

## 3D quality

"Best" adds ambient occlusion, anti-aliasing, a subtle vignette, contact shadows, plaster and fabric bump maps, and in the evening a glow on the lamp. "Fast" renders the same geometry without post-processing at a lower pixel ratio. The canvas only redraws when something changes, which keeps laptops cool.

Daytime is a sun outside the window with crisp shadows and a procedural environment map. Evening is a warm pendant, moonlight through the window, and a glowing shade. The outside world (sky, lawn, hedge, trees, a neighbour's house) is only ever visible through the glass. The floor is procedural oak tinted by the room's floor colour.

Every furniture kind is modelled from primitives: beds with bedding, pillows, and a throw (cribs, toddler and bunk beds too), dressers and wardrobes with drawers, doors, and handles, desks with a lamp and laptop, swivel and dining chairs, sofas, bookcases and cube shelves filled with books, woven rugs, and named extras such as an upright piano, floor lamp, toy chest, bean bag, and treadmill. The item colour drives the bedding, upholstery, or painted surface. A few names matter: "6-drawer" in a dresser name sets the drawer count, and "piano", "lamp", "chest", "bean bag", or "treadmill" pick a silhouette for plain boxes.

## Windows, doors, and radiators

Open the Room card in the sidebar and use "+ Add window", "+ Add door", or "+ Add radiator". Each row has a wall selector, a distance from the corner, a width and height, and for windows a sill height. "From corner" is measured from the left end of the back or front wall, or from the back end of a side wall. Remove a row with its ×.

Doors have a hinge side (Near corner puts the hinge at the smaller offset, Far corner at the larger one) and a swing. A door that opens into the room is checked for furniture in its swing. A door that opens out is instead checked for anything standing in the 40 cm strip in front of the doorway. On the plan an out-swinging door draws its arc outside the room, and in 3D the leaf swings into the hallway. The "Room door" slider in Display settings opens every door.

Window checks estimate fit. An item standing against the wall under a window is reported as "fits under the window with N cm to spare" when it is lower than the sill, "stands N cm above the window sill" when it is taller, or "blocks the window" when it rises through most of the glass. With several openings the checks and labels say "window 2", "door 2".

## Adding furniture

The "Add furniture" card holds the catalogue. Type in the search box or pick a category chip, then click a row to add it. Sizes are outer dimensions in centimetres (width × depth × height). A preset's note shows as a tooltip and in the selection panel.

New items go against a free wall when possible, corners first, turned so their back faces the wall. Otherwise they go on a 10 cm grid over the floor, or in the middle of the room. Placement keeps clear of other furniture and the door swing and tries to keep tall pieces away from windows. Rugs go in the middle. Drag the item afterwards if you want it somewhere else.

To remove something, select it and press Delete, or use the Delete button in the selection card.

## Change the defaults

The UI can edit everything, but the example room and its furniture live in `src/data.ts`, and the catalogue in `src/catalog.ts`.

## Stack

Vite, React 19, TypeScript, Three.js via react-three-fiber and drei, zustand for state, Tauri v2 for the Mac shell, vitest for tests, Playwright for screenshot checks. No backend.

## Layout of the code

| Path | What it holds |
| --- | --- |
| `src/types.ts` | Room, opening, item, layout, check, catalogue, and document types |
| `src/data.ts` | The example room, its furniture, preset layouts, `makeEmptyRoom` |
| `src/catalog.ts` | The furniture catalogue |
| `src/placement.ts` | `findFreeSpot`: where a new item goes |
| `src/suggest.ts` | The layout suggestion engine |
| `src/units.ts` | Unit setting, inch and feet formatting, typed-length parser |
| `src/seeds.ts` | Rooms seeded into the library on first launch |
| `src/print/` | The PDF sheets: measured plan and cut-out kit |
| `src/geometry.ts` | Footprints, overlaps, gaps, door swing and doorway maths |
| `src/checks.ts` | The rules that produce the checks list |
| `src/migrate.ts` | Loads rooms saved by older versions |
| `src/store.ts` | Planner state: items, undo/redo, layouts, view, settings, share link |
| `src/library.ts` | Rooms library: documents, groups, autosave, import/export |
| `src/house.ts` | Houses: where each room sits, room ↔ house coordinates |
| `src/houses.ts` | The houses in the library, the seed house "Home", the house on screen |
| `src/components/HouseMap.tsx` | The house map: every room at its place; click to open one |
| `src/scene/HouseScene3D.tsx` | The whole house in 3D as a mass model |
| `src/walkThrough.ts` | Walking from room to room through connected doors |
| `src/outline.ts` | Drawn room shapes: walls from lengths and angles and back, tidying, moving openings onto new walls |
| `src/components/WallEditor.tsx` | The Edit walls dialog: draw on a grid, then lengths and angles |
| `src/storage/` | Storage backends: Tauri files, the dev server's rooms folder, browser local storage; backups (`backup.ts`) and save-before-quit (`quit.ts`) |
| `scripts/room-folder.ts` | Vite plugin: the `/__rooms` API that reads and writes the rooms folder for the browser build |
| `src/components/Library.tsx` | The home screen |
| `src/components/FloorPlan.tsx` | SVG floor plan with drag and dimension lines |
| `src/scene/` | The 3D scene: renderer, lights, effects, cameras, walls and openings, outside, floor |
| `src/scene/furniture/` | Every furniture kind built from primitives, plus materials and props |
| `src/components/SplitPane.tsx` | The draggable 2D/3D divider and focus toggle |
| `src/components/PrintDialog.tsx` | Print and PDF export dialog |
| `src/components/CopyToRoom.tsx` | Copy or move a piece into another saved room |
| `src/components/ClosetRows.tsx` | Closet rows in the room editor |
| `src/components/Sidebar.tsx` | Layout notes, checks, selection, catalogue, room editor, settings |
| `src/components/TopBar.tsx` | Back to rooms, room name, layout tabs, save state, undo/redo, share |
| `src-tauri/` | The Mac app shell, capabilities, and icons |
| `scripts/shots.mjs` | Drives the app in headless Chromium and saves screenshots |

## Development

```bash
npm run typecheck   # tsc
npm test            # vitest
node scripts/shots.mjs http://localhost:5173 shots   # screenshots of the running app
```

Units are centimetres in the data and metres in the 3D scene. Sizes for the example room came from photos and a catalogue, so treat them as roughly ±2 cm.
