## Custom Character system: composites the layered Schwarnhild sheets
## (assets/characters/layers/*) into one tinted idle spritesheet.
## Layer order matters: legs → torso → shirt → head → eyes → hair.
##
## Images are loaded straight from disk (Image.load_from_file), so no Godot
## import step is needed and missing assets degrade gracefully.

const LAYER_DIR := "res://assets/characters/layers/"
const NPC_DIR := "res://assets/characters/npc/"

static var _npc_cache := {}
static var _custom_cache := {}

static func has_assets() -> bool:
	return FileAccess.file_exists(ProjectSettings.globalize_path(NPC_DIR + "npc1.png"))

## Premade NPC sheet (256x512: 4 frames x 8 rows = idle+walk, 4 directions).
static func npc_texture(index: int) -> ImageTexture:
	index = clampi(index, 1, 12)
	if _npc_cache.has(index):
		return _npc_cache[index]
	var img := Image.load_from_file(
		ProjectSettings.globalize_path(NPC_DIR + "npc%d.png" % index))
	if img == null:
		return null
	var tex := ImageTexture.create_from_image(img)
	_npc_cache[index] = tex
	return tex

## Composited custom character (256x256 idle-only: 4 frames x 4 directions).
## Tints multiply each layer, so identity colors survive into real art.
static func custom_texture(skin: Color, hair: Color, shirt: Color, pants: Color) -> ImageTexture:
	var key := "%s|%s|%s|%s" % [skin.to_html(), hair.to_html(), shirt.to_html(), pants.to_html()]
	if _custom_cache.has(key):
		return _custom_cache[key]
	var layers := [
		["legs-idle.png", pants],
		["torso-idle.png", skin],
		["shirt-idle.png", shirt],
		["head-idle.png", skin],
		["eyes-idle.png", Color.WHITE],
		["hair-idle.png", hair],
	]
	var out := Image.create(256, 256, false, Image.FORMAT_RGBA8)
	for layer in layers:
		var img := Image.load_from_file(
			ProjectSettings.globalize_path(LAYER_DIR + layer[0]))
		if img == null:
			continue
		img.convert(Image.FORMAT_RGBA8)
		var tint: Color = layer[1]
		if tint != Color.WHITE:
			_tint(img, tint)
		out.blend_rect(img, Rect2i(0, 0, 256, 256), Vector2i.ZERO)
	var tex := ImageTexture.create_from_image(out)
	_custom_cache[key] = tex
	return tex

static func _tint(img: Image, tint: Color) -> void:
	for y in img.get_height():
		for x in img.get_width():
			var c := img.get_pixel(x, y)
			if c.a > 0.0:
				img.set_pixel(x, y, Color(c.r * tint.r, c.g * tint.g, c.b * tint.b, c.a))
