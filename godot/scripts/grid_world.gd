extends Node3D
## Uniform room-grid office — the swappable "jigsaw" floor.
##
## The floor is GRID_COLS × GRID_ROWS identical cells. Every room is built into
## its own container Node3D sitting at a fixed SLOT centre; swapping two rooms
## just exchanges which slot each container sits in (and re-homes its agent
## anchors). Because every cell is the same size with door gaps on all four
## sides, ANY room fits in ANY slot — true jigsaw.
##
## Developed standalone (render-to-PNG) so the geometry can be perfected before
## being wired into the live world_builder API.

const CELL := 8.0          # cell pitch (room interior ~ CELL - wall)
const GRID_COLS := 3
const GRID_ROWS := 3
const WALL_H := 4.0
const WALL_T := 0.18
const DOOR_W := 2.2        # door-gap width on each interior side

# default room kind per slot (index = row*COLS + col)
var room_order: Array = [
	"exec",  "ops",   "server",
	"lobby", "cafe",  "meeting",
	"rec",   "dormx", "dorm",
]

# kind → {label, floor tint (LIGHT pastel — polished metal catches SSR), accent light}
const ROOM_DEFS := {
	"exec":    {"label": "EXECUTIVE", "tint": "ffe7c2", "accent": "ffb14a"},
	"ops":     {"label": "OPS FLOOR", "tint": "cfe2ff", "accent": "4ec3ff"},
	"server":  {"label": "SERVER",    "tint": "c8ffe0", "accent": "55ffaa"},
	"lobby":   {"label": "LOBBY",     "tint": "ffd8d0", "accent": "ff7a5a"},
	"cafe":    {"label": "CAFETERIA", "tint": "ffe2c0", "accent": "ffb874"},
	"meeting": {"label": "MEETING",   "tint": "e3d6ff", "accent": "b48cff"},
	"rec":     {"label": "RECREATION","tint": "d4ffd8", "accent": "7effc8"},
	"dormx":   {"label": "DORM XL",   "tint": "d2dcff", "accent": "8ab4ff"},
	"dorm":    {"label": "DORM",      "tint": "d6dcff", "accent": "9ab0ff"},
}

# agent anchors per room kind — LOCAL offset from cell centre (y = 0.86 floor).
# Names are exactly those agent_manager.gd already targets, so the brain is
# untouched: only WHERE each anchor sits is now grid-driven.
const ROOM_ANCHORS := {
	"exec":  {"exec_c": Vector2(0, 0), "ceo_desk": Vector2(0, -2.3), "lead_desk": Vector2(2.2, -2.3),
		"pace_a": Vector2(-1.5, -0.6), "pace_b": Vector2(1.5, -0.6)},
	"ops":   {"ops_c": Vector2(0, 0), "desk1": Vector2(-2.3, -2.0), "desk2": Vector2(0, -2.0),
		"desk3": Vector2(2.3, -2.0), "desk4": Vector2(-2.3, 1.4), "desk5": Vector2(0, 1.4),
		"desk6": Vector2(2.3, 1.4), "ap1": Vector2(-2.3, 0), "ap2": Vector2(2.3, 0)},
	"server": {"server_c": Vector2(0, 0)},
	"lobby": {"lobby_c": Vector2(0, 0), "spawn": Vector2(0, 3.0), "sec_c": Vector2(-2.4, -2.2),
		"sec_window": Vector2(-2.4, -1.0)},
	"cafe":  {"cafe_c": Vector2(0, 0), "cafe_s1": Vector2(0.6, -1.4), "cafe_s2": Vector2(1.6, 1.8)},
	"meeting": {"meeting_c": Vector2(0, 0), "m_s1": Vector2(-1.3, -1.3), "m_s2": Vector2(1.3, -1.3),
		"m_s3": Vector2(-1.3, 1.3), "m_s4": Vector2(1.3, 1.3)},
	"rec":   {"rec_c": Vector2(0, 0), "rec_s1": Vector2(-1.4, -0.5), "rec_s2": Vector2(0, 1.4),
		"rec_s3": Vector2(-1.4, 0.6), "rec_s4": Vector2(1.6, 1.4)},
	"dormx": {"dormx_c": Vector2(0, 0), "b3": Vector2(-2.7, -1.4), "b4": Vector2(-0.9, -1.4),
		"b5": Vector2(0.9, -1.4), "b6": Vector2(2.7, -1.4), "b7": Vector2(-1.8, 1.4), "b8": Vector2(1.8, 1.4)},
	"dorm":  {"dorm_c": Vector2(0, 0), "bed1": Vector2(-1.8, -1.5), "bed2": Vector2(1.8, -1.5)},
}
const FLOOR_Y := 0.86

