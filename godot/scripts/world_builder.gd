extends Node3D
## Office floor v3 (art pass): 5 zones with full procedural set-dressing —
## glass partitions, window frames, city skyline, bookshelves, pendant lamps,
## floor logo, props per zone. Owns the walkable waypoint graph (AStar3D).
## All geometry is data-driven; a real asset pass replaces builders, the
## graph + anchor + board APIs stay.

const BEAM_SHADER := preload("res://shaders/light_beam.gdshader")
const SCREEN_SHADER := preload("res://shaders/screen_code.gdshader")
const FLOOR_SHADER := preload("res://shaders/floor_planks.gdshader")

const WP := {
	"exec_c": Vector3(-6, 0.86, -6),
	"ceo_desk": Vector3(-6, 0.86, -7.3),
	"pace_a": Vector3(-7.2, 0.86, -7.3),
	"pace_b": Vector3(-4.8, 0.86, -7.3),
	"ops_c": Vector3(3, 0.86, -6.75),
	"ap1": Vector3(2.4, 0.86, -8.85),
	"ap2": Vector3(6.55, 0.86, -8.85),
	"desk1": Vector3(1, 0.86, -8.85),
	"desk2": Vector3(5, 0.86, -8.85),
	"desk3": Vector3(1, 0.86, -6.35),
	"desk4": Vector3(5, 0.86, -6.35),
	"lobby_c": Vector3(-1, 0.86, 1.5),
	"spawn": Vector3(-1, 0.86, 5.8),
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
}

const EDGES := [
	["exec_c", "door_el"], ["exec_c", "door_eo"], ["exec_c", "ceo_desk"],
	["ceo_desk", "pace_a"], ["ceo_desk", "pace_b"],
	["ops_c", "door_ol"], ["ops_c", "door_oc"], ["ops_c", "door_eo"],
	["ops_c", "ap1"], ["ap1", "desk1"], ["ops_c", "ap2"], ["ap2", "desk2"],
	["ops_c", "desk3"], ["ops_c", "desk4"],
	["lobby_c", "door_el"], ["lobby_c", "door_ol"], ["lobby_c", "door_sl"],
	["lobby_c", "door_lc"], ["lobby_c", "spawn"],
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
]

const BOARD_COLORS := {
	"running": Color(0.3, 0.75, 1.0),
	"blocked": Color(1.0, 0.62, 0.25),
	"done": Color(0.35, 1.0, 0.5),
	"failed": Color(1.0, 0.3, 0.25),
}

var astar := AStar3D.new()
var totem_mat: StandardMaterial3D
var sec_light: OmniLight3D
var sky_mat: StandardMaterial3D
var beam_mats: Array[ShaderMaterial] = []

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

var _tint_mat_cache := {}

## Multiplies a kit model's materials by a color (zone-keying plain floors).
func _tint_meshes(node: Node, tint: Color) -> void:
	if node is MeshInstance3D:
		var mi: MeshInstance3D = node
		if mi.mesh:
			for i in mi.mesh.get_surface_count():
				var src := mi.get_active_material(i)
				if src is BaseMaterial3D:
					var key := str(src.get_instance_id()) + tint.to_html()
					if not _tint_mat_cache.has(key):
						var dup: BaseMaterial3D = src.duplicate()
						dup.albedo_color = tint
						_tint_mat_cache[key] = dup
					mi.set_surface_override_material(i, _tint_mat_cache[key])
	for c in node.get_children():
		_tint_meshes(c, tint)

