extends Node3D
## Office floor v3 (art pass): 5 zones with full procedural set-dressing —
## glass partitions, window frames, city skyline, bookshelves, pendant lamps,
## floor logo, props per zone. Owns the walkable waypoint graph (AStar3D).
## All geometry is data-driven; a real asset pass replaces builders, the
## graph + anchor + board APIs stay.

const BEAM_SHADER := preload("res://shaders/light_beam.gdshader")
const SCREEN_SHADER := preload("res://shaders/screen_code.gdshader")
const FLOOR_SHADER := preload("res://shaders/floor_planks.gdshader")
const GRASS_SHADER := preload("res://shaders/grass_blade.gdshader")

var WP := {
	"exec_c": Vector3(-6, 0.86, -6),
	"ceo_desk": Vector3(-6, 0.86, -6.9),     # in FRONT of the console, not in it
	"lead_desk": Vector3(-3.2, 0.86, -7.8),  # the Director's own workstation
	"pace_a": Vector3(-7.2, 0.86, -7.0),
	"pace_b": Vector3(-4.8, 0.86, -7.0),
	"ops_c": Vector3(3, 0.86, -6.75),
	"ap1": Vector3(2.4, 0.86, -8.85),
	"ap2": Vector3(6.55, 0.86, -8.85),
	"desk1": Vector3(1, 0.86, -8.85),
	"desk2": Vector3(5, 0.86, -8.85),
	"desk3": Vector3(1, 0.86, -6.35),
	"desk4": Vector3(5, 0.86, -6.35),
	"lobby_c": Vector3(-1, 0.86, 1.5),
	"spawn": Vector3(-1, 0.86, 12.6),
	"cafe_c": Vector3(7.2, 0.86, 0.2),
	"cafe_s1": Vector3(5.7, 0.86, 1.5),
	"cafe_s2": Vector3(8.2, 0.86, 2.6),
	"sec_c": Vector3(-8, 0.86, -1.2),
	"sec_window": Vector3(-8, 0.86, 0.3),
	"door_el": Vector3(-4, 0.86, -3),
	"door_ol": Vector3(1, 0.86, -3),
	"door_oc": Vector3(6, 0.86, -3),
	"door_eo": Vector3(-2, 0.86, -6.5),
	"door_sl": Vector3(-6, 0.86, -0.5),
	"door_lc": Vector3(4, 0.86, 1),
	# East wing: Server Room (north), Meeting Room (mid), Dormitory (south)
	"server_c": Vector3(13, 0.86, -6.5),
	"door_os": Vector3(10, 0.86, -8),
	"meeting_c": Vector3(13, 0.86, -0.5),
	"door_cm": Vector3(10, 0.86, 0),
	"door_sm": Vector3(13, 0.86, -3),
	"m_s1": Vector3(11.6, 0.86, -1.5),
	"m_s2": Vector3(14.4, 0.86, -1.5),
	"m_s3": Vector3(11.6, 0.86, 0.6),
	"m_s4": Vector3(14.4, 0.86, 0.6),
	"dorm_c": Vector3(13, 0.86, 3.6),
	"door_md": Vector3(13, 0.86, 2),
	"bed1": Vector3(11.5, 0.86, 4.2),
	"bed2": Vector3(14.5, 0.86, 4.2),
	# South wing: Recreation (west) + Dormitory XL (east)
	"rec_c": Vector3(-3.5, 0.86, 9.5),
	"door_lr": Vector3(-1, 0.86, 6),
	"rec_s1": Vector3(-6.6, 0.86, 8.4),
	"rec_s2": Vector3(-1.6, 0.86, 10.6),
	"rec_s3": Vector3(-4.6, 0.86, 7.6),
	"rec_s4": Vector3(-6.9, 0.86, 11.2),
	"dormx_c": Vector3(9.5, 0.86, 9.3),
	"door_cd2": Vector3(7, 0.86, 6),
	"door_dd": Vector3(13, 0.86, 6),
	"b3": Vector3(4.6, 0.86, 10.7),
	"b4": Vector3(6.4, 0.86, 10.7),
	"b5": Vector3(8.2, 0.86, 10.7),
	"b6": Vector3(10.0, 0.86, 10.7),
	"b7": Vector3(11.8, 0.86, 10.7),
	"b8": Vector3(13.6, 0.86, 10.7),
	# Ops extra desks (east column)
	"desk5": Vector3(8, 0.86, -7.15),
	"desk6": Vector3(8, 0.86, -6.35),
}

const EDGES := [
	["exec_c", "door_el"], ["exec_c", "door_eo"], ["exec_c", "ceo_desk"],
	["exec_c", "lead_desk"], ["ceo_desk", "lead_desk"],
	["ceo_desk", "pace_a"], ["ceo_desk", "pace_b"],
	["ops_c", "door_ol"], ["ops_c", "door_oc"], ["ops_c", "door_eo"],
	["ops_c", "ap1"], ["ap1", "desk1"], ["ops_c", "ap2"], ["ap2", "desk2"],
	["ops_c", "desk3"], ["ops_c", "desk4"],
	["lobby_c", "door_el"], ["lobby_c", "door_ol"], ["lobby_c", "door_sl"],
	["lobby_c", "door_lc"],
	["cafe_c", "door_oc"], ["cafe_c", "door_lc"],
	["cafe_c", "cafe_s1"], ["cafe_c", "cafe_s2"],
	["sec_c", "door_sl"], ["sec_c", "sec_window"],
	["ops_c", "door_os"], ["door_os", "server_c"],
	["cafe_c", "door_cm"], ["door_cm", "meeting_c"],
	["meeting_c", "door_sm"], ["door_sm", "server_c"],
	["meeting_c", "m_s1"], ["meeting_c", "m_s2"],
	["meeting_c", "m_s3"], ["meeting_c", "m_s4"],
	["meeting_c", "door_md"], ["door_md", "dorm_c"],
	["dorm_c", "bed1"], ["dorm_c", "bed2"],
	["lobby_c", "door_lr"], ["door_lr", "rec_c"], ["rec_c", "spawn"],
	["rec_c", "rec_s1"], ["rec_c", "rec_s2"], ["rec_c", "rec_s3"], ["rec_c", "rec_s4"],
	["cafe_c", "door_cd2"], ["door_cd2", "dormx_c"],
	["dorm_c", "door_dd"], ["door_dd", "dormx_c"],
	["dormx_c", "b3"], ["dormx_c", "b4"], ["dormx_c", "b5"],
	["dormx_c", "b6"], ["dormx_c", "b7"], ["dormx_c", "b8"],
	["ops_c", "desk5"], ["ops_c", "desk6"],
]

const BOARD_COLORS := {
	"running": Color(0.3, 0.75, 1.0),
	"blocked": Color(1.0, 0.62, 0.25),
	"done": Color(0.35, 1.0, 0.5),
	"failed": Color(1.0, 0.3, 0.25),
}

var astar := AStar3D.new()
var _grid: Node3D            # the swappable room-grid (owns geometry, anchors, A* graph)
var _ghost_deck: Node3D     # the floating sub-ops platform (movable from the editor)
var _billboard_logo: MeshInstance3D   # the brand sign face (user can swap its image)
var _billboard_pending := ""          # billboard image requested before the sign was built
const GRID_SCRIPT := preload("res://scripts/grid_world.gd")
var _ops_nodes: Array = []   # baked ops-desk visuals (hideable when the editor supplies custom workstations)

var _anchor_override := {}   # name → moved position (WP is const/immutable)

## Move a named agent anchor at runtime (editor → agents follow). path_to()
## resolves targets through the A* point positions, so moving the point makes
## characters walk to the new spot.
func set_anchor(name: String, pos: Vector3) -> void:
	_anchor_override[name] = pos
	if _wp_ids.has(name):
		astar.set_point_position(_wp_ids[name], pos)

## Swap two grid rooms (jigsaw). Editor + wallpaper both call this.
func swap_cells(a: int, b: int) -> void:
	if _grid: _grid.swap_slots(a, b)
	_resnap_agents()

## After rooms move, drop characters back onto their (now-relocated) anchors.
func _resnap_agents() -> void:
	var am := get_parent().get_node_or_null("AgentManager")
	if am and am.has_method("resnap_agents"):
		am.resnap_agents()

## Current room kind per slot (for the editor UI + saving to layout.json).
func get_room_order() -> Array:
	return _grid.room_order.duplicate() if _grid else []

## Number of grid slots (cols*rows).
func grid_slots() -> int:
	return _grid.GRID_COLS * _grid.GRID_ROWS if _grid else 0

func grid_cols() -> int:
	return _grid.GRID_COLS if _grid else 3

## Rearrange rooms to match a saved order (list of kind strings per slot).
func apply_room_order(target: Array) -> void:
	if _grid == null or target.is_empty(): return
	for i in range(min(target.size(), _grid.room_order.size())):
		if _grid.room_order[i] == target[i]: continue
		for j in range(i + 1, _grid.room_order.size()):
			if _grid.room_order[j] == target[i]:
				_grid.swap_slots(i, j); break
	_resnap_agents()

## Swap the company billboard image (user upload). Keeps the sign's aspect by
## fitting the image into the panel; accepts res://, /uploads/ or absolute paths.
func set_billboard_texture(path: String) -> void:
	if path == "": return
	if _billboard_logo == null:
		_billboard_pending = path   # sign not built yet — apply when it is
		return
	var p := path
	if p.begins_with("res://"): p = ProjectSettings.globalize_path(p)
	elif p.begins_with("/uploads/"): p = ProjectSettings.globalize_path("res://..") + "/workspace/uploads/" + p.get_file()
	var img := Image.new()
	if img.load(p) != OK: return
	var m := StandardMaterial3D.new()
	m.albedo_texture = ImageTexture.create_from_image(img)
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	_billboard_logo.material_override = m

## Ghost (sub-ops) deck position — editor nudges it, layout persists it.
func move_ghost_deck(dx: float, dz: float) -> void:
	if _ghost_deck: _ghost_deck.position += Vector3(dx, 0, dz)
func set_ghost_deck_pos(x: float, z: float) -> void:
	if _ghost_deck: _ghost_deck.position = Vector3(x, _ghost_deck.position.y, z)
func ghost_deck_pos() -> Vector2:
	return Vector2(_ghost_deck.position.x, _ghost_deck.position.z) if _ghost_deck else Vector2.ZERO

## Hide/show the baked ops desks (used when a custom layout provides its own
## work desks so they don't double up).
func hide_ops_desks(h: bool) -> void:
	for n in _ops_nodes:
		if is_instance_valid(n):
			n.visible = not h
var totem_mat: StandardMaterial3D
var sec_light: OmniLight3D
var sky_mat: StandardMaterial3D
var beam_mats: Array[ShaderMaterial] = []
var pet: Sprite3D        # the office cat (or fallback dog) — agents play with it
var ball: CSGSphere3D    # the rec football
var _tv_glow: Node3D     # screen glow + light, on while someone watches
var _tv_dark: MeshInstance3D  # matte panel covering the screen when OFF
var _lamp_lights: Array[OmniLight3D] = []      # garden lamps — night only
var _lamp_heads: Array[StandardMaterial3D] = []

var _wp_ids := {}
var _board_slots := {}
var _board_free: Array[int] = [0, 1, 2, 3, 4, 5]
# Mission-board card anchor (moves onto the Briefing_Screen when the kit is present).
var _board_x := 4.75
var _board_z := -9.91
var _board_y0 := 2.25
var _glb_cache := {}

# ------------------------------------------------------- sci-fi model kit

const SCIFI_DIR := "res://assets/scifi/"

## Molten Maps models are licensed (gitignored): present → modern furniture,
## absent → the original CSG greybox props. Loaded at runtime via GLTFDocument
## so no Godot import step is needed.
func _kit_available() -> bool:
	return FileAccess.file_exists(ProjectSettings.globalize_path(SCIFI_DIR + "Chair_1.glb"))

func _kit(model: String, pos: Vector3, rot_y := 0.0, s := 1.0) -> Node3D:
	return _kit_scaled(model, pos, rot_y, Vector3.ONE * s)

# ------------------------------------------------- environment model pack

const ENV_DIR := "res://assets/env/"

