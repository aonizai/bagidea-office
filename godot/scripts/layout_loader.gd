extends Node3D
## Office Editor layer. Fetches the user's custom layout from the daemon
## (GET /layout) and spawns furniture / decor / imported assets ON TOP of the
## procedural world — the base office, atmosphere and effects stay untouched.
## Re-applies whenever the editor saves (event_client routes "layout.changed").
##
## A layout item: { type, x, z, y?, rot?, scale?, color?, asset?, w?, d?, h? }
## Coordinates are world meters (same space the overlay editor grid maps to).

const LAYOUT_URL := "http://127.0.0.1:8787/layout"

var _root: Node3D
var _req: HTTPRequest

func _ready() -> void:
	_root = Node3D.new()
	_root.name = "CustomLayout"
	add_child(_root)
	_req = HTTPRequest.new()
	add_child(_req)
	_req.request_completed.connect(_on_layout)
	reload()

func reload() -> void:
	if _req.get_http_client_status() == HTTPClient.STATUS_DISCONNECTED:
		_req.request(LAYOUT_URL)

func _on_layout(_result: int, code: int, _headers: PackedStringArray, body: PackedByteArray) -> void:
	if code != 200:
		return
	var data: Variant = JSON.parse_string(body.get_string_from_utf8())
	if not (data is Dictionary):
		return
	# restore the saved room arrangement (jigsaw swap) before placing decor
	if data.get("rooms") is Array or data.get("ghost") is Array or data.get("billboard") is String:
		var wb := get_node_or_null("/root/OfficeFloor/World")
		if wb and data.get("rooms") is Array and wb.has_method("apply_room_order"):
			wb.apply_room_order(data["rooms"])
		if wb and data.get("ghost") is Array and (data["ghost"] as Array).size() == 2 and wb.has_method("set_ghost_deck_pos"):
			wb.set_ghost_deck_pos(float(data["ghost"][0]), float(data["ghost"][1]))
		if wb and data.get("billboard") is String and String(data["billboard"]) != "" and wb.has_method("set_billboard_texture"):
			wb.set_billboard_texture(String(data["billboard"]))
	if not (data.get("items") is Array):
		return
	for c in _root.get_children():
		c.queue_free()
	for it in data["items"]:
		if it is Dictionary:
			_spawn(it)
	_apply_system(data["items"])

## System items carry an "anchor" (deskN / bedN / lead_desk / ceo_desk):
## move the agent's waypoint there so characters work at the new desk, and
## hide the matching baked ops desks so they don't double up.
func _apply_system(arr: Array) -> void:
	var wb := get_node_or_null("/root/OfficeFloor/World")
	if wb == null or not wb.has_method("set_anchor"):
		return
	var has_custom_ops := false
	for it in arr:
		if it is Dictionary and it.get("system", false) and it.has("anchor"):
			var name := String(it["anchor"])
			wb.set_anchor(name, Vector3(float(it.get("x", 0)), 0.86, float(it.get("z", 0))))
			if name.begins_with("desk"):
				has_custom_ops = true
	if wb.has_method("hide_ops_desks"):
		wb.hide_ops_desks(has_custom_ops)

func _mat(hex: String, rough := 0.8, metal := 0.0) -> StandardMaterial3D:
	var m := StandardMaterial3D.new()
	m.albedo_color = Color(hex) if hex != "" else Color(0.7, 0.72, 0.78)
	m.roughness = rough
	m.metallic = metal
	return m

func _box(w: float, h: float, d: float, mat: StandardMaterial3D) -> MeshInstance3D:
	var mi := MeshInstance3D.new()
	var bm := BoxMesh.new()
	bm.size = Vector3(w, h, d)
	mi.mesh = bm
	mi.material_override = mat
	return mi