var _cell_node: Array = []      # slot index → container Node3D
var _cell_center: Array = []    # slot index → Vector3 (fixed)

var WP := {}                    # anchor name → world Vector3 (live)
var _anchor_slot := {}          # anchor name → current slot
var _anchor_local := {}         # anchor name → Vector2 local offset
var astar := AStar3D.new()
var _wp_ids := {}
var _next_id := 0

func _ready() -> void:
	_build()
	_build_graph()

func slot_center(slot: int) -> Vector3:
	var c := slot % GRID_COLS
	var r := slot / GRID_COLS
	var x := (c - (GRID_COLS - 1) * 0.5) * CELL
	var z := (r - (GRID_ROWS - 1) * 0.5) * CELL
	return Vector3(x, 0, z)

func _build() -> void:
	# ground slab + outer perimeter wall around the whole grid
	var halfx := GRID_COLS * CELL * 0.5
	var halfz := GRID_ROWS * CELL * 0.5
	_box(Vector3(0, -0.1, 0), Vector3(GRID_COLS * CELL + 0.4, 0.2, GRID_ROWS * CELL + 0.4), _m("232838", 0.5))
	# perimeter is a U: back (north) + the two sides, with the FRONT (south, the
	# camera-facing side) left open — same silhouette as the original office.
	var lenx := GRID_COLS * CELL + WALL_T
	var lenz := GRID_ROWS * CELL
	_perim(Vector3(0, 0, -halfz), Vector3(lenx, 0, WALL_T))      # back wall
	_perim(Vector3(-halfx, 0, 0), Vector3(WALL_T, 0, lenz))      # west wall
	_perim(Vector3( halfx, 0, 0), Vector3(WALL_T, 0, lenz))      # east wall

func _perim(pos: Vector3, size: Vector3) -> void:
	var T := 0.34          # thick enough to read as a real wall from a distance
	var base := _m("69748f", 0.6)
	var glass := _m("b6d2f4", 0.05, "7fa0cf", 0.8); glass.albedo_color.a = 0.55
	glass.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	var cap := _m("dbe4f2", 0.3)
	var bh := 2.8          # SOLID wall (the bulk) — clearly visible
	var gh := WALL_H - bh  # window band above
	var sz := Vector3(max(size.x, T), 0, max(size.z, T))
	_box(Vector3(pos.x, bh * 0.5, pos.z), Vector3(sz.x, bh, sz.z), base)
	_box(Vector3(pos.x, bh + gh * 0.5, pos.z), Vector3(sz.x, gh, sz.z), glass)
	_box(Vector3(pos.x, WALL_H + 0.03, pos.z), Vector3(sz.x + 0.08, 0.1, sz.z + 0.08), cap)  # top coping

	for slot in range(GRID_COLS * GRID_ROWS):
		var center := slot_center(slot)
		_cell_center.append(center)
		var room := Node3D.new()
		room.position = center
		add_child(room)
		_cell_node.append(room)
		var kind := String(room_order[slot])
		_build_room(room, kind)
		_register_anchors(slot, kind)

## Record this slot's agent anchors (world + local + slot) from ROOM_ANCHORS.
func _register_anchors(slot: int, kind: String) -> void:
	var center: Vector3 = _cell_center[slot]
	for aname in ROOM_ANCHORS.get(kind, {}):
		var loc: Vector2 = ROOM_ANCHORS[kind][aname]
		_anchor_local[aname] = loc
		_anchor_slot[aname] = slot
		WP[aname] = center + Vector3(loc.x, FLOOR_Y, loc.y)