func _env_available() -> bool:
	return FileAccess.file_exists(ProjectSettings.globalize_path(ENV_DIR + "Tree_1.fbx"))

## Low-poly environment FBX (user-provided pack), runtime-loaded + cached.
func _env(model: String, pos: Vector3, rot_y := 0.0, s := 1.0) -> Node3D:
	var key := "env:" + model
	if not _glb_cache.has(key):
		var doc := FBXDocument.new()
		var state := FBXState.new()
		var path := ProjectSettings.globalize_path(ENV_DIR + model + ".fbx")
		_glb_cache[key] = doc.generate_scene(state) if doc.append_from_file(path, state) == OK else null
	var proto: Node3D = _glb_cache[key]
	if proto == null:
		return null
	var inst: Node3D = proto.duplicate()
	add_child(inst)
	inst.position = pos
	inst.rotation_degrees = Vector3(0, rot_y, 0)
	inst.scale = Vector3.ONE * s
	return inst

func _kit_scaled(model: String, pos: Vector3, rot_y: float, s: Vector3) -> Node3D:
	if not _glb_cache.has(model):
		var doc := GLTFDocument.new()
		var state := GLTFState.new()
		var path := ProjectSettings.globalize_path(SCIFI_DIR + model + ".glb")
		_glb_cache[model] = doc.generate_scene(state) if doc.append_from_file(path, state) == OK else null
	var proto: Node3D = _glb_cache[model]
	if proto == null:
		return null
	var inst: Node3D = proto.duplicate()
	add_child(inst)
	inst.position = pos
	inst.rotation_degrees = Vector3(0, rot_y, 0)
	inst.scale = s
	return inst

func _no_shadow(node: Node) -> void:
	if node is GeometryInstance3D:
		node.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	for c in node.get_children():
		_no_shadow(c)

## Airport-queue stanchion: two chrome posts + a blue fabric strap that sags
## in the middle. Replaces the kit Floor_Lamp, whose bar-on-one-pole
## silhouette read as a half-finished barrier from wallpaper distance.
func _stanchion(pos: Vector3, rot_y := 0.0) -> Node3D:
	var rig := Node3D.new()
	add_child(rig)
	rig.position = pos
	rig.rotation_degrees = Vector3(0, rot_y, 0)
	var post_mat := StandardMaterial3D.new()
	post_mat.albedo_color = Color(0.55, 0.58, 0.62)
	post_mat.metallic = 0.85
	post_mat.roughness = 0.3
	var strap_mat := StandardMaterial3D.new()
	strap_mat.albedo_color = Color(0.13, 0.28, 0.72)
	strap_mat.roughness = 0.92
	for sx in [-0.6, 0.6]:
		var base := MeshInstance3D.new()
		var bm := CylinderMesh.new()
		bm.top_radius = 0.13
		bm.bottom_radius = 0.16
		bm.height = 0.05
		base.mesh = bm
		base.material_override = post_mat
		base.position = Vector3(sx, 0.025, 0)
		rig.add_child(base)
		var pole := MeshInstance3D.new()
		var pm := CylinderMesh.new()
		pm.top_radius = 0.028
		pm.bottom_radius = 0.028
		pm.height = 0.95
		pole.mesh = pm
		pole.material_override = post_mat
		pole.position = Vector3(sx, 0.5, 0)
		rig.add_child(pole)
		var knob := MeshInstance3D.new()
		var km := SphereMesh.new()
		km.radius = 0.05
		km.height = 0.1
		knob.mesh = km
		knob.material_override = post_mat
		knob.position = Vector3(sx, 1.0, 0)
		rig.add_child(knob)
	# Two tilted halves meeting low in the middle — a cheap, readable sag.
	for side in [-1.0, 1.0]:
		var strap := MeshInstance3D.new()
		var sm := BoxMesh.new()
		sm.size = Vector3(0.62, 0.085, 0.015)
		strap.mesh = sm
		strap.material_override = strap_mat
		strap.position = Vector3(side * 0.3, 0.835, 0)
		strap.rotation_degrees = Vector3(0, 0, side * 8.0)
		rig.add_child(strap)
	return rig

var _tint_mat_cache := {}

## Multiplies a kit model's materials by a color (zone-keying plain floors).
## rough >= 0 also polishes the surface so SSR can mirror lights/furniture.
func _tint_meshes(node: Node, tint: Color, rough := -1.0) -> void:
	if node is MeshInstance3D:
		var mi: MeshInstance3D = node
		if mi.mesh:
			for i in mi.mesh.get_surface_count():
				var src := mi.get_active_material(i)
				if src is BaseMaterial3D:
					var key := str(src.get_instance_id()) + tint.to_html() + str(rough)
					if not _tint_mat_cache.has(key):
						var dup: BaseMaterial3D = src.duplicate()
						dup.albedo_color = tint
						if rough >= 0.0:
							dup.roughness = rough
							dup.metallic = 0.12
						_tint_mat_cache[key] = dup
					mi.set_surface_override_material(i, _tint_mat_cache[key])
	for c in node.get_children():
		_tint_meshes(c, tint, rough)

## Kit floor: tile a zone with nx × nz pieces stretched to fit exactly.
func _kit_floor(model: String, center: Vector3, w: float, d: float, nx: int, nz: int,
		tint := Color.WHITE) -> void:
	for ix in nx:
		for iz in nz:
			var px := center.x + ((ix + 0.5) / nx - 0.5) * w
			var pz := center.z + ((iz + 0.5) / nz - 0.5) * d
			var tile := _kit_scaled(model, Vector3(px, 0, pz), 0.0,
				Vector3(w / nx / 4.0, 1.0, d / nz / 4.0))
			if tile:
				_tint_meshes(tile, tint, 0.3)  # polished: floors catch SSR

## Kit shell: perimeter walls (solid + full-glass windows), railing
## partitions on the original segment plan, zone carpet floors.
func _kit_architecture() -> void:
	var ws := 0.875  # 4 m kit walls → 3.5 m

	# North wall, 6 segments over 26.9 m (x -10.3..16.6): glass bays light
	# ops + cafe; the server room (east end) stays solid.
	var north := ["Wall_Grey", "Wall_Glass_Clear", "Wall_Grey", "Wall_Glass_Clear", "Wall_Grey", "Wall_Grey"]
	for i in 6:
		var cx := -10.3 + 4.483 * (i + 0.5)
		var seg := _kit_scaled(north[i], Vector3(cx, 0, -10.15), 0.0, Vector3(1.12, ws, ws))
		if seg and north[i].begins_with("Wall_Glass"):
			_no_shadow(seg)  # sun shines through the window panels
	_kit_scaled("Wall_Display_Blue", Vector3(0.9, 0.35, -9.72), 0.0, Vector3.ONE * ws)

	# West & far-east perimeter (extended past the south wing, rotated)
	for i in 4:
		var cz := -10.15 + 4.075 * (i + 0.5)
		_kit_scaled("Wall_Grey", Vector3(-10.15, 0, cz), 90.0, Vector3(1.019, ws, ws))
		_kit_scaled("Wall_Grey", Vector3(16.15, 0, cz), -90.0, Vector3(1.019, ws, ws))
	for i in 2:
		var cz := 6.15 + 3.5 * (i + 0.5)
		_kit_scaled("Wall_Grey", Vector3(-10.15, 0, cz), 90.0, Vector3(0.875, ws, ws))
		_kit_scaled("Wall_Grey", Vector3(16.15, 0, cz), -90.0, Vector3(0.875, ws, ws))

	# Wing divider at x=10 with real doorway pieces (ops→server, cafe→meeting)
	var divider := ["Wall_With_Door_Grey", "Wall_Grey", "Wall_With_Door_Grey", "Wall_Grey"]
	for i in 4:
		var cz := -10.0 + 4.0 * (i + 0.5)
		_kit_scaled(divider[i], Vector3(10.0, 0, cz), 90.0, Vector3(1.0, ws, ws))

	# Inner partitions: railings stretched onto the original segment plan
	# (door gaps preserved). Railing is 3.92 m long, 1.13 m tall at scale 1.
	for s in [[-7.4, 5.2], [-1.5, 3.4], [3.5, 3.4], [8.4, 3.2]]:               # along z=-3
		_kit_scaled("Railing_Flat", Vector3(s[0], 0, -3), 0.0, Vector3(s[1] / 3.92, 1.06, 1.0))
	for s in [[-8.65, 2.7], [-4.35, 2.7]]:                                     # exec|ops x=-2
		_kit_scaled("Railing_Flat", Vector3(-2, 0, s[0]), 90.0, Vector3(s[1] / 3.92, 1.06, 1.0))
	for s in [[-2.15, 1.7], [1.15, 1.7]]:                                      # sec|lobby x=-6
		_kit_scaled("Railing_Flat", Vector3(-6, 0, s[0]), 90.0, Vector3(s[1] / 3.92, 1.06, 1.0))
	_kit_scaled("Railing_Flat", Vector3(-8, 0, 2), 0.0, Vector3(4.3 / 3.92, 1.06, 1.0))  # sec south
	for s in [[-1.4, 3.2], [3.9, 4.2]]:                                        # lobby|cafe x=4
		_kit_scaled("Railing_Flat", Vector3(4, 0, s[0]), 90.0, Vector3(s[1] / 3.92, 1.06, 1.0))
	# East wing partitions: server|meeting (z=-3) and meeting|dorm (z=2),
	# each with a center gap at x=13.
	for s in [[11.1, 2.2], [14.9, 2.2]]:
		_kit_scaled("Railing_Flat", Vector3(s[0], 0, -3), 0.0, Vector3(s[1] / 3.92, 1.06, 1.0))
		_kit_scaled("Railing_Flat", Vector3(s[0], 0, 2), 0.0, Vector3(s[1] / 3.92, 1.06, 1.0))
	# South wing partitions: z=6 row (doors to rec/dorm-xl) + rec|dorm at x=3
	for s in [[-5.9, 8.2], [3.0, 6.4], [10.0, 4.4], [14.9, 2.2]]:
		_kit_scaled("Railing_Flat", Vector3(s[0], 0, 6), 0.0, Vector3(s[1] / 3.92, 1.06, 1.0))
	for s in [[7.35, 2.7], [11.65, 2.7]]:
		_kit_scaled("Railing_Flat", Vector3(3, 0, s[0]), 90.0, Vector3(s[1] / 3.92, 1.06, 1.0))

	# Zone floors: calm plain metal everywhere, zone-keyed by a subtle tint.
	_kit_floor("Floor_Metal_Square", Vector3(-6, 0, -6.5), 7.6, 6.6, 3, 3, Color(1.0, 0.88, 0.7))   # exec warm
	_kit_floor("Floor_Metal_Square", Vector3(4, 0, -6.5), 11.6, 6.6, 5, 3, Color(0.74, 0.84, 1.0))  # ops cool
	_kit_floor("Floor_Metal_Square", Vector3(-1, 0, 1.5), 9.6, 8.6, 4, 3)                           # lobby neutral
	_kit_floor("Floor_Metal_Square", Vector3(7, 0, 1.5), 5.6, 8.6, 3, 4, Color(1.0, 0.76, 0.66))    # cafe warm red
	_kit_floor("Floor_Metal_Square", Vector3(-8, 0, -0.5), 3.6, 4.6, 2, 2, Color(0.78, 1.0, 0.8))   # sec green
	_kit_floor("Floor_Metal_Square", Vector3(13, 0, -6.5), 5.6, 6.6, 2, 3, Color(0.7, 0.92, 0.82))  # server teal
	_kit_floor("Floor_Metal_Square", Vector3(13, 0, -0.5), 5.6, 4.6, 2, 2, Color(0.86, 0.8, 1.0))   # meeting violet
	_kit_floor("Floor_Metal_Square", Vector3(13, 0, 4), 5.6, 3.6, 2, 1, Color(0.78, 0.82, 0.98))    # dorm dusk
	_kit_floor("Floor_Metal_Square", Vector3(-3.5, 0, 9.5), 12.6, 6.6, 4, 2, Color(0.84, 1.0, 0.86)) # rec green
	_kit_floor("Floor_Metal_Square", Vector3(9.5, 0, 9.5), 12.6, 6.6, 4, 2, Color(0.78, 0.82, 0.98)) # dorm-xl

