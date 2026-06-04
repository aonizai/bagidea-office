extends RefCounted
## Equippable character auras — the Binbun "Elemental Magic FX" ground ring
## (CC0, binbun3d.itch.io), rebuilt programmatically from the pack's shaders.
## The pack's own scenes lean on class_name scripts which never register
## without an editor import pass, so this factory mirrors
## vfx_fire_area_01.tscn in code and recolors it per element.

const SHADER_DIR := "res://assets/BinbunVFX_Vol2/ElementalMagicFX/shader/"

## element -> [primary, secondary, tertiary(edge)]
const ELEMENTS := {
	"fire":   [Color(1.0, 0.8, 0.2), Color(1.0, 0.4, 0.1), Color(0.6, 0.1, 0.05)],
	"ice":    [Color(0.78, 0.96, 1.0), Color(0.3, 0.65, 1.0), Color(0.1, 0.2, 0.6)],
	"nature": [Color(0.72, 1.0, 0.42), Color(0.25, 0.8, 0.3), Color(0.05, 0.35, 0.12)],
	"arcane": [Color(1.0, 0.62, 1.0), Color(0.7, 0.3, 1.0), Color(0.3, 0.1, 0.6)],
	"shadow": [Color(0.6, 0.5, 0.9), Color(0.32, 0.14, 0.52), Color(0.08, 0.03, 0.2)],
	"gold":   [Color(1.0, 0.95, 0.6), Color(1.0, 0.78, 0.25), Color(0.6, 0.4, 0.05)],
}

static func has_assets() -> bool:
	return ResourceLoader.exists(SHADER_DIR + "area_ground.gdshader")

## Mirrors the FastNoiseLite setup baked into the pack's area scene.
static func _noise_tex() -> NoiseTexture2D:
	var n := FastNoiseLite.new()
	n.seed = 3
	n.fractal_type = 2
	n.fractal_octaves = 1
	n.fractal_weighted_strength = 1.0
	n.fractal_ping_pong_strength = 0.75
	n.cellular_distance_function = 1
	n.cellular_return_type = 3
	var t := NoiseTexture2D.new()
	t.generate_mipmaps = false
	t.seamless = true
	t.noise = n
	return t

static func _radial_gradient() -> GradientTexture2D:
	var g := Gradient.new()
	g.offsets = PackedFloat32Array([0.0, 0.661, 0.732, 1.0])
	g.colors = PackedColorArray([Color.BLACK, Color.WHITE, Color.WHITE, Color.BLACK])
	var t := GradientTexture2D.new()
	t.gradient = g
	t.width = 256
	t.height = 256
	t.fill = GradientTexture2D.FILL_RADIAL
	t.fill_from = Vector2(0.5, 0.5)
	t.fill_to = Vector2(0.5, 0.0)
	return t

static func _common(mat: ShaderMaterial, col: Array, noise: Texture2D) -> void:
	mat.set_shader_parameter("primary_color", col[0])
	mat.set_shader_parameter("secondary_color", col[1])
	mat.set_shader_parameter("tertiary_color", col[2])
	mat.set_shader_parameter("emission", 3.0)
	mat.set_shader_parameter("color_curve", 1.0)
	mat.set_shader_parameter("noise_texture", noise)
	mat.set_shader_parameter("noise_scale", Vector2(2, 1))
	mat.set_shader_parameter("noise_scroll", Vector2(0.1, 0.3))
	mat.set_shader_parameter("grow_amount", 1.0)
	mat.set_shader_parameter("edge_hardness", 0.0)
	mat.set_shader_parameter("edge_position", 0.2)

