# 3D Office Editor — Arrange your office in 3D 🎨

![The 3D Office Editor window](../img/editor.png)

Press the 🎨 button (in the ⋯ menu) or run `bagidea editor` → this opens a
**separate 3D Editor window** for arranging your office with complete freedom in a
true 3D view — **swap rooms in a 3×3 grid, move the Ghost Deck, place
furniture/decorations, and import your own models/images**.

## Controls

| Action | How |
|---|---|
| Rotate camera | Drag with the right or middle mouse button |
| Pan camera | Shift + drag |
| Zoom | Mouse wheel |
| Place an item | Pick a type from the left palette → click on the floor |
| Move an item | Click and hold an item, then drag it on the floor |
| Select an item | Click an item → the right panel appears (rotate/scale/delete) |
| **Swap rooms** | In the top-left "Room Layout" panel — **click 2 rooms to swap them** (3×3 jigsaw grid) |
| **Move the Ghost Deck** | The ◀ ▶ ▲ ▼ arrow buttons in the "Ghost Room" panel |

## Swapping rooms (3×3 jigsaw)

Every room is a cell of the same size → **any room can go into any slot**. Click the
first room, then click the second → the two rooms swap places as whole units
(furniture, agent seating spots, and the A* walking paths all move with them). The
cat/ball/dog follow their lounge/café room on their own. Press 💾 Save so the
wallpaper remembers this layout.

## What you can place

- Standard furniture/decorations: desk · round table · chair · shelf · plant ·
  lamp (emits real light) · rug
- **📦 Import .glb** — your own 3D models (.glb/.gltf/.fbx); if there's animation,
  it plays automatically (tick "Play model animation")
- **🖼 Import image** — an image pinned up as a poster

## Saving

Press **💾 Save** → the layout is sent to the daemon (`/layout`) and the
**wallpaper updates instantly** — the items you arranged appear in the real world
with the atmosphere/lighting/effects/characters all still intact.

## Principles

- **Standard items** (desks, etc.) use the system's models — you can adjust
  position/rotation/scale/color, but the shapes are the program's standard ones.
- **Rooms** can swap places (3×3 grid) and the **Ghost Deck** can move — everything
  related (furniture, seating spots, the walking graph, ghosts on the deck) updates
  automatically without breaking.
- Furniture is decorative — agents still walk using the same A* graph; arranging the
  layout doesn't break their movement.
- Imported models are kept in `workspace/uploads/` and can be reused.

## Behind the scenes (developers)

- The editor window = the same scene (`office_floor`) opened with the `--editor3d`
  flag → `map_editor.gd` handles the orbit camera + place/select/drag + UI + save.
- It uses the same `layout.json` schema as the wallpaper — on the wallpaper side,
  `layout_loader.gd` loads and spawns it on top of the procedural world (the
  `CustomLayout` layer).
- It can be opened from: the 🎨 button in the app · `bagidea editor` · `POST /editor/open`