## Kit floor: tile a zone with nx × nz pieces stretched to fit exactly.
func _kit_floor(model: String, center: Vector3, w: float, d: float, nx: int, nz: int,
		tint := Color.WHITE) -> void:
	for ix in nx:
		for iz in nz:
			var px := center.x + ((ix + 0.5) / nx - 0.5) * w
			var pz := center.z + ((iz + 0.5) / nz - 0.5) * d
			var tile := _kit_scaled(model, Vector3(px, 0, pz), 0.0,
				Vector3(w / nx / 4.0, 1.0, d / nz / 4.0))
			if tile and tint != Color.WHITE:
				_tint_meshes(tile, tint)

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

	# West & far-east perimeter (4 × 4.075 m, rotated)
	for i in 4:
		var cz := -10.15 + 4.075 * (i + 0.5)
		_kit_scaled("Wall_Grey", Vector3(-10.15, 0, cz), 90.0, Vector3(1.019, ws, ws))
		_kit_scaled("Wall_Grey", Vector3(16.15, 0, cz), -90.0, Vector3(1.019, ws, ws))

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

	# Zone floors: calm plain metal everywhere, zone-keyed by a subtle tint.
	_kit_floor("Floor_Metal_Square", Vector3(-6, 0, -6.5), 7.6, 6.6, 3, 3, Color(1.0, 0.88, 0.7))   # exec warm
	_kit_floor("Floor_Metal_Square", Vector3(4, 0, -6.5), 11.6, 6.6, 5, 3, Color(0.74, 0.84, 1.0))  # ops cool
	_kit_floor("Floor_Metal_Square", Vector3(-1, 0, 1.5), 9.6, 8.6, 4, 3)                           # lobby neutral
	_kit_floor("Floor_Metal_Square", Vector3(7, 0, 1.5), 5.6, 8.6, 3, 4, Color(1.0, 0.76, 0.66))    # cafe warm red
	_kit_floor("Floor_Metal_Square", Vector3(-8, 0, -0.5), 3.6, 4.6, 2, 2, Color(0.78, 1.0, 0.8))   # sec green
	_kit_floor("Floor_Metal_Square", Vector3(13, 0, -6.5), 5.6, 6.6, 2, 3, Color(0.7, 0.92, 0.82))  # server teal
	_kit_floor("Floor_Metal_Square", Vector3(13, 0, -0.5), 5.6, 4.6, 2, 2, Color(0.86, 0.8, 1.0))   # meeting violet
	_kit_floor("Floor_Metal_Square", Vector3(13, 0, 4), 5.6, 3.6, 2, 1, Color(0.78, 0.82, 0.98))    # dorm dusk

func _ready() -> void:
	_build_graph()
	_build_geometry()

# ---------------------------------------------------------------- graph

func _build_graph() -> void:
	var next_id := 0
	for name in WP:
		_wp_ids[name] = next_id
		astar.add_point(next_id, WP[name])
		next_id += 1
	for e in EDGES:
		astar.connect_points(_wp_ids[e[0]], _wp_ids[e[1]])

func _nearest(pos: Vector3) -> int:
	var best := -1
	var best_d := INF
	for name in _wp_ids:
		var d: float = pos.distance_to(WP[name])
		if d < best_d:
			best_d = d
			best = _wp_ids[name]
	return best

func path_to(from_pos: Vector3, target: String) -> Array:
	var pts := astar.get_point_path(_nearest(from_pos), _wp_ids[target])
	var out: Array = []
	for p in pts:
		out.append(p)
	if out.size() > 1 and from_pos.distance_to(out[0]) < 0.4:
		out.pop_front()
	return out

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