## Ground ring sized for a 1.7m character (the pack's original is r=1.4).
## Generous radius — it's jewelry, it should be seen.
static func build(element: String, radius := 0.85) -> Node3D:
	var col: Array = ELEMENTS.get(element, ELEMENTS["fire"])
	var s := radius / 1.4
	var noise := _noise_tex()
	var root := Node3D.new()
	root.name = "Aura"

	# Ground disc (the magic circle on the floor)
	var ground_mat := ShaderMaterial.new()
	ground_mat.shader = load(SHADER_DIR + "area_ground.gdshader")
	_common(ground_mat, col, noise)
	ground_mat.set_shader_parameter("gradient_texture", _radial_gradient())
	var ground := MeshInstance3D.new()
	var gq := QuadMesh.new()
	gq.size = Vector2(4.2, 4.2) * s
	gq.orientation = PlaneMesh.FACE_Y
	ground.mesh = gq
	ground.material_override = ground_mat
	ground.position.y = 0.012
	root.add_child(ground)

	# Rising flame walls (two cylinders, outer + inner flipped)
	var glow_mat := ShaderMaterial.new()
	glow_mat.shader = load(SHADER_DIR + "area_glow.gdshader")
	_common(glow_mat, col, noise)
	glow_mat.set_shader_parameter("shape_curve", 1.0)
	glow_mat.set_shader_parameter("stepped_animation", 0.0)
	glow_mat.set_shader_parameter("animation_steps", 20.0)

	var c1 := CylinderMesh.new()
	c1.top_radius = 1.6 * s
	c1.bottom_radius = 1.4 * s
	c1.height = 1.6 * s
	c1.radial_segments = 32
	c1.rings = 8
	c1.cap_top = false
	c1.cap_bottom = false
	var glow1 := MeshInstance3D.new()
	glow1.mesh = c1
	glow1.material_override = glow_mat
	glow1.position.y = 0.8 * s
	glow1.sorting_offset = 0.1
	root.add_child(glow1)

	var c2 := CylinderMesh.new()
	c2.flip_faces = true
	c2.top_radius = 1.4 * s
	c2.bottom_radius = 1.4 * s
	c2.height = 2.4 * s
	c2.radial_segments = 32
	c2.rings = 8
	c2.cap_top = false
	c2.cap_bottom = false
	var glow2 := MeshInstance3D.new()
	glow2.mesh = c2
	glow2.material_override = glow_mat
	glow2.position.y = 1.2 * s
	root.add_child(glow2)

	# Ember ring particles
	var pmat := ShaderMaterial.new()
	pmat.shader = load(SHADER_DIR + "projectile_particles.gdshader")
	pmat.set_shader_parameter("primary_color", col[0])
	pmat.set_shader_parameter("secondary_color", col[1])
	pmat.set_shader_parameter("tertiary_color", col[2])
	pmat.set_shader_parameter("noise_texture", noise)
	pmat.set_shader_parameter("noise_scale", Vector2(2, 1))
	pmat.set_shader_parameter("use_icon", false)

	var pp := ParticleProcessMaterial.new()
	pp.particle_flag_align_y = true
	pp.particle_flag_rotate_y = true
	pp.emission_shape = ParticleProcessMaterial.EMISSION_SHAPE_RING
	pp.emission_ring_axis = Vector3(0, 1, 0)
	pp.emission_ring_height = 0.1 * s
	pp.emission_ring_radius = radius
	pp.emission_ring_inner_radius = radius
	pp.emission_ring_cone_angle = 90.0
	pp.angle_min = -720.0
	pp.angle_max = 720.0
	pp.gravity = Vector3(0, 1.0 * s + 0.25, 0)
	pp.scale_min = 0.7
	pp.scale_max = 1.5
	var sc := Curve.new()
	sc.add_point(Vector2(0, 1))
	sc.add_point(Vector2(1, 0.5))
	var sct := CurveTexture.new()
	sct.curve = sc
	pp.scale_curve = sct
	var ramp := Gradient.new()
	ramp.offsets = PackedFloat32Array([0.385, 1.0])
	ramp.colors = PackedColorArray([Color.BLACK, col[1]])
	var rampt := GradientTexture1D.new()
	rampt.gradient = ramp
	pp.color_ramp = rampt
	var ac := Curve.new()
	ac.add_point(Vector2(0, 0))
	ac.add_point(Vector2(0.29, 1))
	ac.add_point(Vector2(1, 0))
	var act := CurveTexture.new()
	act.curve = ac
	pp.alpha_curve = act

	var parts := GPUParticles3D.new()
	parts.amount = 22
	parts.lifetime = 2.0
	parts.process_material = pp
	parts.material_override = pmat
	var dq := QuadMesh.new()
	dq.size = Vector2(0.3, 0.6) * (s * 1.6)
	parts.draw_pass_1 = dq
	parts.position.y = 0.2 * s
	root.add_child(parts)

	# Characters and their gear live on render layer 2 (map camera culls it)
	for child in root.get_children():
		if child is VisualInstance3D:
			child.layers = 2
			if child is GeometryInstance3D:
				child.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	return root