func _ready() -> void:
	_build_geometry()
	_build_ghost_deck()
	_build_garden_lamps()
	_build_sky_life()
	_build_ambient_particles()
	_build_clock()
	_bird_loop()

# ---------------------------------------------------------------- ghost deck
## Floating glass platform above the east wing — the SUB OPS office where
## sub-agent ghosts materialize and work. Lives on render layer 2 (with the
## characters) so the boot-time floorplan capture culls it: the overlay map
## keeps showing the real rooms beneath. No stairs on purpose — ghosts float.

## Standing spots (one per desk) for ghost clones — 12 desks, 3 rows of 4
## (the west strip is the staircase landing). Deck top is y 3.46; characters
## stand at floor + 0.86.
const GHOST_DESKS := [
	Vector3(12.6, 4.32, -5.75), Vector3(13.95, 4.32, -5.75),
	Vector3(15.3, 4.32, -5.75), Vector3(16.6, 4.32, -5.75),
	Vector3(12.6, 4.32, -3.75), Vector3(13.95, 4.32, -3.75),
	Vector3(15.3, 4.32, -3.75), Vector3(16.6, 4.32, -3.75),
	Vector3(12.6, 4.32, -1.75), Vector3(13.95, 4.32, -1.75),
	Vector3(15.3, 4.32, -1.75), Vector3(16.6, 4.32, -1.75),
]

## The glass staircase: ghosts walk the office graph to the server room,
## then climb this straight flight onto the deck (no more wall-phasing).
const GHOST_STAIR_BASE := Vector3(11.55, 0.86, -3.1)
const GHOST_STAIR_TOP := Vector3(11.55, 4.32, -7.3)

func _build_ghost_deck() -> void:
	var deck := Node3D.new()
	deck.name = "GhostDeck"
	add_child(deck)
	# shift the whole deck so it floats above the grid (geometry is built around
	# old east coords ~x14,z-4, so this offset re-centres it over the office)
	deck.position = Vector3(-7.0, 0.4, -3.6)
	_ghost_deck = deck

	var glass := StandardMaterial3D.new()
	glass.albedo_color = Color(0.62, 0.78, 1.0, 0.2)
	glass.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	glass.roughness = 0.08
	glass.metallic = 0.2
	glass.emission_enabled = true
	glass.emission = Color(0.5, 0.65, 1.0)
	glass.emission_energy_multiplier = 0.05
	glass.cull_mode = BaseMaterial3D.CULL_DISABLED
	var trim := _mat(Color(0.2, 0.12, 0.4), 0.4, Color(0.6, 0.4, 1.0), 0.7)
	var dark := StandardMaterial3D.new()
	dark.albedo_color = Color(0.12, 0.14, 0.26, 0.72)
	dark.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	dark.roughness = 0.3
	var screen := _mat(Color(0.06, 0.1, 0.2), 0.3, Color(0.45, 0.8, 1.0), 1.2)

	# Glass slab: x 11..17.2, z -8.2..-0.6, hovering over the server room.
	_deck_box(deck, Vector3(14.1, 3.4, -4.4), Vector3(6.2, 0.12, 7.6), glass)
	# Glowing edge trim — reads "anti-grav platform" from wallpaper distance.
	_deck_box(deck, Vector3(14.1, 3.42, -8.18), Vector3(6.2, 0.07, 0.07), trim)
	_deck_box(deck, Vector3(14.1, 3.42, -0.62), Vector3(6.2, 0.07, 0.07), trim)
	_deck_box(deck, Vector3(11.04, 3.42, -4.4), Vector3(0.07, 0.07, 7.6), trim)
	_deck_box(deck, Vector3(17.16, 3.42, -4.4), Vector3(0.07, 0.07, 7.6), trim)
	# Anti-grav glow discs under the corners.
	for corner in [Vector3(11.6, 3.28, -7.6), Vector3(16.6, 3.28, -7.6),
			Vector3(11.6, 3.28, -1.2), Vector3(16.6, 3.28, -1.2)]:
		var disc := CSGCylinder3D.new()
		disc.radius = 0.32
		disc.height = 0.06
		disc.material = _mat(Color(0.2, 0.3, 0.5), 0.4, Color(0.45, 0.8, 1.0), 0.8)
		deck.add_child(disc)
		disc.position = corner

	# Eight ghost desks (2 rows of 4): translucent top, single leg, glowing
	# screen facing the camera. Ghosts stand at GHOST_DESKS (south side).
	for i in GHOST_DESKS.size():
		var stand: Vector3 = GHOST_DESKS[i]
		var dz := stand.z - 0.85
		_deck_box(deck, Vector3(stand.x, 4.03, dz), Vector3(0.92, 0.05, 0.52), dark)
		var leg := CSGCylinder3D.new()
		leg.radius = 0.05
		leg.height = 0.56
		leg.material = dark
		deck.add_child(leg)
		leg.position = Vector3(stand.x, 3.74, dz)
		var scr := _deck_box(deck, Vector3(stand.x, 4.32, dz - 0.12), Vector3(0.64, 0.38, 0.03), screen)
		scr.rotation_degrees = Vector3(-12, 0, 0)

	# Glass staircase up from the server room — steps follow the
	# GHOST_STAIR_BASE→TOP line so walking the slope lands on every tread.
	var steps := 14
	for i in steps:
		var f := (float(i) + 0.5) / float(steps)
		var sy := lerpf(0.12, 3.4, f)
		var sz := lerpf(-3.1, -7.3, f)
		_deck_box(deck, Vector3(11.55, sy, sz), Vector3(1.15, 0.07, 0.34), glass)
		if i % 2 == 0:
			_deck_box(deck, Vector3(10.97, sy + 0.02, sz), Vector3(0.05, 0.05, 0.34), trim)
			_deck_box(deck, Vector3(12.13, sy + 0.02, sz), Vector3(0.05, 0.05, 0.34), trim)

	# Sign over the north edge, tilted at the camera like the roof billboard.
	var plate := Label3D.new()
	plate.text = "GHOST DECK · SUB OPS"
	plate.font_size = 72
	plate.outline_size = 16
	plate.pixel_size = 0.004
	plate.modulate = Color(0.78, 0.62, 1.0)
	deck.add_child(plate)
	plate.position = Vector3(14.1, 4.5, -1.2)   # front edge of the deck — clear of the back-wall clock/billboard
	plate.rotation_degrees = Vector3(-42, 0, 0)

	# Cool spectral light, masked to layer 2 — the rooms below stay untinted.
	var lamp := OmniLight3D.new()
	lamp.light_color = Color(0.62, 0.55, 1.0)
	lamp.light_energy = 1.8
	lamp.omni_range = 4.5
	lamp.light_volumetric_fog_energy = 0.2
	lamp.light_cull_mask = 2
	deck.add_child(lamp)
	lamp.position = Vector3(14.1, 5.4, -4.2)

	_set_layer(deck, 2)
	_no_shadow(deck)

func _deck_box(parent: Node3D, pos: Vector3, size: Vector3, mat: Material) -> CSGBox3D:
	var b := CSGBox3D.new()
	b.size = size
	b.material = mat
	parent.add_child(b)
	b.position = pos
	return b

func _set_layer(node: Node, layer: int) -> void:
	if node is VisualInstance3D:
		node.layers = layer
	for c in node.get_children():
		_set_layer(c, layer)

# ---------------------------------------------------------------- ambient life

const BirdScript := preload("res://scripts/bird_sprite.gd")

## Soft clouds drifting across the sky forever + occasional bird flocks.
func _build_sky_life() -> void:
	# Cartoon clouds (opaque puffy clusters, flat-ish base — the Zelda look).
	# Shaded so the day cycle lights them, plus a soft emission floor that
	# keeps the undersides fluffy instead of hard-shadowed plastic balls.
	var cmat := StandardMaterial3D.new()
	cmat.albedo_color = Color(0.93, 0.95, 1.0, 0.36)  # จาง ๆ อ่อน ๆ
	cmat.roughness = 1.0
	cmat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	cmat.emission_enabled = true
	cmat.emission = Color(0.86, 0.9, 1.0)
	cmat.emission_energy_multiplier = 0.16

	# Horizon layer behind the building.
	for i in 3:
		var cloud := _make_cloud(randf_range(2.2, 3.2), cmat)
		add_child(cloud)
		cloud.position = Vector3(randf_range(-52.0, 52.0),
			randf_range(15.0, 22.0), randf_range(-34.0, -14.0))
		_drift_cloud(cloud, 56.0)

	# Crossing layer: parented to the CAMERA, drifting across its local X —
	# the only placement a -45° top-down camera is guaranteed to actually
	# see. Small distinct clouds glide over the office now and then.
	var cam := get_node_or_null("../CameraRig/Camera3D")
	if cam:
		var pin := "--cloudtest" in OS.get_cmdline_user_args()  # one dead-center
		for i in 3:
			var cloud := _make_cloud(randf_range(0.8, 1.15), cmat)
			cam.add_child(cloud)
			# At -30m a 28° lens sees ~±7.3 vertically: keep clouds in the
			# upper band of the FRAME (local y ~0..4), not above it.
			cloud.position = Vector3(0.0 if (pin and i == 0) else randf_range(-36.0, 36.0),
				1.5 if (pin and i == 0) else randf_range(0.0, 4.0), -30.0)
			_drift_cloud(cloud, 38.0)

## A stylized puffy cloud: a row of overlapping spheres, bulging in the
## middle, bottoms roughly level — reads as a cloud, not a UFO.
func _make_cloud(s: float, mat: Material) -> Node3D:
	var cloud := Node3D.new()
	var n := randi_range(4, 6)
	var xs: Array[float] = []
	var rs: Array[float] = []
	var x := 0.0
	for i in n:
		var t := float(i) / float(n - 1)
		var bulge := 1.0 - absf(t - 0.5) * 1.3
		var r := (randf_range(0.5, 0.75) * bulge + 0.28) * s
		xs.append(x + r)
		rs.append(r)
		x += r * randf_range(1.5, 1.8)
	var mid := (xs[0] + xs[n - 1]) * 0.5
	for i in n:
		cloud.add_child(_puff(rs[i], mat,
			Vector3(xs[i] - mid, rs[i] * 0.35, randf_range(-0.18, 0.18) * s)))
	# Toppers riding the center break the ball-row silhouette into a mound.
	var crown: float = rs[n / 2] * 0.95
	for i in randi_range(1, 2):
		var tr := randf_range(0.42, 0.6) * s
		cloud.add_child(_puff(tr, mat,
			Vector3(randf_range(-0.55, 0.55) * s, crown + tr * 0.35,
				randf_range(-0.12, 0.12) * s)))
	return cloud

func _puff(r: float, mat: Material, pos: Vector3) -> MeshInstance3D:
	var puff := MeshInstance3D.new()
	var sm := SphereMesh.new()
	sm.radius = r
	sm.height = r * 2.0
	sm.radial_segments = 12
	sm.rings = 6
	puff.mesh = sm
	puff.material_override = mat
	puff.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	puff.layers = 2  # sky life stays off the static map render
	puff.position = pos
	puff.scale.y = 0.82
	return puff

func _drift_cloud(cloud: Node3D, span: float) -> void:
	while is_instance_valid(cloud) and is_inside_tree():
		var speed := randf_range(0.3, 0.65)
		var tw := create_tween()
		tw.tween_property(cloud, "position:x", span,
			(span - cloud.position.x) / speed)
		await tw.finished
		if not is_instance_valid(cloud):
			return
		cloud.position.x = -span

func _bird_loop() -> void:
	while is_inside_tree():
		await get_tree().create_timer(randf_range(30.0, 75.0)).timeout
		if not is_inside_tree():
			return
		var dir := 1.0 if randf() < 0.5 else -1.0
		var y := randf_range(7.5, 11.5)
		var z := randf_range(-16.0, 2.0)
		for i in randi_range(3, 5):
			var bird := Sprite3D.new()
			bird.set_script(BirdScript)
			add_child(bird)
			bird.position = Vector3(-dir * (46.0 + i * randf_range(1.0, 2.4)),
				y + randf_range(-1.0, 1.0), z + randf_range(-1.6, 1.6))
			bird.flip_h = dir < 0.0
			var tw := create_tween()
			tw.tween_property(bird, "position:x", dir * 48.0, randf_range(15.0, 19.0))
			tw.tween_callback(bird.queue_free)