# ----------------------------------------------------------------- A* graph
## Skeleton: a hub per slot + a door node on each shared wall. Room anchors hang
## off their slot's hub. Swapping a room re-homes its anchors to the new hub.
func _build_graph() -> void:
	# hubs at slot centres
	for slot in range(GRID_COLS * GRID_ROWS):
		_add_point("hub_%d" % slot, _cell_center[slot] + Vector3(0, FLOOR_Y, 0))
	# door nodes between orthogonally adjacent slots, connecting the two hubs
	for slot in range(GRID_COLS * GRID_ROWS):
		var c := slot % GRID_COLS
		var r := slot / GRID_COLS
		if c + 1 < GRID_COLS:
			_link_slots(slot, slot + 1)
		if r + 1 < GRID_ROWS:
			_link_slots(slot, slot + GRID_COLS)
	# anchors → their slot hub
	for aname in WP:
		_add_point(aname, WP[aname])
		var hk := "hub_%d" % int(_anchor_slot.get(aname, -1))
		if _wp_ids.has(hk):
			astar.connect_points(_wp_ids[aname], _wp_ids[hk])
		else:
			push_warning("grid: anchor %s has no hub (%s)" % [aname, hk])

func _link_slots(a: int, b: int) -> void:
	var mid: Vector3 = (_cell_center[a] + _cell_center[b]) * 0.5 + Vector3(0, FLOOR_Y, 0)
	var dn := "door_%d_%d" % [a, b]
	_add_point(dn, mid)
	astar.connect_points(_wp_ids["hub_%d" % a], _wp_ids[dn])
	astar.connect_points(_wp_ids[dn], _wp_ids["hub_%d" % b])

func _add_point(name: String, pos: Vector3) -> void:
	_wp_ids[name] = _next_id
	astar.add_point(_next_id, pos)
	_next_id += 1

func _nearest(pos: Vector3) -> int:
	var best := -1; var best_d := INF
	for name in _wp_ids:
		var d: float = pos.distance_to(astar.get_point_position(_wp_ids[name]))
		if d < best_d: best_d = d; best = _wp_ids[name]
	return best

func path_to(from_pos: Vector3, target: String) -> Array:
	if not _wp_ids.has(target): return []
	var pts := astar.get_point_path(_nearest(from_pos), _wp_ids[target])
	var out: Array = []
	for p in pts: out.append(p)
	if out.size() > 1 and from_pos.distance_to(out[0]) < 0.4: out.pop_front()
	return out

func path_between(from_pos: Vector3, to_pos: Vector3) -> Array:
	var pts := astar.get_point_path(_nearest(from_pos), _nearest(to_pos))
	var out: Array = []
	for p in pts: out.append(p)
	if out.size() > 1 and from_pos.distance_to(out[0]) < 0.4: out.pop_front()
	out.append(to_pos)
	return out

## Re-home a room's anchors after its container moved to `slot`.
func _rehome_anchors(slot: int) -> void:
	var center: Vector3 = _cell_center[slot]
	for aname in _anchor_slot:
		if _anchor_slot[aname] == slot:
			var loc: Vector2 = _anchor_local[aname]
			WP[aname] = center + Vector3(loc.x, FLOOR_Y, loc.y)
			if _wp_ids.has(aname):
				astar.set_point_position(_wp_ids[aname], WP[aname])