func _spawn(it: Dictionary) -> void:
	var type := String(it.get("type", "desk"))
	var pos := Vector3(float(it.get("x", 0.0)), float(it.get("y", 0.0)), float(it.get("z", 0.0)))
	var rot := float(it.get("rot", 0.0))
	var scl := float(it.get("scale", 1.0))
	var col := String(it.get("color", ""))
	var rig := Node3D.new()
	rig.position = pos
	rig.rotation_degrees = Vector3(0, rot, 0)
	rig.scale = Vector3(scl, scl, scl)
	_root.add_child(rig)

	match type:
		"desk":
			var top := _box(1.4, 0.08, 0.8, _mat(col if col != "" else "3a2e25", 0.5))
			top.position.y = 0.74
			rig.add_child(top)
			for sx in [-0.6, 0.6]:
				for sz in [-0.32, 0.32]:
					var leg := _box(0.08, 0.74, 0.08, _mat("222831"))
					leg.position = Vector3(sx, 0.37, sz)
					rig.add_child(leg)
		"table":
			var t := _box(1.1, 0.08, 1.1, _mat(col if col != "" else "4a3b2c", 0.5))
			t.position.y = 0.7
			rig.add_child(t)
			var post := _box(0.12, 0.7, 0.12, _mat("2a2a2a"))
			post.position.y = 0.35
			rig.add_child(post)
		"chair":
			var seat := _box(0.45, 0.07, 0.45, _mat(col if col != "" else "5a6b8c", 0.6))
			seat.position.y = 0.45
			rig.add_child(seat)
			var back := _box(0.45, 0.5, 0.07, _mat(col if col != "" else "5a6b8c", 0.6))
			back.position = Vector3(0, 0.7, -0.19)
			rig.add_child(back)
		"shelf":
			var body := _box(0.9, 1.6, 0.32, _mat(col if col != "" else "4a3a2a", 0.7))
			body.position.y = 0.8
			rig.add_child(body)
			for sy in [0.45, 0.85, 1.25]:
				var shelf := _box(0.86, 0.04, 0.3, _mat("2a2018"))
				shelf.position.y = sy
				rig.add_child(shelf)
		"plant":
			var pot := _box(0.3, 0.3, 0.3, _mat("8a5a3a", 0.8))
			pot.position.y = 0.15
			rig.add_child(pot)
			var leaves := MeshInstance3D.new()
			var sm := SphereMesh.new()
			sm.radius = 0.32
			sm.height = 0.7
			leaves.mesh = sm
			leaves.material_override = _mat(col if col != "" else "3c7a3c", 0.9)
			leaves.position.y = 0.6
			rig.add_child(leaves)
		"lamp":
			var stand := _box(0.06, 1.3, 0.06, _mat("333"))
			stand.position.y = 0.65
			rig.add_child(stand)
			var light := OmniLight3D.new()
			light.position.y = 1.35
			light.light_energy = 2.0
			light.omni_range = 5.0
			light.light_color = Color(col) if col != "" else Color(1.0, 0.9, 0.7)
			rig.add_child(light)
			var bulb := MeshInstance3D.new()
			var bm := SphereMesh.new()
			bm.radius = 0.12
			bm.height = 0.24
			bulb.mesh = bm
			var lm := _mat(col if col != "" else "ffe6b0")
			lm.emission_enabled = true
			lm.emission = lm.albedo_color
			bulb.material_override = lm
			bulb.position.y = 1.35
			rig.add_child(bulb)
		"rug":
			var r := _box(float(it.get("w", 2.0)), 0.02, float(it.get("d", 1.5)), _mat(col if col != "" else "7a3b4b", 0.95))
			r.position.y = 0.02
			rig.add_child(r)
		"wall":
			var wall := _box(float(it.get("w", 3.0)), float(it.get("h", 2.2)), 0.16, _mat(col if col != "" else "8a8f99", 0.85))
			wall.position.y = float(it.get("h", 2.2)) * 0.5
			rig.add_child(wall)
		"partition":
			var p := _box(float(it.get("w", 3.0)), 1.15, 0.08, _mat(col if col != "" else "9aa3b2", 0.6))
			p.position.y = 0.6
			rig.add_child(p)
		"sofa":
			var sb := _box(1.6, 0.4, 0.7, _mat(col if col != "" else "44506b", 0.7)); sb.position.y = 0.25; rig.add_child(sb)
			var sbk := _box(1.6, 0.5, 0.18, _mat(col if col != "" else "44506b", 0.7)); sbk.position = Vector3(0, 0.6, -0.26); rig.add_child(sbk)
		"tv":
			var scr := _box(1.5, 0.85, 0.08, _mat("0a0a0c", 0.3)); scr.position.y = 1.1; rig.add_child(scr)
			var stnd := _box(0.1, 1.0, 0.1, _mat("222")); stnd.position.y = 0.5; rig.add_child(stnd)
		"whiteboard":
			var wb := _box(1.6, 1.0, 0.06, _mat("f0f2f5", 0.4)); wb.position.y = 1.2; rig.add_child(wb)
		"cabinet":
			var cb := _box(0.9, 1.1, 0.5, _mat(col if col != "" else "6b7280", 0.6)); cb.position.y = 0.55; rig.add_child(cb)
		"cooler":
			var cby := _box(0.4, 1.1, 0.4, _mat("dfe7ef", 0.4)); cby.position.y = 0.55; rig.add_child(cby)
			var jug := _box(0.32, 0.4, 0.32, _mat("7ec8ff", 0.2)); jug.position.y = 1.25; rig.add_child(jug)
		"bed":
			var bmat := _box(2.0, 0.3, 1.0, _mat(col if col != "" else "5566aa", 0.7)); bmat.position.y = 0.25; rig.add_child(bmat)
			var pil := _box(0.5, 0.18, 0.9, _mat("eef2f7", 0.6)); pil.position = Vector3(-0.7, 0.45, 0); rig.add_child(pil)
		"poster":
			# imported image → textured quad you can hang anywhere
			_spawn_poster(rig, String(it.get("asset", "")), float(it.get("w", 1.2)), float(it.get("h", 0.8)))
		"model":
			# imported .glb/.gltf/.fbx placed in the world (auto-fitted)
			_spawn_model(rig, String(it.get("asset", "")), String(it.get("anim", "")), float(it.get("fit", 1.1)))
		_:
			var d := _box(0.6, 0.6, 0.6, _mat(col))
			d.position.y = 0.3
			rig.add_child(d)