var pollen: GPUParticles3D
var fireflies: GPUParticles3D

## Daytime pollen motes over the meadow; fireflies take the night shift.
func _build_ambient_particles() -> void:
	var soft := StandardMaterial3D.new()
	soft.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	soft.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	soft.vertex_color_use_as_albedo = true
	soft.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	soft.albedo_color = Color(1, 1, 1)

	var ppp := ParticleProcessMaterial.new()
	ppp.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
	ppp.emission_box_extents = Vector3(30.0, 2.2, 20.0)
	ppp.gravity = Vector3(0.35, 0.06, 0.12)
	ppp.scale_min = 0.6
	ppp.scale_max = 1.0
	var ramp := Gradient.new()
	ramp.offsets = PackedFloat32Array([0.0, 0.25, 0.75, 1.0])
	ramp.colors = PackedColorArray([Color(1, 1, 0.85, 0.0), Color(1, 1, 0.85, 0.5),
		Color(1, 1, 0.85, 0.5), Color(1, 1, 0.85, 0.0)])
	var rampt := GradientTexture1D.new()
	rampt.gradient = ramp
	ppp.color_ramp = rampt
	pollen = GPUParticles3D.new()
	pollen.amount = 70
	pollen.lifetime = 10.0
	pollen.preprocess = 10.0
	pollen.process_material = ppp
	var pq := QuadMesh.new()
	pq.size = Vector2(0.045, 0.045)
	pq.material = soft
	pollen.draw_pass_1 = pq
	pollen.position = Vector3(3.0, 2.2, 1.5)
	pollen.layers = 2
	add_child(pollen)

	var fpp := ParticleProcessMaterial.new()
	fpp.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
	fpp.emission_box_extents = Vector3(14.0, 0.9, 10.0)
	fpp.gravity = Vector3.ZERO
	fpp.initial_velocity_min = 0.15
	fpp.initial_velocity_max = 0.5
	fpp.direction = Vector3(0, 0.2, 0)
	fpp.spread = 180.0
	var framp := Gradient.new()
	framp.offsets = PackedFloat32Array([0.0, 0.2, 0.5, 0.8, 1.0])
	framp.colors = PackedColorArray([Color(0.6, 1, 0.4, 0.0), Color(0.6, 1, 0.4, 0.9),
		Color(0.6, 1, 0.4, 0.15), Color(0.6, 1, 0.4, 0.9), Color(0.6, 1, 0.4, 0.0)])
	var frampt := GradientTexture1D.new()
	frampt.gradient = framp
	fpp.color_ramp = frampt
	var glow := StandardMaterial3D.new()
	glow.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	glow.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	glow.vertex_color_use_as_albedo = true
	glow.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	glow.emission_enabled = true
	glow.emission = Color(0.5, 1.0, 0.35)
	glow.emission_energy_multiplier = 2.2
	fireflies = GPUParticles3D.new()
	fireflies.amount = 26
	fireflies.lifetime = 7.0
	fireflies.preprocess = 7.0
	fireflies.process_material = fpp
	var fq := QuadMesh.new()
	fq.size = Vector2(0.06, 0.06)
	fq.material = glow
	fireflies.draw_pass_1 = fq
	fireflies.position = Vector3(-2.0, 1.0, 9.0)  # over the south meadow
	fireflies.layers = 2
	fireflies.emitting = false
	add_child(fireflies)

## Day cycle hands over the shift: pollen by day, fireflies by night.
func set_night_life(night: bool) -> void:
	if pollen:
		pollen.emitting = not night
	if fireflies:
		fireflies.emitting = night
	# Garden lamps wake with the dark — the lawn never goes pitch black.
	for l in _lamp_lights:
		l.visible = night
	for m in _lamp_heads:
		m.emission_energy_multiplier = 2.6 if night else 0.0

## Cozy lamp posts around the building (night dressing for the lawn).
func _build_garden_lamps() -> void:
	var pole_mat := _mat(Color(0.13, 0.14, 0.18), 0.5)
	# Even ring on the lawn, OUTSIDE the office walls (office spans x±15.75,
	# z±12) so a wall never clips a lamp post.
	for pos in [Vector3(-17.6, 0, -8), Vector3(-17.6, 0, 0), Vector3(-17.6, 0, 8),
			Vector3(17.6, 0, -8), Vector3(17.6, 0, 0), Vector3(17.6, 0, 8),
			Vector3(-8, 0, -14.2), Vector3(0, 0, -14.2), Vector3(8, 0, -14.2),
			Vector3(-8, 0, 14.2), Vector3(0, 0, 14.2), Vector3(8, 0, 14.2)]:
		var lamp := Node3D.new()
		add_child(lamp)
		lamp.position = pos
		var pole := CSGCylinder3D.new()
		pole.radius = 0.055
		pole.height = 1.7
		pole.material = pole_mat
		lamp.add_child(pole)
		pole.position = Vector3(0, 0.85, 0)
		var head_mat := StandardMaterial3D.new()
		head_mat.albedo_color = Color(1.0, 0.9, 0.7)
		head_mat.emission_enabled = true
		head_mat.emission = Color(1.0, 0.78, 0.45)
		head_mat.emission_energy_multiplier = 0.0  # day: off
		var head := CSGSphere3D.new()
		head.radius = 0.17
		head.material = head_mat
		lamp.add_child(head)
		head.position = Vector3(0, 1.78, 0)
		_lamp_heads.append(head_mat)
		var l := OmniLight3D.new()
		l.light_color = Color(1.0, 0.78, 0.5)
		l.light_energy = 1.7
		l.omni_range = 5.5
		l.visible = false
		lamp.add_child(l)
		l.position = Vector3(0, 1.9, 0)
		_lamp_lights.append(l)
		_set_layer(lamp, 2)  # decorative night prop — skip the map render

# ---------------------------------------------------------------- clock

var _clock_label: Label3D
var _icon_day: Node3D
var _icon_night: Node3D
var _icon_dusk: Node3D

## Big digital clock on the roofline (next to the brand billboard), with a
## weather/phase icon — tilted at the camera like every readable surface.
func _build_clock() -> void:
	var rig := Node3D.new()
	add_child(rig)
	rig.position = Vector3(8.5, 5.1, -12.1)   # back-wall roofline, right of the billboard
	rig.rotation_degrees.x = -24.0

	var frame := CSGBox3D.new()
	frame.size = Vector3(3.5, 1.2, 0.14)
	frame.material = _mat(Color(0.16, 0.18, 0.22), 0.55)
	rig.add_child(frame)
	var panel := CSGBox3D.new()
	panel.size = Vector3(3.3, 1.0, 0.06)
	panel.material = _mat(Color(0.03, 0.045, 0.08), 0.3)
	panel.position.z = 0.06
	rig.add_child(panel)
	# vertical support posts planted on the back wall (like the billboard), not
	# tilted with the panel
	var cpost_mat := _mat(Color(0.3, 0.31, 0.34), 0.5)
	_box(Vector3(8.5 - 1.3, 4.1, -12.0), Vector3(0.13, 1.7, 0.13), cpost_mat)
	_box(Vector3(8.5 + 1.3, 4.1, -12.0), Vector3(0.13, 1.7, 0.13), cpost_mat)

	_clock_label = Label3D.new()
	_clock_label.text = "--:--"
	_clock_label.font_size = 150
	_clock_label.outline_size = 24
	_clock_label.modulate = Color(0.55, 1.0, 0.95)
	_clock_label.outline_modulate = Color(0, 0, 0, 0.85)
	_clock_label.position = Vector3(-0.42, 0.0, 0.12)
	rig.add_child(_clock_label)

	# phase icons live to the right of the digits
	var icon_root := Node3D.new()
	icon_root.position = Vector3(1.18, 0.0, 0.14)
	rig.add_child(icon_root)

	_icon_day = Node3D.new()
	var sun := MeshInstance3D.new()
	var sun_m := SphereMesh.new()
	sun_m.radius = 0.17
	sun_m.height = 0.34
	sun.mesh = sun_m
	sun.material_override = _mat(Color(1.0, 0.85, 0.3), 0.6, Color(1.0, 0.8, 0.25), 2.2)
	_icon_day.add_child(sun)
	for i in 8:
		var ray := CSGBox3D.new()
		ray.size = Vector3(0.1, 0.035, 0.03)
		ray.material = sun.material_override
		var ang := TAU * i / 8.0
		ray.position = Vector3(cos(ang) * 0.28, sin(ang) * 0.28, 0)
		ray.rotation.z = ang
		_icon_day.add_child(ray)
	icon_root.add_child(_icon_day)

	_icon_night = Node3D.new()
	var moon := MeshInstance3D.new()
	moon.mesh = sun_m
	moon.material_override = _mat(Color(0.85, 0.9, 1.0), 0.6, Color(0.7, 0.8, 1.0), 1.4)
	_icon_night.add_child(moon)
	var bite := MeshInstance3D.new()
	var bite_m := SphereMesh.new()
	bite_m.radius = 0.14
	bite_m.height = 0.28
	bite.mesh = bite_m
	bite.material_override = _mat(Color(0.03, 0.045, 0.08), 0.3)
	bite.position = Vector3(0.09, 0.06, 0.05)
	_icon_night.add_child(bite)
	icon_root.add_child(_icon_night)

	_icon_dusk = Node3D.new()
	var low_sun := MeshInstance3D.new()
	low_sun.mesh = sun_m
	low_sun.material_override = _mat(Color(1.0, 0.55, 0.25), 0.6, Color(1.0, 0.45, 0.15), 2.0)
	low_sun.position.y = -0.07
	_icon_dusk.add_child(low_sun)
	var horizon := CSGBox3D.new()
	horizon.size = Vector3(0.55, 0.16, 0.08)
	horizon.material = _mat(Color(0.03, 0.045, 0.08), 0.3)
	horizon.position = Vector3(0, -0.18, 0.06)
	_icon_dusk.add_child(horizon)
	icon_root.add_child(_icon_dusk)

	update_clock("--:--", "day")

func update_clock(text: String, phase: String) -> void:
	if _clock_label:
		_clock_label.text = text
	if _icon_day:
		_icon_day.visible = phase == "day"
	if _icon_night:
		_icon_night.visible = phase == "night"
	if _icon_dusk:
		_icon_dusk.visible = phase in ["dawn", "dusk"]

# ---------------------------------------------------------------- graph

func _build_graph() -> void:
	var next_id := 0
	for name in WP:
		_wp_ids[name] = next_id
		astar.add_point(next_id, WP[name])
		next_id += 1
	for e in EDGES:
		astar.connect_points(_wp_ids[e[0]], _wp_ids[e[1]])

## Nearest graph point — uses A* point positions (the grid graph carries hub/
## door nodes that aren't in WP, so we can't index WP by name here).
func _nearest(pos: Vector3) -> int:
	if _grid: return _grid._nearest(pos)
	var best := -1
	var best_d := INF
	for name in _wp_ids:
		var d: float = pos.distance_to(astar.get_point_position(_wp_ids[name]))
		if d < best_d:
			best_d = d
			best = _wp_ids[name]
	return best

func path_to(from_pos: Vector3, target: String) -> Array:
	if _grid: return _grid.path_to(from_pos, target)
	var pts := astar.get_point_path(_nearest(from_pos), _wp_ids[target])
	var out: Array = []
	for p in pts:
		out.append(p)
	if out.size() > 1 and from_pos.distance_to(out[0]) < 0.4:
		out.pop_front()
	return out

## Graph walk between two free positions (nearest waypoints both ends) —
## ghosts route home to wherever their owner currently stands.
func path_between(from_pos: Vector3, to_pos: Vector3) -> Array:
	if _grid: return _grid.path_between(from_pos, to_pos)
	var pts := astar.get_point_path(_nearest(from_pos), _nearest(to_pos))
	var out: Array = []
	for p in pts:
		out.append(p)
	if out.size() > 1 and from_pos.distance_to(out[0]) < 0.4:
		out.pop_front()
	out.append(to_pos)
	return out

