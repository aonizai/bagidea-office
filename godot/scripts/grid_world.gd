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
const WALL_H := 2.6
const WALL_T := 0.18
const DOOR_W := 2.2        # door-gap width on each interior side

# default room kind per slot (index = row*COLS + col)
var room_order: Array = [
	"exec",  "ops",   "server",
	"lobby", "cafe",  "meeting",
	"rec",   "dormx", "dorm",
]

# kind → {label, floor color, accent}
const ROOM_DEFS := {
	"exec":    {"label": "EXECUTIVE", "floor": "2c2418", "accent": "ffb14a"},
	"ops":     {"label": "OPS FLOOR", "floor": "1b2436", "accent": "4ec3ff"},
	"server":  {"label": "SERVER",    "floor": "16241d", "accent": "55ffaa"},
	"lobby":   {"label": "LOBBY",     "floor": "241a1a", "accent": "ff5a4a"},
	"cafe":    {"label": "CAFETERIA", "floor": "2a1d10", "accent": "ffb874"},
	"meeting": {"label": "MEETING",   "floor": "201a2a", "accent": "b48cff"},
	"rec":     {"label": "RECREATION","floor": "16241d", "accent": "7effc8"},
	"dormx":   {"label": "DORM XL",   "floor": "1a1c2a", "accent": "8ab4ff"},
	"dorm":    {"label": "DORM",      "floor": "1c1e2c", "accent": "9ab0ff"},
}

var _cell_node: Array = []      # slot index → container Node3D
var _cell_center: Array = []    # slot index → Vector3 (fixed)

func _ready() -> void:
	_build()

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
	_box(Vector3(0, -0.1, 0), Vector3(GRID_COLS * CELL + 0.4, 0.2, GRID_ROWS * CELL + 0.4), _m("0e1016", 0.6))
	var wallm := _m("20232e", 0.9)
	_box(Vector3(0, WALL_H * 0.5, -halfz), Vector3(GRID_COLS * CELL + WALL_T, WALL_H, WALL_T), wallm)
	_box(Vector3(0, WALL_H * 0.5,  halfz), Vector3(GRID_COLS * CELL + WALL_T, WALL_H, WALL_T), wallm)
	_box(Vector3(-halfx, WALL_H * 0.5, 0), Vector3(WALL_T, WALL_H, GRID_ROWS * CELL), wallm)
	_box(Vector3( halfx, WALL_H * 0.5, 0), Vector3(WALL_T, WALL_H, GRID_ROWS * CELL), wallm)

	for slot in range(GRID_COLS * GRID_ROWS):
		var center := slot_center(slot)
		_cell_center.append(center)
		var room := Node3D.new()
		room.position = center
		add_child(room)
		_cell_node.append(room)
		_build_room(room, String(room_order[slot]))

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

## Build one room's contents at LOCAL origin (cell centre = 0,0,0).
func _build_room(room: Node3D, kind: String) -> void:
	var d: Dictionary = ROOM_DEFS.get(kind, ROOM_DEFS["ops"])
	var half := CELL * 0.5
	# floor carpet
	var fl := _box(Vector3(0, 0.01, 0), Vector3(CELL - WALL_T, 0.04, CELL - WALL_T), _m(String(d["floor"]), 0.95))
	room.add_child(fl)
	# four inner walls, each split around a centre door gap
	var wm := _m("2a2e3a", 0.85)
	var side := (CELL - DOOR_W) * 0.5
	var off := (DOOR_W + side) * 0.5
	for s in [-1.0, 1.0]:
		# walls running along X (north/south sides), gap in the middle
		var nz: float = s * half
		room.add_child(_box(Vector3(-off, WALL_H * 0.5, nz), Vector3(side, WALL_H, WALL_T), wm))
		room.add_child(_box(Vector3( off, WALL_H * 0.5, nz), Vector3(side, WALL_H, WALL_T), wm))
		# walls running along Z (east/west sides)
		var nx: float = s * half
		room.add_child(_box(Vector3(nx, WALL_H * 0.5, -off), Vector3(WALL_T, WALL_H, side), wm))
		room.add_child(_box(Vector3(nx, WALL_H * 0.5,  off), Vector3(WALL_T, WALL_H, side), wm))
	# accent ceiling light
	var lamp := OmniLight3D.new(); lamp.position = Vector3(0, WALL_H - 0.2, 0)
	lamp.light_color = Color(String(d["accent"])); lamp.light_energy = 1.4; lamp.omni_range = CELL * 0.9
	room.add_child(lamp)
	# floating room label so the top-down render is readable
	var lbl := Label3D.new()
	lbl.text = String(d["label"]); lbl.font_size = 64; lbl.pixel_size = 0.012
	lbl.modulate = Color(String(d["accent"]))
	lbl.position = Vector3(0, WALL_H + 0.6, 0); lbl.rotation_degrees = Vector3(-90, 0, 0)
	lbl.billboard = BaseMaterial3D.BILLBOARD_DISABLED
	room.add_child(lbl)
	_furnish(room, kind, String(d["accent"]))

# ----------------------------------------------------------- kit furniture
const SCIFI_DIR := "res://assets/scifi/"
var _kit_cache := {}

func _kit_avail() -> bool:
	return FileAccess.file_exists(ProjectSettings.globalize_path(SCIFI_DIR + "Chair_1.glb"))

func _kit(room: Node3D, model: String, lpos: Vector3, roty := 0.0, s := 1.0) -> void:
	if not _kit_cache.has(model):
		var doc := GLTFDocument.new(); var st := GLTFState.new()
		var path := ProjectSettings.globalize_path(SCIFI_DIR + model + ".glb")
		_kit_cache[model] = doc.generate_scene(st) if doc.append_from_file(path, st) == OK else null
	var proto = _kit_cache[model]
	if proto == null: return
	var inst: Node3D = proto.duplicate()
	inst.position = lpos; inst.rotation_degrees = Vector3(0, roty, 0); inst.scale = Vector3.ONE * s
	room.add_child(inst)

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
				_kit(room, "Generator", Vector3(0.6, 0, -1.8), 25.0, 0.55)
				_kit(room, "Generator_Pile_Chonky", Vector3(-2.2, 0, -2.6), 0.0, 0.45)
				_kit(room, "Battery_Green", Vector3(2.6, 0, 0.6), 90.0, 0.8)
				_kit(room, "Battery_Blue", Vector3(2.6, 0, 1.5), 90.0, 0.8)
				_kit(room, "Generator_Pile_Small", Vector3(-2.4, 0, 2.0), 0.0, 0.5)
			else:
				room.add_child(_box(Vector3(0, 0.7, -1.8), Vector3(1.6, 1.4, 1.0), _m("1c2a22", 0.4)))
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