## Swap two rooms between their slots — the whole container (walls, floor,
## furniture) glides to the other slot. Agent anchors ride along because they
## live under the container.
func swap_slots(a: int, b: int) -> void:
	if a == b or a < 0 or b < 0: return
	if a >= _cell_node.size() or b >= _cell_node.size(): return
	var na: Node3D = _cell_node[a]
	var nb: Node3D = _cell_node[b]
	na.position = _cell_center[b]
	nb.position = _cell_center[a]
	_cell_node[a] = nb; _cell_node[b] = na
	var tmp = room_order[a]; room_order[a] = room_order[b]; room_order[b] = tmp
	# move each room's anchors to the other slot (re-home position + re-wire the
	# graph edge from the old hub to the new one)
	var a_an: Array = []; var b_an: Array = []
	for an in _anchor_slot:
		if _anchor_slot[an] == a: a_an.append(an)
		elif _anchor_slot[an] == b: b_an.append(an)
	for an in a_an: _reslot_anchor(an, a, b)
	for an in b_an: _reslot_anchor(an, b, a)

func _reslot_anchor(aname: String, from_slot: int, to_slot: int) -> void:
	_anchor_slot[aname] = to_slot
	var center: Vector3 = _cell_center[to_slot]
	var loc: Vector2 = _anchor_local[aname]
	WP[aname] = center + Vector3(loc.x, FLOOR_Y, loc.y)
	var fh := "hub_%d" % from_slot
	var th := "hub_%d" % to_slot
	if _wp_ids.has(aname) and _wp_ids.has(fh) and _wp_ids.has(th):
		astar.set_point_position(_wp_ids[aname], WP[aname])
		if astar.are_points_connected(_wp_ids[aname], _wp_ids[fh]):
			astar.disconnect_points(_wp_ids[aname], _wp_ids[fh])
		astar.connect_points(_wp_ids[aname], _wp_ids[th])

## Build one room's contents at LOCAL origin (cell centre = 0,0,0).
## Matches the original art: polished tinted metal floor + LOW glass railings
## (not tall opaque walls — those felt cramped) + warm accent lighting.
func _build_room(room: Node3D, kind: String) -> void:
	var d: Dictionary = ROOM_DEFS.get(kind, ROOM_DEFS["ops"])
	var tint := Color(String(d["tint"]))
	var kit := _kit_avail()
	# ── floor: polished metal tiles, tinted per room (catch SSR reflections) ──
	if kit:
		_floor_tiles(room, tint)
	else:
		var fl := _box(Vector3(0, 0.02, 0), Vector3(CELL - WALL_T, 0.04, CELL - WALL_T), _m(String(d["tint"]), 0.18))
		room.add_child(fl)
	# ── low dividers: knee-to-waist glass railings, open and airy ────────────
	_dividers(room, tint)
	# ── lighting: ONE soft accent dome (sun + ambient already light the floor;
	#    extra lights wash the polished tiles out to white) ───────────────────
	var lamp := OmniLight3D.new(); lamp.position = Vector3(0, 2.6, 0)
	lamp.light_color = Color(String(d["accent"])); lamp.light_energy = 0.9; lamp.omni_range = CELL * 0.85
	room.add_child(lamp)
	_furnish(room, kind, String(d["accent"]))

## Polished tinted metal floor — 2×2 kit tiles stretched to the cell.
func _floor_tiles(room: Node3D, tint: Color) -> void:
	var span := CELL - WALL_T
	var n := 2
	for ix in n:
		for iz in n:
			var px := ((ix + 0.5) / float(n) - 0.5) * span
			var pz := ((iz + 0.5) / float(n) - 0.5) * span
			var tile := _kit_node(room, "Floor_Metal_Square", Vector3(px, 0, pz), 0.0,
				Vector3(span / n / 4.0, 1.0, span / n / 4.0))
			# mid-tone, not pastel — pastel blows out to white under the sun
			if tile: _tint_meshes(tile, tint * 0.62, 0.42)