## TV truth: glowing picture while someone watches; a genuinely DARK matte
## panel when off (the kit monitor's own screen material is baked emissive —
## it must be physically covered to read as "off").
func tv_set(on: bool) -> void:
	if _tv_glow:
		_tv_glow.visible = on
	if _tv_dark:
		_tv_dark.visible = not on

func _build_tv_glow() -> void:
	_tv_glow = Node3D.new()
	add_child(_tv_glow)
	# The rec TV (Large_Monitor_White) sits at x -9.45 facing east.
	var quad := MeshInstance3D.new()
	var qm := QuadMesh.new()
	qm.size = Vector2(0.96, 0.6)
	quad.mesh = qm
	quad.material_override = _mat(Color(0.6, 0.8, 1.0), 0.4, Color(0.55, 0.8, 1.0), 2.4)
	quad.rotation_degrees = Vector3(0, 90, 0)
	_tv_glow.add_child(quad)
	quad.position = Vector3(-9.18, 1.06, 8.4)
	var l := OmniLight3D.new()
	l.light_color = Color(0.6, 0.82, 1.0)
	l.light_energy = 1.6
	l.omni_range = 3.2
	_tv_glow.add_child(l)
	l.position = Vector3(-8.6, 1.2, 8.4)
	_tv_glow.visible = false
	# The OFF panel: near-black, barely reflective — clearly powered down.
	_tv_dark = MeshInstance3D.new()
	var dm := QuadMesh.new()
	dm.size = Vector2(0.98, 0.62)
	_tv_dark.mesh = dm
	_tv_dark.material_override = _mat(Color(0.045, 0.05, 0.065), 0.25)
	_tv_dark.rotation_degrees = Vector3(0, 90, 0)
	add_child(_tv_dark)
	_tv_dark.position = Vector3(-9.18, 1.06, 8.4)
	_tv_dark.visible = true

## Classic black-patch football texture (equirect-wrapped on the CSG sphere).
func _soccer_texture() -> ImageTexture:
	var img := Image.create(128, 64, false, Image.FORMAT_RGBA8)
	img.fill(Color(0.96, 0.96, 0.97))
	var spots := [Vector2(0, 32), Vector2(43, 14), Vector2(43, 50),
		Vector2(85, 14), Vector2(85, 50), Vector2(64, 32), Vector2(21, 32), Vector2(107, 32)]
	for s in spots:
		for dx in range(-8, 9):
			for dy in range(-7, 8):
				if Vector2(dx, dy).length() > 6.5:
					continue
				var py := int(s.y) + dy
				if py < 2 or py > 61:
					continue
				img.set_pixel((int(s.x) + dx + 128) % 128, py, Color(0.07, 0.07, 0.09))
	return ImageTexture.create_from_image(img)

func set_totem(connected: bool) -> void:
	if totem_mat:
		totem_mat.emission = Color(0.3, 1.0, 0.5) if connected else Color(1.0, 0.25, 0.2)

## Meeting-room whiteboard: forwarded to the crisp 2D HUD layer.
func whiteboard_reset(header: String) -> void:
	var hud := get_node_or_null("../Hud")
	if hud:
		hud.wb_reset(header)

func whiteboard_add(who: String, text: String) -> void:
	var hud := get_node_or_null("../Hud")
	if hud:
		hud.wb_add(text if who == "" else who + ": " + text)

# ---------------------------------------------------------------- board

func board_set(key: String, state: String, label := "") -> void:
	if state == "none":
		if _board_slots.has(key):
			_board_free.append(_board_slots[key].idx)
			_board_free.sort()
			_board_slots[key].box.queue_free()
			_board_slots.erase(key)
		return
	if not _board_slots.has(key):
		if _board_free.is_empty():
			return
		var idx: int = _board_free.pop_front()
		var box := CSGBox3D.new()
		box.size = Vector3(0.5, 0.26, 0.04)
		add_child(box)
		box.position = Vector3(_board_x + ((idx % 3) - 1) * 0.6, _board_y0 - float(idx / 3) * 0.4, _board_z)
		var lbl := Label3D.new()
		lbl.text = label if label != "" else key
		lbl.font_size = 40
		lbl.outline_size = 10
		lbl.pixel_size = 0.0032
		box.add_child(lbl)
		lbl.position = Vector3(0, 0, 0.05)
		_board_slots[key] = {"box": box, "idx": idx, "state": ""}
	var slot: Dictionary = _board_slots[key]
	slot.state = state
	var c: Color = BOARD_COLORS.get(state, Color(0.5, 0.5, 0.5))
	slot.box.material = _mat(c.darkened(0.65), 0.4, c, 1.8)

func board_clear_if_finished(key: String) -> void:
	if _board_slots.has(key) and _board_slots[key].state in ["done", "failed"]:
		board_set(key, "none")

# ---------------------------------------------------------------- helpers

