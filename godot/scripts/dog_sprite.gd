extends Sprite3D
## The office dog 🐕 — a REAL pixel-art pup from the free Pet Dogs Pack that
## wanders the cafe / rec room (walks, runs, sits, naps). Falls back to a tiny
## procedural dog if the pack is ever missing, so the world never breaks.

const DOGS_DIR := "res://assets/dogs/Pet Dogs Pack/"
const FRAME := 100          # each animation is a horizontal strip of 100x100 frames
const HX := 4.0             # wander half-extents around _home
const HZ := 2.6
const SPEED := 1.3

var _home := Vector2(0.0, 0.0)
var _tween: Tween
var _moving := false
var _t := 0.0
var _frame_t := 0.0
var _anims := {}            # name -> { tex, frames }
var _cur := ""
var _afps := 10.0
var _proc := false          # true = procedural fallback (pack missing)
var _oy_base := 0.0         # texture-px lift so feet sit on the floor (mode-dependent)
var _bob := 1.2             # bob amplitude in texture px

## Re-centre the roam area on a new room cell (called by world_builder on swap).
func set_home(c: Vector3) -> void:
	_home = Vector2(c.x, c.z)
	if _tween: _tween.kill()
	_moving = false
	position = Vector3(c.x, position.y, c.z)

func _ready() -> void:
	layers = 2  # moving prop — off the static map render
	billboard = BaseMaterial3D.BILLBOARD_ENABLED
	shaded = true
	alpha_cut = SpriteBase3D.ALPHA_CUT_DISCARD
	texture_filter = BaseMaterial3D.TEXTURE_FILTER_NEAREST
	vframes = 1
	if _load_breed():
		pixel_size = 0.014      # ~match the office cat's on-screen size (was too small)
		_oy_base = 38.0         # lift the centered 100px frame so paws meet the floor
		_bob = 4.0
		_set_anim("idle")
	else:
		_proc_setup()
	_roam_loop()

## Pick a random breed folder + load its key animations via the filesystem
## (Image.load on the globalized path → no Godot import step needed).
func _load_breed() -> bool:
	var d := DirAccess.open(DOGS_DIR)
	if d == null:
		return false
	var breeds: Array = []
	d.list_dir_begin()
	var n := d.get_next()
	while n != "":
		if d.current_is_dir() and n.begins_with("Dog-"):
			breeds.append(n)
		n = d.get_next()
	d.list_dir_end()
	if breeds.is_empty():
		return false
	var bdir: String = DOGS_DIR + String(breeds[randi() % breeds.size()]) + "/"
	var bd := DirAccess.open(bdir)
	if bd == null:
		return false
	var files: Array = []
	bd.list_dir_begin()
	var f := bd.get_next()
	while f != "":
		if f.to_lower().ends_with(".png"):
			files.append(f)
		f = bd.get_next()
	bd.list_dir_end()
	# match each anim by the word at the end of the filename (casing varies)
	for key in ["walk", "idle", "run", "sleeping", "sitting"]:
		for fn in files:
			if fn.to_lower().ends_with(key + ".png"):
				var tex := _load_tex(bdir + fn)
				if tex:
					_anims[key] = { "tex": tex, "frames": maxi(1, tex.get_width() / FRAME) }
				break
	return _anims.has("walk") or _anims.has("idle")

func _load_tex(p: String) -> ImageTexture:
	var img := Image.new()
	if img.load(ProjectSettings.globalize_path(p)) != OK:
		return null
	return ImageTexture.create_from_image(img)

func _set_anim(name: String) -> void:
	var pick := name
	if not _anims.has(pick):
		pick = "idle" if _anims.has("idle") else "walk"
	if not _anims.has(pick) or pick == _cur:
		return
	_cur = pick
	texture = _anims[pick].tex
	hframes = int(_anims[pick].frames)
	frame = 0
	_afps = 12.0 if pick == "run" else (10.0 if pick == "walk" else 6.0)

func _roam_loop() -> void:
	while is_inside_tree():
		await get_tree().create_timer(randf_range(1.5, 5.0)).timeout
		if not is_inside_tree():
			return
		var target := Vector3(
			_home.x + randf_range(-HX, HX),
			position.y,
			_home.y + randf_range(-HZ, HZ))
		flip_h = target.x < position.x  # strips face right
		var dist := position.distance_to(target)
		_moving = true
		if not _proc:
			_set_anim("run" if dist > 4.0 and _anims.has("run") else "walk")
		_tween = create_tween()
		_tween.tween_property(self, "position", target, dist / SPEED)
		await _tween.finished
		_moving = false
		if not _proc:
			# settle: usually idle, sometimes a cute sit / nap
			var r := randf()
			if r < 0.12 and _anims.has("sleeping"):
				_set_anim("sleeping")
			elif r < 0.30 and _anims.has("sitting"):
				_set_anim("sitting")
			else:
				_set_anim("idle")

func _process(delta: float) -> void:
	_t += delta * (10.0 if _moving else 3.0)
	offset.y = _oy_base + absf(sin(_t)) * (_bob if _moving else _bob * 0.3)
	if _proc:
		_proc_anim(delta)
		return
	if _cur != "" and hframes > 1:
		_frame_t += delta
		if _frame_t >= 1.0 / _afps:
			_frame_t = 0.0
			frame = (frame + 1) % hframes

# ------------------------------------------------------------ procedural fallback
const TROT_A: Array[String] = [
	"..........oo..", ".........oBBo.", "oo.......oBBBo", ".oo.....ooBeBo",
	"..oBBBBBBBBBo.", "..oBBBBBBBBBo.", "..oBbBBBBbBo..", "..oBo....oBo..",
	"..oBo....oBo..", "..............",
]
const TROT_B: Array[String] = [
	"..........oo..", ".........oBBo.", "oo.......oBBBo", ".oo.....ooBeBo",
	"..oBBBBBBBBBo.", "..oBBBBBBBBBo.", "..oBbBBBBbBo..", ".oBo......oBo.",
	"...oBo..oBo...", "..............",
]
var _tex_a: ImageTexture
var _tex_b: ImageTexture
var _pframe := 0

func _proc_setup() -> void:
	_proc = true
	var colors := { "o": Color8(28, 20, 14), "B": Color8(158, 106, 62),
		"b": Color8(224, 196, 156), "e": Color8(22, 22, 28) }
	_tex_a = _bake(TROT_A, colors)
	_tex_b = _bake(TROT_B, colors)
	texture = _tex_a
	hframes = 1
	pixel_size = 0.05

func _bake(art: Array[String], colors: Dictionary) -> ImageTexture:
	var img := Image.create(art[0].length(), art.size(), false, Image.FORMAT_RGBA8)
	for y in art.size():
		for x in art[y].length():
			if colors.has(art[y][x]):
				img.set_pixel(x, y, colors[art[y][x]])
	return ImageTexture.create_from_image(img)

func _proc_anim(delta: float) -> void:
	if _moving:
		_frame_t += delta
		if _frame_t >= 0.14:
			_frame_t = 0.0
			_pframe = 1 - _pframe
			texture = _tex_b if _pframe == 1 else _tex_a
	elif texture != _tex_a:
		texture = _tex_a