## Four low glass railings (one per side), each split around a centre door gap.
func _dividers(room: Node3D, tint: Color) -> void:
	var half := CELL * 0.5
	var side := (CELL - DOOR_W) * 0.5
	var off := (DOOR_W + side) * 0.5
	var kit := _kit_avail()
	for s in [-1.0, 1.0]:
		var n: float = s * half
		if kit:
			var sx := Vector3(side / 3.92, 1.0, 1.0)
			_kit_node(room, "Railing_Flat", Vector3(-off, 0, n), 0.0, sx)
			_kit_node(room, "Railing_Flat", Vector3(off, 0, n), 0.0, sx)
			_kit_node(room, "Railing_Flat", Vector3(n, 0, -off), 90.0, sx)
			_kit_node(room, "Railing_Flat", Vector3(n, 0, off), 90.0, sx)
		else:
			var gm := _m("aac6e8", 0.08); gm.albedo_color.a = 0.5
			gm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
			room.add_child(_box(Vector3(-off, 0.55, n), Vector3(side, 1.1, 0.06), gm))
			room.add_child(_box(Vector3(off, 0.55, n), Vector3(side, 1.1, 0.06), gm))
			room.add_child(_box(Vector3(n, 0.55, -off), Vector3(0.06, 1.1, side), gm))
			room.add_child(_box(Vector3(n, 0.55, off), Vector3(0.06, 1.1, side), gm))

## Tint + polish a kit model's meshes (mirrors world_builder._tint_meshes).
func _tint_meshes(node: Node, tint: Color, rough := -1.0) -> void:
	if node is MeshInstance3D and (node as MeshInstance3D).mesh:
		var mi: MeshInstance3D = node
		for i in mi.mesh.get_surface_count():
			var src := mi.get_active_material(i)
			if src is BaseMaterial3D:
				var dup: BaseMaterial3D = src.duplicate()
				dup.albedo_color = tint
				if rough >= 0.0:
					dup.roughness = rough; dup.metallic = 0.12
				mi.set_surface_override_material(i, dup)
	for c in node.get_children():
		_tint_meshes(c, tint, rough)

# ----------------------------------------------------------- kit furniture
const SCIFI_DIR := "res://assets/scifi/"
var _kit_cache := {}

func _kit_avail() -> bool:
	return FileAccess.file_exists(ProjectSettings.globalize_path(SCIFI_DIR + "Chair_1.glb"))

func _kit(room: Node3D, model: String, lpos: Vector3, roty := 0.0, s := 1.0) -> void:
	_kit_node(room, model, lpos, roty, Vector3.ONE * s)

func _kit_node(room: Node3D, model: String, lpos: Vector3, roty: float, sv: Vector3) -> Node3D:
	if not _kit_cache.has(model):
		var doc := GLTFDocument.new(); var st := GLTFState.new()
		var path := ProjectSettings.globalize_path(SCIFI_DIR + model + ".glb")
		_kit_cache[model] = doc.generate_scene(st) if doc.append_from_file(path, st) == OK else null
	var proto = _kit_cache[model]
	if proto == null: return null
	var inst: Node3D = proto.duplicate()
	inst.position = lpos; inst.rotation_degrees = Vector3(0, roty, 0); inst.scale = sv
	room.add_child(inst)
	return inst