func _abs_asset(asset: String) -> String:
	# editor stores res://… (bundled furniture), /uploads/<name>, or an absolute
	# path; all resolve to a disk path Godot reads directly.
	if asset.begins_with("res://"):
		return ProjectSettings.globalize_path(asset)
	if asset.begins_with("/uploads/"):
		# uploads live in <repo>/workspace/uploads — resolve via project dir
		return ProjectSettings.globalize_path("res://..") + "/workspace/uploads/" + asset.get_file()
	return asset

func _spawn_poster(rig: Node3D, asset: String, w: float, h: float) -> void:
	if asset == "":
		return
	var img := Image.new()
	var p := _abs_asset(asset)
	if img.load(p) != OK:
		return
	var tex := ImageTexture.create_from_image(img)
	var mi := MeshInstance3D.new()
	var qm := QuadMesh.new()
	qm.size = Vector2(w, h)
	mi.mesh = qm
	var m := StandardMaterial3D.new()
	m.albedo_texture = tex
	m.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	m.cull_mode = BaseMaterial3D.CULL_DISABLED
	mi.material_override = m
	mi.position.y = h * 0.5 + 0.8
	rig.add_child(mi)

func _spawn_model(rig: Node3D, asset: String, anim := "", fit := 1.1) -> void:
	if asset == "":
		return
	var p := _abs_asset(asset)
	var ext := p.get_extension().to_lower()
	var scene: Node = null
	if ext == "glb" or ext == "gltf":
		var doc := GLTFDocument.new()
		var state := GLTFState.new()
		if doc.append_from_file(p, state) == OK:
			scene = doc.generate_scene(state)
	elif ext == "fbx":
		var doc2 := FBXDocument.new()
		var state2 := FBXState.new()
		if doc2.append_from_file(p, state2) == OK:
			scene = doc2.generate_scene(state2)
	if scene and scene is Node3D:
		rig.add_child(scene)
		_fit_model(scene as Node3D, fit)
		# play the animation the editor picked for this instance
		var ap := scene.find_child("AnimationPlayer", true, false)
		if ap and ap is AnimationPlayer:
			var names: Array = (ap as AnimationPlayer).get_animation_list()
			var pick := anim
			if pick == "" and names.size() > 0:
				pick = String(names[0])   # default: first clip
			if pick != "" and pick in names:
				(ap as AnimationPlayer).play(pick)

## Normalise an imported model to a sane floor footprint + sit its base on y=0,
## so any unit/origin (glb or fbx, bundled or user import) renders consistently.
func _fit_model(scene: Node3D, target: float) -> void:
	var aabb := _node_aabb(scene, Transform3D.IDENTITY)
	if aabb.size == Vector3.ZERO: return
	var span: float = max(aabb.size.x, aabb.size.z)
	if span <= 0.0001: span = max(aabb.size.y, 0.0001)
	var f: float = target / span
	scene.scale = Vector3(f, f, f)
	scene.position.y = -aabb.position.y * f

func _node_aabb(n: Node, xform: Transform3D) -> AABB:
	var acc := AABB(); var has := false
	if n is MeshInstance3D and (n as MeshInstance3D).mesh:
		acc = xform * (n as MeshInstance3D).mesh.get_aabb(); has = true
	for c in n.get_children():
		var cx := xform
		if c is Node3D: cx = xform * (c as Node3D).transform
		var sub := _node_aabb(c, cx)
		if sub.size != Vector3.ZERO:
			if has: acc = acc.merge(sub)
			else: acc = sub; has = true
	return acc
