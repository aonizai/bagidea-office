extends Node3D
## Root controller for the office floor: real-time day cycle, screenshot
## automation (--shot) and wallpaper mode (--wallpaper).

## hour → [sun pitch°, sun energy, sun color, sky color, ambient energy].
## Ambient must follow the clock too — light surroundings (grass, mountains)
## glow unnaturally at night otherwise.
const DAY_KEYS := [
	[0.0,  -40.0, 0.22, Color(0.5, 0.62, 1.0),  Color(0.05, 0.07, 0.16), 0.8],
	[6.0,  -40.0, 0.22, Color(0.5, 0.62, 1.0),  Color(0.05, 0.07, 0.16), 0.8],
	[7.5,  -24.0, 2.1,  Color(1.0, 0.74, 0.5),  Color(0.85, 0.62, 0.45), 1.4],
	[10.0, -42.0, 3.0,  Color(1.0, 0.93, 0.82), Color(0.55, 0.75, 1.0),  2.0],
	[15.0, -46.0, 3.0,  Color(1.0, 0.95, 0.85), Color(0.55, 0.75, 1.0),  2.0],
	[17.0, -26.0, 2.2,  Color(1.0, 0.66, 0.4),  Color(0.9, 0.55, 0.35),  1.5],
	[18.0, -40.0, 0.22, Color(0.5, 0.62, 1.0),  Color(0.07, 0.09, 0.2),  0.8],
	[24.0, -40.0, 0.22, Color(0.5, 0.62, 1.0),  Color(0.05, 0.07, 0.16), 0.8],
]

var _day_timer := 0.0
var _hour_override := -1.0
var _cli_pinned := false  # --hour=N beats replayed ui.daylight events

func _ready() -> void:
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--hour="):
			_hour_override = float(arg.split("=")[1])
			_cli_pinned = true
	$Sun.rotation_degrees = Vector3(-46.0, 150.0, 0.0)
	_apply_daylight()

	if "--shot" in OS.get_cmdline_user_args():
		_take_shot()

	_capture_map.call_deferred()

	# Splash floats logo-only over the desktop (transparent window). Going
	# opaque here would paint a black box for the whole blocking scene build
	# — flip only after the first real frame is on screen.
	_opaque_after_first_frame()

	if "--wallpaper" in OS.get_cmdline_user_args():
		# NB: borderless/fullscreen/opaque happen in _opaque_after_first_frame
		# — touching the window mid-load repaints the splash on black.
		# Wallpaper rung: 30 fps, NATIVE render + MSAA 2x — the measured sweet
		# spot (FSR upscale read as jaggies; 4x MSAA costs +10% GPU for little
		# visible gain at wallpaper distance).
		Engine.max_fps = 30
		get_viewport().scaling_3d_scale = 1.0
		get_viewport().msaa_3d = Viewport.MSAA_2X
		var env: Environment = $WorldEnvironment.environment
		env.ssao_enabled = false
		env.ssr_max_steps = 24
		# Volumetric froxel pipeline is the big GPU cost — at wallpaper rung
		# the fake beam cards carry the god-ray look on their own.
		env.volumetric_fog_enabled = false
		# Smaller shadow atlas + no DOF: invisible at wallpaper distance.
		RenderingServer.directional_shadow_atlas_set_size(2048, true)
		var cam: Camera3D = $CameraRig/Camera3D
		cam.attributes.dof_blur_far_enabled = false
		cam.attributes.dof_blur_near_enabled = false

## Manual atmosphere from the overlay: {"hour": 17.5} pins the clock for
## debugging/beauty shots; {"hour": "auto"} hands it back to real time.
func apply_daylight_event(evt: Dictionary) -> void:
	if _cli_pinned:
		return
	var h: Variant = evt.get("hour", "auto")
	_hour_override = float(h) if (h is float or h is int) else -1.0
	_apply_daylight()

func _opaque_after_first_frame() -> void:
	await RenderingServer.frame_post_draw
	get_viewport().transparent_bg = false
	DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_TRANSPARENT, false)
	if "--wallpaper" in OS.get_cmdline_user_args():
		DisplayServer.window_set_flag(DisplayServer.WINDOW_FLAG_BORDERLESS, true)
		DisplayServer.window_set_position(Vector2i.ZERO)
		DisplayServer.window_set_size(DisplayServer.screen_get_size())
	# Signal the shell that the scene is on screen — it holds the WorkerW
	# attach until now so the transparent splash survives the whole load.
	var flag := FileAccess.open(
		OS.get_environment("TEMP").path_join("bagidea_world_ready"), FileAccess.WRITE)
	if flag:
		flag.store_line(Time.get_datetime_string_from_system())