## Per-room hero furniture (kit when present, else simple blocks). All LOCAL to
## the cell centre so it rides the container when rooms swap.
func _furnish(room: Node3D, kind: String, accent: String) -> void:
	var kit := _kit_avail()
	match kind:
		"exec":
			if kit:
				_kit(room, "Command_Console", Vector3(0, 0, -2.5), 0.0, 0.5)
				_kit(room, "Large_Monitor_Blue", Vector3(-2.2, 0, -3.0), 0.0, 0.5)
				_kit(room, "Orrery", Vector3(2.7, 0, -2.4), 0.0, 0.35)
				_kit(room, "Chair_1", Vector3(0, 0, -1.4), 180.0, 0.6)
				_kit(room, "Plant_1", Vector3(3.0, 0, 2.8), 40.0, 1.4)
			else:
				room.add_child(_box(Vector3(0, 0.45, -2.4), Vector3(2.4, 0.9, 1.0), _m("2a2018", 0.5)))
		"ops":
			var spots := [Vector3(-2.3, 0, -2.0), Vector3(0, 0, -2.0), Vector3(2.3, 0, -2.0),
				Vector3(-2.3, 0, 1.4), Vector3(0, 0, 1.4), Vector3(2.3, 0, 1.4)]
			for sp in spots:
				room.add_child(_box(sp + Vector3(0, 0.4, 0), Vector3(1.4, 0.8, 0.7), _m("23303f", 0.5)))
				if kit:
					_kit(room, "Large_Monitor_Blue", sp + Vector3(0, 0.8, 0.05), 0.0, 0.24)
					_kit(room, "Chair_1", sp + Vector3(0, 0, -0.85), 180.0, 0.55)
		"server":
			if kit:
				_kit(room, "Generator", Vector3(0, 0, 2.6), 0.0, 0.5)
				_kit(room, "Battery_Green", Vector3(-1.2, 0, 2.7), 0.0, 0.7)
				_kit(room, "Battery_Blue", Vector3(1.2, 0, 2.7), 0.0, 0.7)
				_kit_node(room, "Wall_Display_Green", Vector3(0, 0.4, -3.4), 0.0, Vector3.ONE * 0.8)
			# blinking server racks down both sides + a glowing data-core hologram
			var rack_cols := ["55ff9e", "4ec3ff", "ffd24a", "ff6a8a"]
			for i in 3:
				_server_rack(room, Vector3(-2.7, 0, -2.0 + i * 1.9), 90.0, rack_cols[i % 4])
				_server_rack(room, Vector3(2.7, 0, -2.0 + i * 1.9), -90.0, rack_cols[(i + 2) % 4])
			_holo_core(room, Vector3(0, 0, -0.4), accent)
		"meeting":
			if kit:
				_kit(room, "Octo_Table", Vector3(0, 0, 0), 0.0, 0.45)
				_kit(room, "Chair_1", Vector3(-1.3, 0, -1.3), 135.0, 0.6)
				_kit(room, "Chair_1", Vector3(1.3, 0, -1.3), -135.0, 0.6)
				_kit(room, "Chair_1", Vector3(-1.3, 0, 1.3), 45.0, 0.6)
				_kit(room, "Chair_1", Vector3(1.3, 0, 1.3), -45.0, 0.6)
				_kit(room, "Briefing_Screen_Purple", Vector3(0, 0, -3.0), 0.0, 0.5)
			else:
				room.add_child(_box(Vector3(0, 0.4, 0), Vector3(2.2, 0.8, 2.2), _m("241d30", 0.5)))
		"cafe":
			room.add_child(_box(Vector3(-2.6, 0.5, 0), Vector3(0.9, 1.0, 2.4), _m("2a1d10", 0.5)))   # counter
			for tp in [Vector3(0.6, 0, -1.4), Vector3(1.6, 0, 1.8)]:
				if kit:
					_kit(room, "Cafeteria_Table", tp, 0.0, 0.8)
					_kit(room, "Chair_1", tp + Vector3(0.9, 0, 0.5), -120.0, 0.55)
					_kit(room, "Chair_1", tp + Vector3(-0.9, 0, -0.5), 60.0, 0.55)
				else:
					room.add_child(_box(tp + Vector3(0, 0.4, 0), Vector3(1.0, 0.8, 1.0), _m("3a2a18", 0.5)))
		"dorm":
			if kit:
				_kit(room, "Bunk_Single_Blue", Vector3(-1.8, 0, -1.5), 0.0, 0.7)
				_kit(room, "Bunk_Single_Red", Vector3(1.8, 0, -1.5), 0.0, 0.7)
				_kit(room, "Cryo_Tube_ON", Vector3(2.8, 0, 2.2), 0.0, 0.45)
				_kit(room, "Plant_1", Vector3(-2.8, 0, 2.4), 120.0, 1.5)
			else:
				room.add_child(_box(Vector3(-1.8, 0.3, -1.5), Vector3(1.0, 0.5, 2.0), _m("2a2d3a", 0.6)))
				room.add_child(_box(Vector3(1.8, 0.3, -1.5), Vector3(1.0, 0.5, 2.0), _m("2a2d3a", 0.6)))
		"dormx":
			for i in 4:
				var x := -2.7 + i * 1.8
				if kit:
					_kit(room, "Bunk_Single_" + ["Blue", "Green", "Orange", "Purple"][i], Vector3(x, 0, -1.4), 0.0, 0.7)
				else:
					room.add_child(_box(Vector3(x, 0.3, -1.4), Vector3(1.0, 0.5, 2.0), _m("242636", 0.6)))
		"rec":
			if kit:
				_kit(room, "Large_Monitor_White", Vector3(-3.0, 0, 0), 90.0, 0.5)
				_kit(room, "Chair_1", Vector3(-1.4, 0, -0.5), 90.0, 0.6)
				_kit(room, "Chair_1", Vector3(-1.4, 0, 0.6), 90.0, 0.6)
				_kit(room, "Cafeteria_Table", Vector3(1.6, 0, 1.4), 90.0, 0.8)
				_kit(room, "3D_Chess_Board", Vector3(1.6, 0.62, 1.4), 15.0, 0.35)
				_kit(room, "Hydroponics_Full", Vector3(2.6, 0, -2.4), 0.0, 0.8)
				_kit(room, "Plant_1", Vector3(-2.8, 0, 2.6), 60.0, 1.5)
			else:
				room.add_child(_box(Vector3(-3.0, 0.6, 0), Vector3(0.2, 1.2, 2.0), _m("101418", 0.3)))
		"lobby":
			room.add_child(_box(Vector3(0, 1.2, 0), Vector3(0.5, 2.4, 0.5), _m("1a2025", 0.3, "ff2a20", 1.6)))   # totem
			room.add_child(_box(Vector3(-2.4, 0.5, -2.2), Vector3(1.8, 1.0, 0.7), _m("2a1d18", 0.5)))            # reception
			room.add_child(_box(Vector3(2.4, 0.35, 2.0), Vector3(0.9, 0.7, 0.9), _m("203038", 0.5)))            # armchair
			if kit:
				_kit(room, "End_Table", Vector3(2.4, 0, -2.2), 0.0, 0.8)
				_kit(room, "3D_Chess_Board", Vector3(2.4, 0.75, -2.2), 25.0, 0.35)

