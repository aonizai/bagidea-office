extends Sprite3D
## Agent character v3. Uses real spritesheets when present:
##   - premade NPC sheets (4-direction idle + walk, assets/characters/npc/)
##   - composited custom characters (CharacterFactory, idle-only, tinted)
## Falls back to the original runtime-generated pixel sprite when the
## (license-restricted, gitignored) assets are missing — clones still run.
## Billboarded + shaded so sprites are lit by the 3D scene (HD-2D core trick).

@export var suit_color := Color8(38, 46, 76)
@export var hair_color := Color8(52, 38, 30)
@export var skin_color := Color8(236, 188, 152)
@export var tie_color := Color8(168, 52, 58)
## 1..12 = premade NPC sheet, 0 = composited custom, -1 = procedural fallback.
@export var npc_index := -1

const CharacterFactory := preload("res://scripts/character_factory.gd")
const WALK_SPEED := 1.6        # m/s
const IDLE_FPS := 5.0
const WALK_FPS := 9.0
const DIR_DOWN := 0
const DIR_RIGHT := 1
const DIR_UP := 2
const DIR_LEFT := 3

# --- procedural fallback art (original look) -------------------------------
const ART_IDLE: Array[String] = [
	"................",
	".....oooo.......",
	"....ohhhho......",
	"...ohHhhhho.....",
	"...ohhhhhho.....",
	"...offffffo.....",
	"...ofeffefo.....",
	"...offffffo.....",
	"....oFFFFo......",
	"...oswwwwso.....",
	"..osswttwsso....",
	"..osswttwsso....",
	"..ossswwssso....",
	"..osssssssso....",
	"..ofssssssfo....",
	"...oSSSSSSo.....",
	"...oppppppo.....",
	"...oppppppo.....",
	"...oppo.oppo....",
	"...oppo.oppo....",
	"...oppo.oppo....",
	"..obbbo.obbbo...",
	"................",
	"................",
]
const ART_WALK: Array[String] = [
	"................",
	".....oooo.......",
	"....ohhhho......",
	"...ohHhhhho.....",
	"...ohhhhhho.....",
	"...offffffo.....",
	"...ofeffefo.....",
	"...offffffo.....",
	"....oFFFFo......",
	"...oswwwwso.....",
	"..osswttwsso....",
	"..osswttwsso....",
	"..ossswwssso....",
	"..osssssssso....",
	"..ofssssssfo....",
	"...oSSSSSSo.....",
	"...oppppppo.....",
	"..oppo..oppo....",
	"..oppo...oppo...",
	".oppo.....oppo..",
	".oppo.....oppo..",
	"obbbo......obbbo",
	"................",
	"................",
]

var idle_pos := Vector3.ZERO
var _label: Label3D
var _walk_tween: Tween
var _t := 0.0
var _bob_speed := 2.2
var _walking := false
var _mode := "procedural"   # "npc" | "custom" | "procedural"
var _has_walk_rows := false
var _dir := DIR_DOWN
var _anim_t := 0.0
var _anim_frame := 0
var _last_pos := Vector3.ZERO
var _tex_idle: ImageTexture
var _tex_walk: ImageTexture

func _ready() -> void:
	_setup_visual()
	idle_pos = position
	_last_pos = position
	_t = randf() * TAU

	_label = Label3D.new()
	_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	_label.font_size = 64
	_label.outline_size = 16
	_label.pixel_size = 0.004
	_label.position = Vector3(0, 1.05, 0)
	_label.modulate = Color(0.75, 0.95, 1.0)
	add_child(_label)

func _setup_visual() -> void:
	if npc_index >= 1 and CharacterFactory.has_assets():
		var tex: ImageTexture = CharacterFactory.npc_texture(npc_index)
		if tex:
			texture = tex
			hframes = 4
			vframes = 8
			_mode = "npc"
			_has_walk_rows = true
			pixel_size = 0.045           # char ~36 px in a 64 px cell → ~1.6 m
			return
	if npc_index == 0 and CharacterFactory.has_assets():
		var tex: ImageTexture = CharacterFactory.custom_texture(skin_color, hair_color, suit_color, suit_color.darkened(0.4))
		if tex:
			texture = tex
			hframes = 4
			vframes = 4
			_mode = "custom"
			_has_walk_rows = false
			pixel_size = 0.045
			return
	_build_procedural()

func _build_procedural() -> void:
	var colors := {
		"o": Color8(18, 16, 22),
		"h": hair_color,
		"H": hair_color.lightened(0.25),
		"f": skin_color,
		"F": skin_color.darkened(0.16),
		"e": Color8(40, 40, 48),
		"s": suit_color,
		"S": suit_color.darkened(0.3),
		"w": Color8(225, 228, 235),
		"t": tie_color,
		"p": suit_color.darkened(0.4),
		"b": Color8(24, 22, 28),
	}
	_tex_idle = _bake(ART_IDLE, colors)
	_tex_walk = _bake(ART_WALK, colors)
	texture = _tex_idle
	hframes = 1
	vframes = 1
	_mode = "procedural"
	pixel_size = 0.07

func _bake(art: Array[String], colors: Dictionary) -> ImageTexture:
	var w: int = art[0].length()
	var h: int = art.size()
	var img := Image.create(w, h, false, Image.FORMAT_RGBA8)
	for y in h:
		var row := art[y]
		for x in w:
			var key := row[x]
			if colors.has(key):
				img.set_pixel(x, y, colors[key])
	return ImageTexture.create_from_image(img)

func _process(delta: float) -> void:
	# Facing follows actual movement.
	var v := position - _last_pos
	_last_pos = position
	if _walking and v.length() > 0.001:
		if absf(v.x) > absf(v.z):
			_dir = DIR_RIGHT if v.x > 0.0 else DIR_LEFT
		else:
			_dir = DIR_DOWN if v.z > 0.0 else DIR_UP

	# Idle bob (procedural only — sheet anims carry their own life).
	_t += delta * _bob_speed
	# Sheet art: +1 px lifts the baked-in cell margin so feet meet the floor.
	offset.y = (sin(_t) * 0.15) if _mode == "procedural" else 1.0

	match _mode:
		"npc", "custom":
			var fps := WALK_FPS if _walking else IDLE_FPS
			_anim_t += delta * fps
			if _anim_t >= 1.0:
				_anim_t = fmod(_anim_t, 1.0)
				_anim_frame = (_anim_frame + 1) % 4
			var row := _dir
			if _walking and _has_walk_rows:
				row += 4
			frame = row * 4 + _anim_frame
		"procedural":
			if _walking:
				_anim_t += delta
				if _anim_t >= 0.16:
					_anim_t = 0.0
					_anim_frame = 1 - _anim_frame
					texture = _tex_walk if _anim_frame == 1 else _tex_idle
			elif texture != _tex_idle:
				texture = _tex_idle

func set_status(text: String) -> void:
	_label.text = text

## Walk through waypoints (straight tween legs along the A* graph).
## Returns the total walk duration in seconds.
func walk_to(points: Array) -> float:
	if points.is_empty():
		return 0.0
	if _walk_tween:
		_walk_tween.kill()
	_walk_tween = create_tween()
	var from := position
	var total := 0.0
	for p in points:
		var leg_time: float = max(from.distance_to(p) / WALK_SPEED, 0.05)
		_walk_tween.tween_property(self, "position", p, leg_time)
		total += leg_time
		from = p
	_walking = true
	_bob_speed = 7.0
	_walk_tween.finished.connect(func():
		_bob_speed = 2.2
		_walking = false
		_dir = DIR_DOWN)  # face the camera when arriving
	return total