## Replay Theater: sepia grade in-world + marquee banner on the HUD.
func set_theater(on: bool) -> void:
	var we := get_node_or_null("../WorldEnvironment")
	if we:
		we.environment.adjustment_saturation = 0.5 if on else 1.22
	var hud := get_node_or_null("../Hud")
	if hud:
		hud.set_theater(on)

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
		_box(Vector3(3, -0.1, -2), Vector3(26.6, 0.2, 16.6), _mat(Color(0.12, 0.13, 0.16), 0.5))
		_kit_architecture()
	else:
		_box(Vector3(3, -0.1, -2), Vector3(26.6, 0.2, 16.6), planks)
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

	# ---- Sky + city skyline + shadows-only ceiling
	sky_mat = _mat(Color(0.55, 0.75, 1.0), 1.0, Color(0.55, 0.72, 1.0), 1.6)
	sky_mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	_box(Vector3(0, 5, -14.5), Vector3(48, 18, 0.1), sky_mat, 0)
	var bldg := _mat(Color(0.1, 0.12, 0.2), 0.9)
	var bldg_rng := RandomNumberGenerator.new()
	bldg_rng.seed = 21
	var bx := -20.0
	while bx < 20.0:
		var bw := bldg_rng.randf_range(1.4, 2.8)
		var bh := bldg_rng.randf_range(2.5, 8.0)
		_box(Vector3(bx + bw / 2.0, bh / 2.0, -11.8 - bldg_rng.randf_range(0.0, 0.8)),
			Vector3(bw, bh, 0.8), bldg, 0)
		if bldg_rng.randf() < 0.6:
			_box(Vector3(bx + bw / 2.0, bh * 0.6, -11.3), Vector3(bw * 0.4, 0.18, 0.05),
				_mat(Color(0.9, 0.8, 0.5), 0.5, Color(1, 0.85, 0.5), 1.2), 0)
		bx += bw + bldg_rng.randf_range(0.3, 1.0)
	_box(Vector3(3, 3.7, -2), Vector3(26.6, 0.2, 16.6), wall, 3)

	# ---- Executive Office
	if kit:
		_kit("Command_Console", Vector3(-6, 0, -8.4), 0.0, 0.5)   # the command station
		_kit("Orrery", Vector3(-8.6, 0, -4.2), 0.0, 0.35)
		_kit("Large_Monitor_Blue", Vector3(-8.06, 0, -9.55), 0.0, 0.5)
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

	# ---- Ops Floor: 4 desk pods
	for d in [Vector3(1, 0, -8), Vector3(5, 0, -8), Vector3(1, 0, -5.5), Vector3(5, 0, -5.5)]:
		if kit:
			_box(Vector3(d.x, 0.4, d.z), Vector3(1.6, 0.8, 0.8), dark_wood)     # desk slab
			_kit("Large_Monitor_Blue", Vector3(d.x, 0.8, d.z + 0.1), 0.0, 0.26) # kit monitor on top
			_kit("Chair_1", Vector3(d.x, 0, d.z - 0.95), 180.0, 0.6)            # chair at the anchor side
		else:
			_box(Vector3(d.x, 0.4, d.z), Vector3(1.6, 0.8, 0.8), wood)
			_box(Vector3(d.x, 0.86, d.z + 0.08), Vector3(0.08, 0.16, 0.08), cap)
			_box(Vector3(d.x, 1.05, d.z + 0.08), Vector3(0.74, 0.46, 0.05), screen)
			_box(Vector3(d.x, 0.83, d.z - 0.22), Vector3(0.5, 0.03, 0.18), _mat(Color(0.1, 0.1, 0.12), 0.4))
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
		_kit("Floor_Lamp", Vector3(-4.5, 0, 4.6), 0.0, 1.0)
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

	# ---- Dormitory (offline agents sleep here)
	if kit:
		_kit("Bunk_Single_Blue", Vector3(11.5, 0, 5.1), 0.0, 0.7)
		_kit("Bunk_Single_Red", Vector3(14.5, 0, 5.1), 0.0, 0.7)
		_kit("Cryo_Tube_ON", Vector3(15.6, 0, 2.9), 0.0, 0.45)
		_kit("Floor_Lamp", Vector3(10.8, 0, 5.4), 0.0, 0.9)
		_kit("Plant_1", Vector3(10.7, 0, 2.6), 120.0, 1.7)
	_omni(Vector3(13, 2.2, 4.2), Color(1.0, 0.75, 0.5), 1.1, 5.0)

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
	fog.size = Vector3(26, 3.5, 16)
	var fm := FogMaterial.new()
	fm.density = 0.035
	fm.albedo = Color(0.85, 0.9, 1.0)
	fog.material = fm
	add_child(fog)
	fog.position = Vector3(3, 1.75, -2)

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

	# support posts down to the wall top
	var post_mat := _mat(Color(0.3, 0.31, 0.34), 0.5)
	_box(Vector3(center.x - 2.6, center.y - 0.9, -10.05), Vector3(0.16, 1.1, 0.16), post_mat)
	_box(Vector3(center.x + 2.6, center.y - 0.9, -10.05), Vector3(0.16, 1.1, 0.16), post_mat)

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