## A blinking server rack: dark cabinet + a stack of glowing LED strips.
func _server_rack(room: Node3D, pos: Vector3, roty: float, color: String) -> void:
	var rack := Node3D.new(); rack.position = pos; rack.rotation_degrees = Vector3(0, roty, 0)
	room.add_child(rack)
	rack.add_child(_box(Vector3(0, 0.9, 0), Vector3(0.8, 1.8, 0.55), _m("10141c", 0.5)))
	var led := _m(color, 0.3, color, 2.2)
	for i in 7:
		rack.add_child(_box(Vector3(0, 0.34 + i * 0.22, 0.29), Vector3(0.62, 0.07, 0.03), led))

## A holographic data core: glowing translucent cone + a pad + a light.
func _holo_core(room: Node3D, pos: Vector3, accent: String) -> void:
	room.add_child(_box(pos + Vector3(0, 0.05, 0), Vector3(1.1, 0.1, 1.1), _m("0a0e16", 0.4)))
	var holo := MeshInstance3D.new()
	var cyl := CylinderMesh.new(); cyl.top_radius = 0.06; cyl.bottom_radius = 0.5; cyl.height = 1.7
	holo.mesh = cyl
	var hm := _m(accent, 0.1, accent, 1.8); hm.albedo_color.a = 0.38
	hm.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	holo.material_override = hm; holo.position = pos + Vector3(0, 1.05, 0)
	room.add_child(holo)
	var l := OmniLight3D.new(); l.light_color = Color(accent); l.light_energy = 1.3; l.omni_range = 4.0
	l.position = pos + Vector3(0, 1.3, 0); room.add_child(l)

func _m(hex: String, rough := 0.8, emit := "", emit_e := 0.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(hex); m.roughness = rough
	if emit != "":
		m.emission_enabled = true; m.emission = Color(emit); m.emission_energy_multiplier = emit_e
	return m

func _box(pos: Vector3, size: Vector3, mat: Material) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new(); bm.size = size
	mi.mesh = bm; mi.material_override = mat; mi.position = pos
	return mi