func _process(delta: float) -> void:
	_day_timer -= delta
	if _day_timer <= 0.0:
		_day_timer = 60.0  # re-evaluate once a minute
		_apply_daylight()

## Sun, sky and god-ray cards follow the machine's real local time (doc 3.4:
## lighting itself is a status display — glance at the office, read the day).
func _apply_daylight() -> void:
	var t := Time.get_time_dict_from_system()
	var hour: float = t.hour + t.minute / 60.0
	if _hour_override >= 0.0:
		hour = _hour_override
	var a: Array = DAY_KEYS[0]
	var b: Array = DAY_KEYS[DAY_KEYS.size() - 1]
	for i in DAY_KEYS.size() - 1:
		if hour >= DAY_KEYS[i][0] and hour <= DAY_KEYS[i + 1][0]:
			a = DAY_KEYS[i]
			b = DAY_KEYS[i + 1]
			break
	var f: float = 0.0 if b[0] == a[0] else (hour - a[0]) / (b[0] - a[0])
	var pitch: float = lerpf(a[1], b[1], f)
	var energy: float = lerpf(a[2], b[2], f)
	var sun_col: Color = a[3].lerp(b[3], f)
	var sky_col: Color = a[4].lerp(b[4], f)

	$Sun.rotation_degrees = Vector3(pitch, 150.0, 0.0)
	$Sun.light_energy = energy
	$Sun.light_color = sun_col
	var env: Environment = $WorldEnvironment.environment
	env.ambient_light_energy = lerpf(a[5], b[5], f)
	# Procedural sky is the IBL source (ambient + reflections) — keep its
	# colors on the clock so glossy floors mirror dawn/day/night correctly.
	if env.sky and env.sky.sky_material is ProceduralSkyMaterial:
		var sm: ProceduralSkyMaterial = env.sky.sky_material
		sm.sky_top_color = sky_col.darkened(0.25)
		sm.sky_horizon_color = sky_col.lightened(0.25)
		sm.ground_horizon_color = sky_col * Color(0.75, 0.8, 0.7)
	var world: Node3D = $World
	# Roofline clock + phase icon + the day/night particle shift.
	var phase := "day"
	if hour < 6.0 or hour >= 18.5:
		phase = "night"
	elif hour < 9.0:
		phase = "dawn"
	elif hour >= 16.5:
		phase = "dusk"
	var mins := int(round(fmod(hour, 1.0) * 60.0)) % 60
	world.update_clock("%02d:%02d" % [int(hour) % 24, mins], phase)
	world.set_night_life(phase == "night")
	if world.sky_mat:
		world.sky_mat.emission = sky_col
		world.sky_mat.albedo_color = sky_col
	for bm in world.beam_mats:
		bm.set_shader_parameter("strength", 0.18 * clampf(energy / 2.6, 0.0, 1.0))
		bm.set_shader_parameter("tint", Color(sun_col.r, sun_col.g, sun_col.b * 0.8))

## Orthographic top-down floorplan, rendered once into a SubViewport and
## shipped to the daemon — the overlay's live-map background. Extents MUST
## match overlay.html's MAP_* constants: x -11.29..17.29, z -11..14.
func _capture_map() -> void:
	await get_tree().create_timer(4.0).timeout  # world + runtime assets ready
	var vp := SubViewport.new()
	vp.size = Vector2i(800, 700)
	vp.render_target_update_mode = SubViewport.UPDATE_ONCE
	add_child(vp)
	var cam := Camera3D.new()
	cam.projection = Camera3D.PROJECTION_ORTHOGONAL
	cam.size = 25.0
	cam.cull_mask = 1  # world only — characters live on render layer 2
	cam.position = Vector3(3, 40, 1.5)
	cam.rotation_degrees = Vector3(-90, 0, 0)
	vp.add_child(cam)
	cam.current = true
	await RenderingServer.frame_post_draw
	await RenderingServer.frame_post_draw
	var img := vp.get_texture().get_image()
	vp.queue_free()
	var req := HTTPRequest.new()
	add_child(req)
	req.request_completed.connect(func(_r, _c, _h, _b): req.queue_free())
	req.request_raw("http://127.0.0.1:8787/map/bg", ["content-type: image/png"],
		HTTPClient.METHOD_POST, img.save_png_to_buffer())

func _take_shot() -> void:
	await get_tree().create_timer(2.5).timeout
	await RenderingServer.frame_post_draw
	var img := get_viewport().get_texture().get_image()
	var dir := ProjectSettings.globalize_path("res://").path_join("../shots")
	DirAccess.make_dir_recursive_absolute(dir)
	var path := dir.path_join("office_floor.png")
	img.save_png(path)
	print("screenshot saved: ", path)
	get_tree().quit()