func _mat(albedo: Color, rough := 0.85, emis := Color.BLACK, energy := 0.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = albedo
	m.roughness = rough
	if energy > 0.0:
		m.emission_enabled = true
		m.emission = emis
		m.emission_energy_multiplier = energy
	return m

func _box(pos: Vector3, size: Vector3, mat: Material, shadow := 1) -> CSGBox3D:
	var b := CSGBox3D.new()
	b.size = size
	b.material = mat
	b.cast_shadow = shadow
	add_child(b)
	b.position = pos
	return b

func _cyl(pos: Vector3, radius: float, height: float, mat: Material) -> CSGCylinder3D:
	var c := CSGCylinder3D.new()
	c.radius = radius
	c.height = height
	c.material = mat
	add_child(c)
	c.position = pos
	return c

func _omni(pos: Vector3, color: Color, energy: float, range_m: float) -> OmniLight3D:
	var l := OmniLight3D.new()
	l.light_color = color
	l.light_energy = energy
	l.omni_range = range_m
	l.light_volumetric_fog_energy = 0.2
	add_child(l)
	l.position = pos
	return l

func _label(text: String, pos: Vector3, size: int, color: Color, energy := 1.0) -> Label3D:
	var l := Label3D.new()
	l.text = text
	l.font_size = size
	l.outline_size = size / 5
	l.pixel_size = 0.004
	l.modulate = Color(color.r * energy, color.g * energy, color.b * energy)
	add_child(l)
	l.position = pos
	return l

## Zone rug with a darker border frame.
func _rug(pos: Vector3, size: Vector3, color: Color) -> void:
	_box(Vector3(pos.x, 0.008, pos.z), Vector3(size.x + 0.35, 0.016, size.z + 0.35),
		_mat(color.darkened(0.45)))
	_box(Vector3(pos.x, 0.018, pos.z), Vector3(size.x, 0.022, size.z), _mat(color))

## Glass office partition: solid base + glass pane + light cap rail.
func _partition(pos: Vector3, size: Vector3, glass: Material, base_mat: Material, cap_mat: Material) -> void:
	var along_x := size.x > size.z
	_box(Vector3(pos.x, 0.25, pos.z), Vector3(size.x, 0.5, size.z), base_mat)
	var g := _box(Vector3(pos.x, 0.85, pos.z),
		Vector3(size.x - (0.0 if along_x else 0.08), 0.7, size.z - (0.08 if along_x else 0.0)), glass, 0)
	g.cast_shadow = 0
	_box(Vector3(pos.x, 1.23, pos.z),
		Vector3(size.x + (0.05 if along_x else 0.1), 0.06, size.z + (0.1 if along_x else 0.05)), cap_mat)

func _pendant(pos: Vector3, warm: Color) -> void:
	_box(Vector3(pos.x, 3.3, pos.z), Vector3(0.04, 0.8, 0.04), _mat(Color(0.1, 0.1, 0.12)))
	var shade := CSGCylinder3D.new()
	shade.radius = 0.26
	shade.height = 0.18
	shade.cone = false
	shade.material = _mat(Color(0.12, 0.12, 0.15), 0.4)
	add_child(shade)
	shade.position = Vector3(pos.x, 2.85, pos.z)
	_box(Vector3(pos.x, 2.74, pos.z), Vector3(0.12, 0.06, 0.12), _mat(Color(1, 0.85, 0.6), 0.3, warm, 2.5))

func _bookshelf(pos: Vector3) -> void:
	# Back board against the west wall, 3 shelves, random book spines.
	_box(pos + Vector3(0, 1.1, 0), Vector3(0.1, 2.2, 1.7), _mat(Color(0.16, 0.11, 0.08)))
	var spine_rng := RandomNumberGenerator.new()
	spine_rng.seed = 7
	for row in 3:
		var sy: float = 0.5 + row * 0.62
		_box(pos + Vector3(0.14, sy - 0.26, 0), Vector3(0.34, 0.05, 1.7), _mat(Color(0.22, 0.15, 0.1)))
		var bx := -0.72
		while bx < 0.7:
			var bw := spine_rng.randf_range(0.07, 0.13)
			var bh := spine_rng.randf_range(0.3, 0.44)
			var hue := spine_rng.randf()
			_box(pos + Vector3(0.14, sy - 0.24 + bh / 2.0, bx + bw / 2.0),
				Vector3(0.26, bh, bw), _mat(Color.from_hsv(hue, 0.45, 0.5)))
			bx += bw + 0.025

# ---------------------------------------------------------------- geometry

func _build_geometry() -> void:
	# ── Data-driven swappable room grid (replaces the hand-built floor) ──────
	# sky + countryside kept from the original art
	sky_mat = _mat(Color(0.55, 0.75, 1.0), 1.0, Color(0.55, 0.72, 1.0), 1.6)
	sky_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_box(Vector3(0, 7, -34.0), Vector3(110, 30, 0.1), sky_mat, 0)
	_build_countryside()
	# the grid owns rooms, furniture, agent anchors and the A* graph
	_grid = GRID_SCRIPT.new()
	add_child(_grid)
	# share its navigation so path_to / path_between / set_anchor work unchanged
	astar = _grid.astar
	_wp_ids = _grid._wp_ids
	WP = _grid.WP
	# brand billboard centred on the back-wall roofline, facing the camera
	_billboard(Vector3(-3.5, 5.2, -12.1), -24.0)
	# mission-control board on the OPS slot's north wall
	_board_x = 0.0; _board_z = -11.6; _board_y0 = 1.7
	var mctl := _label("MISSION CONTROL", Vector3(0.0, 2.2, -11.7), 44, Color(0.6, 0.85, 1.0))
	mctl.pixel_size = 0.0035
	# recreation life: office cat (or fallback dog) + football, in the rec slot
	var _catg := load("res://scripts/cat_sprite.gd")
	pet = Sprite3D.new()
	if _catg.has_assets():
		pet.set_script(_catg); pet.position = Vector3(-8, 0.14, 8)
	else:
		pet.set_script(load("res://scripts/dog_sprite.gd")); pet.position = Vector3(-8, 0.27, 8)
	add_child(pet)
	ball = CSGSphere3D.new(); ball.radius = 0.2
	var _ballg := StandardMaterial3D.new()
	_ballg.albedo_texture = _soccer_texture(); _ballg.roughness = 0.35
	ball.material = _ballg; ball.set_script(load("res://scripts/rec_ball.gd"))
	add_child(ball); ball.position = Vector3(-7, 0.2, 8)
	_build_tv_glow()
	return
	# ── legacy hand-built floor below — unreachable, kept for reference ──────
	var wall := _mat(Color(0.18, 0.18, 0.25), 0.9)
	var wood := _mat(Color(0.26, 0.18, 0.12), 0.5)
	var dark_wood := _mat(Color(0.15, 0.1, 0.07), 0.45)
	var amber := _mat(Color(0.2, 0.14, 0.08), 0.5, Color(1.0, 0.62, 0.25), 1.6)
	var glass := _mat(Color(0.7, 0.85, 1.0, 0.16), 0.08)
	glass.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	glass.metallic = 0.2
	var cap := _mat(Color(0.55, 0.56, 0.6), 0.35)
	cap.metallic = 0.6
	var screen := ShaderMaterial.new()
	screen.shader = SCREEN_SHADER
	var planks := ShaderMaterial.new()
	planks.shader = FLOOR_SHADER
	planks.set_shader_parameter("col_a", Vector3(0.31, 0.235, 0.165))
	planks.set_shader_parameter("col_b", Vector3(0.27, 0.2, 0.14))

	var kit := _kit_available()

	# ---- Architecture: kit shell (walls/partitions/floors) or CSG fallback
	if kit:
		_box(Vector3(3, -0.1, 1.5), Vector3(26.6, 0.2, 23.6), _mat(Color(0.12, 0.13, 0.16), 0.5))
		_kit_architecture()
	else:
		_box(Vector3(3, -0.1, 1.5), Vector3(26.6, 0.2, 23.6), planks)
		# Minimal CSG shell for the east wing (kit does it properly)
		_box(Vector3(16.15, 1.75, -2), Vector3(0.3, 3.5, 16.3), wall)
		_box(Vector3(10, 1.75, -9.4), Vector3(0.3, 3.5, 1.2), wall)
		_box(Vector3(10, 1.75, -4), Vector3(0.3, 3.5, 6.4), wall)
		_box(Vector3(10, 1.75, 3.4), Vector3(0.3, 3.5, 5.2), wall)
		_rug(Vector3(13, 0, -6.5), Vector3(4.6, 0, 5.6), Color(0.12, 0.22, 0.18))
		_rug(Vector3(13, 0, -0.5), Vector3(4.6, 0, 3.6), Color(0.2, 0.16, 0.26))
		_rug(Vector3(13, 0, 4), Vector3(4.6, 0, 2.6), Color(0.16, 0.17, 0.26))
		_rug(Vector3(-6, 0, -6.5), Vector3(6.6, 0, 5.6), Color(0.3, 0.22, 0.12))
		_rug(Vector3(4, 0, -6.5), Vector3(10.6, 0, 5.6), Color(0.14, 0.18, 0.28))
		_rug(Vector3(7, 0, 1.5), Vector3(4.6, 0, 7.6), Color(0.3, 0.18, 0.1))
		_rug(Vector3(-8, 0, -0.5), Vector3(2.8, 0, 3.8), Color(0.26, 0.18, 0.08))
		# North wall with 4 framed windows (y 1.0..2.8)
		_box(Vector3(0, 0.5, -10.15), Vector3(20.6, 1.0, 0.3), wall)
		_box(Vector3(0, 3.15, -10.15), Vector3(20.6, 0.7, 0.3), wall)
		for p in [[-9.275, 2.05], [-4.75, 2.0], [0.0, 2.5], [4.75, 2.0], [9.275, 2.05]]:
			_box(Vector3(p[0], 1.9, -10.15), Vector3(p[1], 1.8, 0.3), wall)
		for wx in [-7.0, -2.5, 2.5, 7.0]:
			_box(Vector3(wx, 1.0, -10.02), Vector3(2.5, 0.12, 0.1), dark_wood)
			_box(Vector3(wx, 2.8, -10.02), Vector3(2.5, 0.12, 0.1), dark_wood)
			_box(Vector3(wx - 1.25, 1.9, -10.02), Vector3(0.12, 1.8, 0.1), dark_wood)
			_box(Vector3(wx + 1.25, 1.9, -10.02), Vector3(0.12, 1.8, 0.1), dark_wood)
			_box(Vector3(wx, 1.9, -10.06), Vector3(0.06, 1.8, 0.06), dark_wood)
		_box(Vector3(-10.15, 1.75, -2), Vector3(0.3, 3.5, 16.3), wall)
		_box(Vector3(10.15, 1.75, -2), Vector3(0.3, 3.5, 16.3), wall)
		_box(Vector3(0, 0.09, -9.97), Vector3(20.0, 0.18, 0.05), dark_wood)
		_box(Vector3(-9.97, 0.09, -2), Vector3(0.05, 0.18, 16.0), dark_wood)
		_box(Vector3(9.97, 0.09, -2), Vector3(0.05, 0.18, 16.0), dark_wood)
		# Inner glass partitions
		for s in [[-7.4, 5.2], [-1.5, 3.4], [3.5, 3.4], [8.4, 3.2]]:
			_partition(Vector3(s[0], 0, -3), Vector3(s[1], 0, 0.22), glass, wall, cap)
		for s in [[-8.65, 2.7], [-4.35, 2.7]]:
			_partition(Vector3(-2, 0, s[0]), Vector3(0.22, 0, s[1]), glass, wall, cap)
		for s in [[-2.15, 1.7], [1.15, 1.7]]:
			_partition(Vector3(-6, 0, s[0]), Vector3(0.22, 0, s[1]), glass, wall, cap)
		_partition(Vector3(-8, 0, 2), Vector3(4.3, 0, 0.22), glass, wall, cap)
		for s in [[-1.4, 3.2], [3.9, 4.2]]:
			_partition(Vector3(4, 0, s[0]), Vector3(0.22, 0, s[1]), glass, wall, cap)

	# ---- Sky + countryside (grass field, mountains, trees) + shadow ceiling
	sky_mat = _mat(Color(0.55, 0.75, 1.0), 1.0, Color(0.55, 0.72, 1.0), 1.6)
	sky_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_box(Vector3(3, 7, -34.0), Vector3(110, 30, 0.1), sky_mat, 0)
	_build_countryside()
	_box(Vector3(3, 3.7, 1.5), Vector3(26.6, 0.2, 23.6), wall, 3)

	# ---- Executive Office
	if kit:
		_kit("Command_Console", Vector3(-6, 0, -8.4), 0.0, 0.5)   # the CEO's command station
		_kit("Orrery", Vector3(-8.6, 0, -4.2), 0.0, 0.35)
		_kit("Large_Monitor_Blue", Vector3(-8.06, 0, -9.55), 0.0, 0.5)
		# The Director's own lead workstation, east side of the executive floor.
		_box(Vector3(-3.2, 0.62, -8.75), Vector3(1.5, 0.08, 0.75),
			_mat(Color(0.16, 0.19, 0.27), 0.45))
		_box(Vector3(-3.8, 0.3, -8.75), Vector3(0.12, 0.6, 0.6), _mat(Color(0.1, 0.12, 0.18)))
		_box(Vector3(-2.6, 0.3, -8.75), Vector3(0.12, 0.6, 0.6), _mat(Color(0.1, 0.12, 0.18)))
		_kit("Large_Monitor_Blue", Vector3(-3.2, 0.66, -8.85), 0.0, 0.3)
		_kit("Chair_1", Vector3(-3.2, 0, -7.85), 180.0, 0.6)
		_kit("Plant_1", Vector3(-2.25, 0, -9.3), 40.0, 1.4)
	else:
		_box(Vector3(-6, 0.42, -8.3), Vector3(2.6, 0.84, 1.1), dark_wood)
		_box(Vector3(-6, 0.88, -8.3), Vector3(2.9, 0.08, 1.3), wood)
		_box(Vector3(-7.6, 0.42, -7.7), Vector3(0.7, 0.84, 2.3), dark_wood)    # L-return
		_box(Vector3(-7.6, 0.88, -7.7), Vector3(0.85, 0.08, 2.5), wood)
		var sC := _box(Vector3(-6, 1.95, -9.55), Vector3(1.6, 0.85, 0.05), screen)
		var sL := _box(Vector3(-7.45, 1.85, -9.35), Vector3(1.0, 0.65, 0.05), screen)
		var sR := _box(Vector3(-4.55, 1.85, -9.35), Vector3(1.0, 0.65, 0.05), screen)
		sL.rotation_degrees.y = 18
		sR.rotation_degrees.y = -18
	# World-map panel on the window pillar (teal scan shader)
	var map_mat := ShaderMaterial.new()
	map_mat.shader = SCREEN_SHADER
	map_mat.set_shader_parameter("glow_col", Vector3(0.25, 0.9, 0.7))
	map_mat.set_shader_parameter("rows", 14.0)
	map_mat.set_shader_parameter("speed", 0.25)
	_box(Vector3(-4.75, 2.0, -9.96), Vector3(1.7, 1.15, 0.05), map_mat)
	_bookshelf(Vector3(-9.75, 0, -6.2))
	_omni(Vector3(-6, 1.7, -8.6), Color(0.6, 0.85, 1.0), 1.8, 4.5)
	_omni(Vector3(-6, 2.5, -5.2), Color(1.0, 0.8, 0.6), 1.4, 7.0)

	# ---- Ops Floor: 6 desk pods (east column faces the other way)
	# Every node is tracked in _ops_nodes so the editor can hide them when a
	# custom layout supplies its own workstations.
	if kit:
		_ops_nodes.append(_box(Vector3(8, 0.4, -8), Vector3(1.6, 0.8, 0.8), dark_wood))
		_ops_nodes.append(_kit("Large_Monitor_Blue", Vector3(8, 0.8, -8.15), 180.0, 0.26))
		_ops_nodes.append(_kit("Chair_1", Vector3(8, 0, -7.1), 0.0, 0.6))
		_ops_nodes.append(_box(Vector3(8, 0.4, -5.5), Vector3(1.6, 0.8, 0.8), dark_wood))
		_ops_nodes.append(_kit("Large_Monitor_Blue", Vector3(8, 0.8, -5.4), 0.0, 0.26))
		_ops_nodes.append(_kit("Chair_1", Vector3(8, 0, -6.4), 180.0, 0.6))
	for d in [Vector3(1, 0, -8), Vector3(5, 0, -8), Vector3(1, 0, -5.5), Vector3(5, 0, -5.5)]:
		if kit:
			_ops_nodes.append(_box(Vector3(d.x, 0.4, d.z), Vector3(1.6, 0.8, 0.8), dark_wood))
			_ops_nodes.append(_kit("Large_Monitor_Blue", Vector3(d.x, 0.8, d.z + 0.1), 0.0, 0.26))
			_ops_nodes.append(_kit("Chair_1", Vector3(d.x, 0, d.z - 0.95), 180.0, 0.6))
		else:
			_ops_nodes.append(_box(Vector3(d.x, 0.4, d.z), Vector3(1.6, 0.8, 0.8), wood))
			_ops_nodes.append(_box(Vector3(d.x, 0.86, d.z + 0.08), Vector3(0.08, 0.16, 0.08), cap))
			_ops_nodes.append(_box(Vector3(d.x, 1.05, d.z + 0.08), Vector3(0.74, 0.46, 0.05), screen))
			_ops_nodes.append(_box(Vector3(d.x, 0.83, d.z - 0.22), Vector3(0.5, 0.03, 0.18), _mat(Color(0.1, 0.1, 0.12), 0.4)))
	_pendant(Vector3(3, 0, -8), Color(0.8, 0.88, 1.0))
	_pendant(Vector3(3, 0, -5.5), Color(0.8, 0.88, 1.0))
	_omni(Vector3(3, 2.8, -6.5), Color(0.7, 0.8, 1.0), 1.8, 11.0)

	# ---- Mission Control board (solid north segment, clear of the glass bays)
	if kit:
		_kit("Briefing_Screen_Blue", Vector3(9.0, 0, -9.45), 0.0, 0.6)
		_board_x = 9.0
		_board_z = -9.0
		_board_y0 = 1.5
		var title := _label("MISSION CONTROL", Vector3(9.0, 2.15, -9.0), 44, Color(0.6, 0.85, 1.0))
		title.pixel_size = 0.0035
	else:
		_box(Vector3(4.75, 2.05, -9.96), Vector3(1.9, 1.3, 0.05), _mat(Color(0.08, 0.09, 0.12), 0.3))
		var title := _label("MISSION CONTROL", Vector3(4.75, 2.56, -9.9), 44, Color(0.6, 0.85, 1.0))
		title.pixel_size = 0.0035

	# ---- Lobby: totem, floor logo, reception, doorway, armchair
	totem_mat = _mat(Color(0.15, 0.2, 0.25), 0.3, Color(1.0, 0.25, 0.2), 2.2)
	_cyl(Vector3(-2.6, 0.06, 3), 0.55, 0.12, cap)
	_cyl(Vector3(-2.6, 1.26, 3), 0.35, 2.4, totem_mat)
	# Brand: the rooftop billboard is the one and only company sign.
	_billboard(Vector3(3, 4.45, -9.8), -42.0)
	_box(Vector3(-4.2, 0.5, 3.8), Vector3(1.8, 1.0, 0.7), dark_wood)           # reception
	_box(Vector3(-4.2, 1.02, 3.8), Vector3(2.0, 0.06, 0.85), wood)
	_box(Vector3(-4.5, 1.25, 3.8), Vector3(0.4, 0.3, 0.04), screen)
	if kit:
		_kit("End_Table", Vector3(-3.55, 0, 2.1), 0.0, 0.8)                    # chess corner
		_kit("3D_Chess_Board", Vector3(-3.55, 0.75, 2.1), 25.0, 0.35)
		_stanchion(Vector3(-4.5, 0, 4.6), 35.0)
	for px in [-1.9, -0.1]:
		_box(Vector3(px, 1.2, 5.6), Vector3(0.2, 2.4, 0.2), dark_wood)
	_box(Vector3(-1, 2.5, 5.6), Vector3(2.0, 0.2, 0.2), dark_wood)
	_box(Vector3(-1, 0.015, 4.9), Vector3(1.7, 0.03, 0.8), _mat(Color(0.32, 0.1, 0.1)))  # mat
	_box(Vector3(-3.6, 0.3, 1.0), Vector3(0.8, 0.6, 0.8), _mat(Color(0.2, 0.26, 0.34)))  # armchair
	_box(Vector3(-3.95, 0.7, 1.0), Vector3(0.18, 0.9, 0.8), _mat(Color(0.2, 0.26, 0.34)))
	_omni(Vector3(-1, 2.6, 2), Color(1.0, 0.78, 0.55), 2.2, 11.0)

	# ---- Cafeteria (counter shifted off the new meeting-room doorway path)
	_box(Vector3(9.2, 0.5, -1.7), Vector3(0.9, 1.0, 2.2), dark_wood)
	_box(Vector3(9.2, 1.02, -1.7), Vector3(1.05, 0.06, 2.4), wood)
	_box(Vector3(9.1, 1.32, -2.2), Vector3(0.4, 0.55, 0.4), _mat(Color(0.1, 0.1, 0.12), 0.35))
	_box(Vector3(8.95, 1.35, -2.0), Vector3(0.06, 0.1, 0.1), amber)            # machine light
	_box(Vector3(9.6, 2.1, -1.5), Vector3(0.05, 0.9, 1.6), amber)              # menu board
	for tp in [Vector3(6.5, 0, 1.5), Vector3(8.2, 0, 3.5)]:
		if kit:
			_kit("Cafeteria_Table", tp, 0.0, 0.8)
			_kit("Chair_1", tp + Vector3(0.95, 0, 0.55), -120.0, 0.6)
			_kit("Chair_1", tp + Vector3(-0.95, 0, -0.55), 60.0, 0.6)
			_kit("Space_Ketchup", tp + Vector3(0.15, 0.62, -0.1), 0.0, 0.8)
			_kit("Space_Mayo_Naise", tp + Vector3(-0.12, 0.62, 0.12), 0.0, 0.8)
		else:
			_cyl(Vector3(tp.x, 0.4, tp.z), 0.12, 0.8, cap)
			_cyl(Vector3(tp.x, 0.82, tp.z), 0.62, 0.06, wood)
			_cyl(Vector3(tp.x + 0.25, 0.9, tp.z - 0.2), 0.05, 0.09, _mat(Color(0.9, 0.88, 0.85), 0.4))
			_cyl(Vector3(tp.x - 0.2, 0.9, tp.z + 0.15), 0.05, 0.09, _mat(Color(0.85, 0.3, 0.25), 0.4))
			_cyl(Vector3(tp.x + 0.55, 0.22, tp.z + 0.55), 0.16, 0.44, dark_wood)
			_cyl(Vector3(tp.x - 0.55, 0.22, tp.z - 0.55), 0.16, 0.44, dark_wood)
	if kit:
		_kit("Lava_Lamp", Vector3(9.15, 1.05, -0.9), 0.0, 1.0)
	_pendant(Vector3(6.5, 0, 1.5), Color(1.0, 0.72, 0.45))
	_pendant(Vector3(8.2, 0, 3.5), Color(1.0, 0.72, 0.45))
	_omni(Vector3(7, 2.4, 1), Color(1.0, 0.7, 0.45), 2.2, 10.0)
	# ---- Server Room (infra made physical)
	if kit:
		_kit("Generator", Vector3(13.4, 0, -7.5), 25.0, 0.55)
		_kit("Generator_Pile_Chonky", Vector3(11.2, 0, -8.6), 0.0, 0.45)
		_kit("Generator_Pile_Small", Vector3(15.3, 0, -8.8), 0.0, 0.5)
		_kit("Battery_Green", Vector3(15.4, 0, -5.0), 90.0, 0.8)
		_kit("Battery_Blue", Vector3(15.4, 0, -4.2), 90.0, 0.8)
		_kit_scaled("Wall_Display_Green", Vector3(14.34, 0.35, -9.72), 0.0, Vector3.ONE * 0.875)
		var hz := _kit_scaled("Hazard_Floor_1", Vector3(13.2, 0.02, -7.2), 0.0, Vector3(0.9, 1.0, 0.9))
		if hz:
			pass
	_omni(Vector3(13, 2.5, -6.5), Color(0.5, 1.0, 0.7), 1.6, 7.0)

	# ---- Meeting Room (A2A collaboration stage)
	if kit:
		_kit("Octo_Table", Vector3(13, 0, -0.45), 0.0, 0.45)
		_kit("Chair_1", Vector3(11.8, 0, -1.35), 135.0, 0.6)
		_kit("Chair_1", Vector3(14.2, 0, -1.35), -135.0, 0.6)
		_kit("Chair_1", Vector3(11.8, 0, 0.45), 45.0, 0.6)
		_kit("Chair_1", Vector3(14.2, 0, 0.45), -45.0, 0.6)
		_kit("Briefing_Screen_Purple", Vector3(15.5, 0, -0.5), -90.0, 0.5)
	_omni(Vector3(13, 2.5, -0.5), Color(0.85, 0.8, 1.0), 1.6, 6.0)

	# ---- Quiet pods (the original 2-bed dorm)
	if kit:
		_kit("Bunk_Single_Blue", Vector3(11.5, 0, 5.1), 0.0, 0.7)
		_kit("Bunk_Single_Red", Vector3(14.5, 0, 5.1), 0.0, 0.7)
		_kit("Cryo_Tube_ON", Vector3(15.6, 0, 2.9), 0.0, 0.45)
		_kit("Plant_1", Vector3(10.7, 0, 2.6), 120.0, 1.7)
	_omni(Vector3(13, 2.2, 4.2), Color(1.0, 0.75, 0.5), 1.1, 5.0)

	# ---- Recreation Room: TV corner, game table, garden, dog and ball
	if kit:
		_kit("Large_Monitor_White", Vector3(-9.45, 0, 8.4), 90.0, 0.5)        # the TV
		_kit("Chair_1", Vector3(-7.6, 0, 7.9), 90.0, 0.6)
		_kit("Chair_1", Vector3(-7.6, 0, 8.9), 90.0, 0.6)
		_kit("End_Table", Vector3(-7.6, 0, 6.9), 0.0, 0.8)
		_kit("Lava_Lamp", Vector3(-7.6, 0.75, 6.9), 0.0, 1.0)
		_kit("Cafeteria_Table", Vector3(-3.5, 0, 7.6), 90.0, 0.8)            # game table
		_kit("3D_Chess_Board", Vector3(-3.5, 0.62, 7.6), 15.0, 0.35)
		_kit("Chair_1", Vector3(-2.5, 0, 7.6), -90.0, 0.6)
		_kit("Hydroponics_Full", Vector3(-8.6, 0, 11.6), 0.0, 0.85)          # garden
		_kit("Hydroponics_Full", Vector3(-6.9, 0, 12.2), 25.0, 0.85)
		_kit("Hydroponics_Lamp", Vector3(-7.8, 0, 11.9), 0.0, 0.85)
		_kit("Plant_1", Vector3(-9.3, 0, 6.7), 60.0, 1.7)
		_stanchion(Vector3(0.5, 0, 12.4), -20.0)
	# Rec life: the office cat (xzany pack; procedural dog when missing) and
	# a properly dressed football.
	var cat_script := load("res://scripts/cat_sprite.gd")
	pet = Sprite3D.new()
	if cat_script.has_assets():
		pet.set_script(cat_script)
		pet.position = Vector3(-5.0, 0.14, 10.4)
	else:
		pet.set_script(load("res://scripts/dog_sprite.gd"))
		pet.position = Vector3(-5.0, 0.27, 10.4)
	add_child(pet)
	ball = CSGSphere3D.new()
	ball.radius = 0.2
	var ball_mat := StandardMaterial3D.new()
	ball_mat.albedo_texture = _soccer_texture()
	ball_mat.roughness = 0.35
	ball.material = ball_mat
	ball.set_script(load("res://scripts/rec_ball.gd"))
	add_child(ball)
	ball.position = Vector3(-1.8, 0.2, 10.4)
	_build_tv_glow()
	# The lawn dog (Pet Dogs Pack) — lives outside, keeps the office tidy.
	var dog_script := load("res://scripts/pack_dog_sprite.gd")
	if dog_script.has_assets():
		var lawn_dog := Sprite3D.new()
		lawn_dog.set_script(dog_script)
		add_child(lawn_dog)
		lawn_dog.position = Vector3(2.0, 0.05, 16.5)
	_omni(Vector3(-3.5, 2.6, 9.5), Color(1.0, 0.85, 0.6), 2.4, 9.0)
	_omni(Vector3(-7.8, 1.9, 11.9), Color(0.6, 1.0, 0.7), 1.2, 4.0)           # garden glow

	# ---- Dormitory XL: six bunks for the night shift
	if kit:
		var bunk_colors := ["Blue", "Green", "Orange", "Purple", "Red", "Grey"]
		for i in 6:
			_kit("Bunk_Single_" + bunk_colors[i], Vector3(4.6 + i * 1.8, 0, 11.7), 0.0, 0.7)
		_stanchion(Vector3(15.2, 0, 12.2), 90.0)
		_kit("Plant_1", Vector3(3.7, 0, 6.8), 200.0, 1.7)
	_omni(Vector3(9.5, 2.3, 10.0), Color(1.0, 0.78, 0.55), 1.6, 9.0)

	# Coffee steam
	var steam := GPUParticles3D.new()
	steam.amount = 14
	steam.lifetime = 2.6
	steam.preprocess = 2.6
	var spm := ParticleProcessMaterial.new()
	spm.direction = Vector3(0, 1, 0)
	spm.initial_velocity_min = 0.12
	spm.initial_velocity_max = 0.25
	spm.gravity = Vector3.ZERO
	spm.scale_min = 0.5
	spm.scale_max = 1.4
	steam.process_material = spm
	var sq := QuadMesh.new()
	sq.size = Vector2(0.07, 0.07)
	var smat := _mat(Color(1, 1, 1, 0.12))
	smat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	smat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	smat.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	sq.material = smat
	steam.draw_pass_1 = sq
	add_child(steam)
	steam.position = Vector3(9.45, 1.68, -1.2)

	# ---- Security Center
	if kit:
		_kit("Large_Monitor_Orange", Vector3(-9.6, 0, -0.5), 90.0, 0.5)
		_kit("BioMonitor_Red", Vector3(-9.7, 0, -2.2), 90.0, 0.5)
	else:
		for i in 3:
			var sm := ShaderMaterial.new()
			sm.shader = SCREEN_SHADER
			sm.set_shader_parameter("glow_col", Vector3(1.0, 0.55, 0.2))
			sm.set_shader_parameter("speed", 0.35 + i * 0.2)
			_box(Vector3(-9.85, 2.0, -1.6 + i * 1.1), Vector3(0.06, 0.5, 0.8), sm)
	_box(Vector3(-8.6, 0.45, 0.9), Vector3(1.4, 0.9, 0.6), dark_wood)          # sec desk
	_box(Vector3(-6.3, 2.2, -0.5), Vector3(0.12, 0.12, 0.12),
		_mat(Color(0.6, 0.1, 0.1), 0.4, Color(1, 0.15, 0.1), 2.5))             # beacon
	sec_light = _omni(Vector3(-8, 2.4, -0.5), Color(1.0, 0.7, 0.35), 1.8, 5.5)

	# ---- Plants
	for pp in [Vector3(-4.6, 0, 4.8), Vector3(3.4, 0, 5.2), Vector3(5.0, 0, -2.3),
			Vector3(-2.6, 0, -9.4), Vector3(9.3, 0, 4.6), Vector3(-9.4, 0, -9.3)]:
		if kit:
			_kit("Plant_1", pp, randf_range(0.0, 360.0), 1.7)
		else:
			_plant(pp)

	# ---- Atmosphere: room fog + god-ray cards + dust
	var fog := FogVolume.new()
	fog.size = Vector3(26, 3.5, 23)
	var fm := FogMaterial.new()
	fm.density = 0.035
	fm.albedo = Color(0.85, 0.9, 1.0)
	fog.material = fm
	add_child(fog)
	fog.position = Vector3(3, 1.75, 1.5)

	# God-ray cards anchored to the window slots (kit shell: two big glass bays)
	for wx in ([-3.58, 5.39] if kit else [-7.0, -2.5, 2.5, 7.0]):
		var quad := QuadMesh.new()
		quad.size = Vector2(3.2 if kit else 2.3, 5.0)
		var bm := ShaderMaterial.new()
		bm.shader = BEAM_SHADER
		bm.set_shader_parameter("strength", 0.18)
		beam_mats.append(bm)
		var mi := MeshInstance3D.new()
		mi.mesh = quad
		mi.material_override = bm
		mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		add_child(mi)
		mi.position = Vector3(wx - 0.5, 1.5, -8.3)
		mi.rotation_degrees = Vector3(-48.0, -14.0, 0.0)

	var dust := GPUParticles3D.new()
	dust.amount = 90
	dust.lifetime = 14.0
	dust.preprocess = 14.0
	dust.visibility_aabb = AABB(Vector3(-11, -1, -9), Vector3(22, 6, 16))
	var dpm := ParticleProcessMaterial.new()
	dpm.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_BOX
	dpm.emission_box_extents = Vector3(9.5, 1.8, 6.5)
	dpm.gravity = Vector3(0, -0.02, 0)
	dpm.scale_min = 0.4
	dpm.scale_max = 1.3
	dust.process_material = dpm
	var dq := QuadMesh.new()
	dq.size = Vector2(0.025, 0.025)
	var dmat := _mat(Color(1, 0.95, 0.85, 0.16))
	dmat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	dmat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	dmat.billboard_mode = BaseMaterial3D.BILLBOARD_PARTICLES
	dq.material = dmat
	dust.draw_pass_1 = dq
	add_child(dust)
	dust.position = Vector3(0, 2, -5)

func _logo_mesh(path: String, size: Vector2) -> MeshInstance3D:
	var img := Image.load_from_file(ProjectSettings.globalize_path(path))
	if img == null:
		return null
	var m := StandardMaterial3D.new()
	m.albedo_texture = ImageTexture.create_from_image(img)
	m.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	# Unshaded: the brand ignores scene lighting entirely — always crisp.
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	var quad := QuadMesh.new()
	quad.size = size
	quad.material = m
	var mi := MeshInstance3D.new()
	mi.mesh = quad
	mi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return mi

## Branded quad: textured, gently emissive so it reads day and night.
func _logo(path: String, pos: Vector3, size: Vector2, rot_y: float) -> void:
	var mi := _logo_mesh(path, size)
	if mi == null:
		return
	add_child(mi)
	mi.position = pos
	mi.rotation_degrees.y = rot_y

## Rooftop company billboard: framed panel on posts, tilted to face the
## camera dead-on (a flat wall decal is unreadable from the -45° camera).
func _billboard(center: Vector3, tilt_deg: float) -> void:
	var rig := Node3D.new()
	add_child(rig)
	rig.position = center
	rig.rotation_degrees.x = tilt_deg

	var frame := CSGBox3D.new()
	frame.size = Vector3(7.2, 1.95, 0.1)
	frame.material = _mat(Color(0.55, 0.56, 0.6), 0.35)
	rig.add_child(frame)
	frame.position = Vector3(0, 0, -0.04)

	var panel := CSGBox3D.new()
	panel.size = Vector3(6.85, 1.6, 0.1)
	panel.material = _mat(Color(0.05, 0.07, 0.12), 0.4)
	rig.add_child(panel)
	panel.position = Vector3(0, 0, 0.02)

	# logo.png is 1380x207 → keep ratio, leave padding inside the panel
	var logo := _logo_mesh("res://assets/brand/logo.png", Vector2(6.1, 0.92))
	if logo:
		rig.add_child(logo)
		logo.position = Vector3(0, 0, 0.085)
		_billboard_logo = logo
		if _billboard_pending != "":
			set_billboard_texture(_billboard_pending)

	# support posts down to the wall top (at the billboard's own z, not a fixed
	# old-wall z — otherwise they float in front of the back wall)
	var post_mat := _mat(Color(0.3, 0.31, 0.34), 0.5)
	_box(Vector3(center.x - 2.6, center.y - 1.2, center.z + 0.1), Vector3(0.16, 1.6, 0.16), post_mat)
	_box(Vector3(center.x + 2.6, center.y - 1.2, center.z + 0.1), Vector3(0.16, 1.6, 0.16), post_mat)

## Countryside placeholder set (swappable for real assets later): grass
## field with wind-swaying blades, low-poly mountains, hills and pine trees.
func _build_countryside() -> void:
	# Ground: one big meadow under and around the building.
	_box(Vector3(3, -0.12, -2), Vector3(110, 0.2, 90), _mat(Color(0.15, 0.34, 0.13), 0.95))

	# Swaying grass: thousands of shader-animated blades via MultiMesh.
	var grass_mat := ShaderMaterial.new()
	grass_mat.shader = GRASS_SHADER
	var blade := QuadMesh.new()
	blade.size = Vector2(0.16, 0.42)
	blade.material = grass_mat
	var mm := MultiMesh.new()
	mm.transform_format = MultiMesh.TRANSFORM_3D
	mm.mesh = blade
	var rng := RandomNumberGenerator.new()
	rng.seed = 77
	var placements: Array[Transform3D] = []
	while placements.size() < 4200:
		var px := rng.randf_range(-40.0, 40.0)
		var pz := rng.randf_range(-26.0, 34.0)
		# keep the (origin-centred, rectangular) office footprint clear so no
		# grass pokes through the floor inside
		if px > -16.6 and px < 16.6 and pz > -12.8 and pz < 12.8:
			continue
		var t := Transform3D(Basis(Vector3.UP, rng.randf_range(0.0, TAU))
			.scaled(Vector3.ONE * rng.randf_range(0.7, 1.4)), Vector3(px, 0.16, pz))
		placements.append(t)
	mm.instance_count = placements.size()
	for i in placements.size():
		mm.set_instance_transform(i, placements[i])
	var mmi := MultiMeshInstance3D.new()
	mmi.multimesh = mm
	mmi.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(mmi)

	var tree_spots: Array = [
		Vector3(-20, 0, -13), Vector3(-26, 0, -10), Vector3(-16, 0, -16), Vector3(-30, 0, -4),
		Vector3(22, 0, -14), Vector3(28, 0, -9), Vector3(34, 0, -16), Vector3(21, 0, -11),
		Vector3(-24, 0, 4), Vector3(-28, 0, 12), Vector3(-19, 0, 18), Vector3(-26, 0, 24),
		Vector3(24, 0, 6), Vector3(30, 0, 14), Vector3(22, 0, 22), Vector3(36, 0, 2),
		Vector3(-14, 0, 28), Vector3(12, 0, 30), Vector3(30, 0, 27),
	]

	if _env_available():
		# Real low-poly pack: mountain range, trees, bushes, rocks, logs.
		_env("Mounting_3", Vector3(2, 0, -27), 0.0, 1.4)
		_env("Mounting_2", Vector3(-22, 0, -24), 20.0, 1.2)
		_env("Mounting_1", Vector3(24, 0, -25), -15.0, 1.3)
		_env("Mounting_1", Vector3(-38, 0, -18), 40.0, 0.9)
		_env("Mounting_2", Vector3(40, 0, -18), 70.0, 0.8)
		for i in tree_spots.size():
			var tp: Vector3 = tree_spots[i]
			var kind := "Tree_%d" % (1 + i % 3)
			var ts := 0.45 + fmod(absf(tp.x * 3.7 + tp.z * 1.3), 1.0) * 0.35
			_env(kind, tp, fmod(tp.x * 53.0, 360.0), ts)
		for i in 10:
			var bp := Vector3(-32.0 + fmod(i * 13.7, 66.0), 0, 16.0 + fmod(i * 7.3, 14.0))
			if bp.x > -12.0 and bp.x < 18.0 and bp.z < 14.5:
				continue
			_env("Bush_%d" % (1 + i % 3), bp, i * 71.0, 0.8)
		for r in [[Vector3(-15, 0, 16), 1], [Vector3(19, 0, 17), 3], [Vector3(-13, 0, -14), 5],
				[Vector3(19.5, 0, -13), 2], [Vector3(-33, 0, 8), 4], [Vector3(38, 0, 10), 6]]:
			_env("Rock_%d" % r[1], r[0], r[1] * 47.0, 1.1)
		_env("Log_1", Vector3(-17, 0, 22), 30.0, 0.9)
		_env("Log_2", Vector3(26, 0, 19), -50.0, 0.9)
		for i in 26:
			var gp := Vector3(-30.0 + fmod(i * 11.3, 64.0), 0, -16.0 + fmod(i * 17.9, 46.0))
			# clear the (origin-centred, rectangular) office footprint so no grass
			# tufts/clover poke through the interior floor
			if gp.x > -16.8 and gp.x < 16.8 and gp.z > -13.0 and gp.z < 13.0:
				continue
			_env("Grass_%d" % (1 + i % 2), gp, i * 31.0, 1.3)
	else:
		# Procedural fallback so clones without the pack still get a horizon.
		var rock := _mat(Color(0.32, 0.4, 0.45), 0.95)
		var snow := _mat(Color(0.92, 0.95, 1.0), 0.8)
		for m in [
			[Vector3(-18, 0, -26), 14.0, 16.0], [Vector3(-2, 0, -30), 18.0, 22.0],
			[Vector3(16, 0, -27), 15.0, 18.0], [Vector3(30, 0, -24), 11.0, 13.0],
		]:
			var peak := CSGCylinder3D.new()
			peak.cone = true
			peak.radius = m[1]
			peak.height = m[2]
			peak.sides = 7
			peak.material = rock
			add_child(peak)
			peak.position = m[0] + Vector3(0, m[2] * 0.5 - 0.2, 0)
		var trunk_mat := _mat(Color(0.3, 0.2, 0.12), 0.9)
		var leaf_mat := _mat(Color(0.12, 0.32, 0.12), 0.9)
		for tp in tree_spots:
			var s := 0.8 + fmod(absf(tp.x * 3.7 + tp.z * 1.3), 1.0) * 0.8
			var trunk := CSGCylinder3D.new()
			trunk.radius = 0.16 * s
			trunk.height = 0.9 * s
			trunk.material = trunk_mat
			add_child(trunk)
			trunk.position = tp + Vector3(0, 0.45 * s, 0)
			var leaf := CSGCylinder3D.new()
			leaf.cone = true
			leaf.radius = 0.95 * s
			leaf.height = 2.4 * s
			leaf.sides = 6
			leaf.material = leaf_mat
			add_child(leaf)
			leaf.position = tp + Vector3(0, 2.1 * s, 0)

func _plant(pos: Vector3) -> void:
	var pot := CSGCylinder3D.new()
	pot.radius = 0.18
	pot.height = 0.34
	pot.material = _mat(Color(0.45, 0.26, 0.18), 0.8)
	add_child(pot)
	pot.position = pos + Vector3(0, 0.17, 0)
	var leaf_mat := _mat(Color(0.16, 0.34, 0.18), 0.9)
	for off in [Vector3(0, 0.62, 0), Vector3(0.13, 0.5, 0.08), Vector3(-0.11, 0.52, -0.07)]:
		var leaf := CSGSphere3D.new()
		leaf.radius = 0.2
		leaf.material = leaf_mat
		add_child(leaf)
		leaf.position = pos + off
