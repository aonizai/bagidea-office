@tool
extends VFXEmitterBB
class_name VFXFireBB

var audio_stream_player : AudioStreamPlayer3D:
	get():
		if audio_stream_player:
			return audio_stream_player
		
		var result = get_node_or_null("AudioStreamPlayer3D")
		
		if !Engine.is_editor_hint():
			audio_stream_player = result
		
		return result

var light : OmniLight3D:
	get():
		if light:
			return light
		
		var result = get_node_or_null("OmniLight3D")
		
		if !Engine.is_editor_hint():
			light = result
		
		return result

var core : MeshInstance3D:
	get():
		if core:
			return core
		
		var result = get_node_or_null("Core")
		
		if !Engine.is_editor_hint():
			core = result
		
		return result

var quad_mesh : QuadMesh:
	get():
		if quad_mesh:
			return quad_mesh
		
		var result_mesh = get_node_or_null("Core")
		
		var result = null
		
		if result_mesh:
			result = result_mesh.mesh
		
		if !Engine.is_editor_hint():
			quad_mesh = result
		
		return result

@export_group("Color")

## The primary color of this effect. Controls what the color is at the core of the flames.
@export var primary_color : Color:
	set(v):
		primary_color = v
		_set_shader_param("primary_color", primary_color)

## The secondary color of this effect. Controls the color flames transition to at the top.
@export var secondary_color : Color:
	set(v):
		secondary_color = v
		_set_shader_param("secondary_color", secondary_color)

## Emission of the effect. Higher values make it glowy.
@export var emission : float = 6.0:
	set(v):
		emission = v
		_set_shader_param("emission", emission)

## Controls the curve of the transition from [code]primary_color[/code] to [code]secondary_color[/code]
@export_exp_easing("inout") var color_curve : float = 1.0:
	set(v):
		color_curve = v
		_set_shader_param("color_curve", color_curve)

@export_group("Light")

## Color of the emitted light of this effect
@export var light_color : Color:
	set(v):
		light_color = v
		if light: light.light_color = light_color

## Energy of the emitted light of this effect
@export var light_energy : float = 5.0:
	set(v):
		light_energy = v
		if light: light.vfx_light_energy = light_energy

## Energy of the indirect light emitted by this effect
@export var light_indirect_energy : float = 1.0:
	set(v):
		light_indirect_energy = v
		if light: light.vfx_light_indirect_energy = light_indirect_energy

## Energy of the light in volumetric fog emitted by this effect
@export var light_volumetric_fog_energy : float = 1.0:
	set(v):
		light_volumetric_fog_energy = v
		if light: light.vfx_light_volumetric_fog_energy = light_volumetric_fog_energy

@export_group("Shape")

## The noise texture that's used for the shape of this effect.
## [br][br]
## The entire effect is based on this noise texture, so the biggest changes can be achieved with it.
## Note that it is suggested to use a seamless texture (for Godot's NoiseTexture you can enable [code]seamless[/code]) for best results.
@export var noise_texture : Texture2D:
	set(v):
		noise_texture = v
		_set_shader_param("noise_texture", noise_texture)

## Value used to scale the [code]noise_texture[/code]. Higher values make the noise more zoomed out.
## [br][br]
## If you're looking to change the size of the effect itself take a look at [code]flame_scale[/code]
@export var noise_scale : Vector2 = Vector2(1.0,1.0):
	set(v):
		noise_scale = v
		_set_shader_param("noise_scale", noise_scale)

## The velocity at which the [code]noise_texture[/code] moves.
## [br][br]
## Controls essentially the speed of the flames.
@export var noise_scroll : Vector2 = Vector2(0.0,1.0):
	set(v):
		noise_scroll = v
		_set_shader_param("noise_scroll", noise_scroll)

## Controls the density of the flames. Higher values look more dense
@export_range(0.1, 1.0, 0.01) var flame_density : float = 0.5:
	set(v):
		flame_density = v
		_set_shader_param("flame_density", flame_density)

## Controls the size of meshes used in this effect. Use this to make your flames wider and bigger.
@export var flame_scale : Vector2 = Vector2(1.0,1.0):
	set(v):
		flame_scale = v
		if quad_mesh: quad_mesh.size = flame_scale
		_set_shader_param("flame_scale", flame_scale)

## The effect has an extra part at the root of the flame used to make the root of the flames look more stable.
## Use this to hide it.
@export var hide_core : bool = false:
	set(v):
		hide_core = v
		if core: core.visible = !hide_core

@export_group("Particles")

## Amount of particles used by this effect.
## [br][br]
## Since this effect samples the [code]noise_texture[/code] using world coordinates,
## the amount of particles won't have a big effect on the style of the flames. Increase this if the effect looks jittery.
## Turning it down a bit might give a slight performance boost.
@export var particles_amount : int = 32:
	set(v):
		particles_amount = v
		_set_particle_param("amount", particles_amount)

## Lifetime of the flame particles.
## [br][br]
## Increasing this will make the flames go higher.
@export var lifetime : float = 1.0:
	set(v):
		lifetime = v
		_set_particle_param("lifetime", lifetime)

## Explosiveness of the flame particles.
@export_range(0.0, 1.0, 0.01) var explosiveness : float = 0.0:
	set(v):
		explosiveness = v
		_set_shader_param("explosiveness", explosiveness)

@export_group("Wobble")

## Amount of wobble on the flames.
## [br][br]
## Controls how much the flames are distorted side to side.
@export_range(0.0, 1.0, 0.01, "or_greater") var wobble_amount : float = 0.5:
	set(v):
		wobble_amount = v
		_set_shader_param("wobble_amount", wobble_amount)

## Frequency of flame wobbling.
## [br][br]
## Controls the frequency of wobble on the flames. Higher values results in a tighter wave
@export var wobble_frequency : float = 12.0:
	set(v):
		wobble_frequency = v
		_set_shader_param("wobble_frequency", wobble_frequency)

## How fast the wave used to wobble the flames moves along the flames
## [br][br]
## Negative values move it downward.
@export var wobble_scroll : float = 4.0:
	set(v):
		wobble_scroll = v
		_set_shader_param("wobble_scroll", wobble_scroll)

@export_group("Transparency")

## Hardness of the edges of flames.
## [br][br]
## Setting this to [code]1.0[/code] might break the illusion of a continuous flame.
@export_range(0.0, 1.0, 0.01) var edge_hardness : float = 0.9:
	set(v):
		edge_hardness = v
		_set_shader_param("edge_hardness", edge_hardness)

## Position at which the edge is.
## [br][br]
## Higher values can make the effect look smaller
@export_range(0.0, 1.0, 0.01) var edge_position : float = 0.2:
	set(v):
		edge_position = v
		_set_shader_param("edge_position", edge_position)

## Proximity fade.
## [br][br]
## Can be performance intensive, but will also prevent effect from looking like it's clipping with surfaces
## Happens [b]before[/b] [code]edge_hardness[/code] is calculated, meaning the proximity fade will be taken
## into account.
@export var proximity_fade : bool = false:
	set(v):
		proximity_fade = v
		_set_shader_param("proximity_fade", proximity_fade)

## Distance of [code]proximity_fade[/code]
@export_range(0.0, 4.0, 0.01) var proximity_fade_distance : float = 0.5:
	set(v):
		proximity_fade_distance = v
		_set_shader_param("proximity_fade_distance", proximity_fade_distance)

@export_group("Audio")

## Audio stream used for the effect. Other audio related settings are the same as with AudioStreamPlayer3D
@export var audio_stream : AudioStream:
	set(v):
		audio_stream = v
		if audio_stream_player: audio_stream_player.stream = audio_stream

@export var attenuation_model : AudioStreamPlayer3D.AttenuationModel:
	set(v):
		attenuation_model = v
		if audio_stream_player: audio_stream_player.attenuation_model = attenuation_model

var volume_animation : float = 1.0

## When enabled, will fade audio based on VFXEmitterBB parameter [code]emitting[/code]
## Does not affect [code]audio_playing[/code]
@export var animate_volume : bool = true

@export_range(-80.0, 80.0, 0.01, "suffix:dB") var volume_db : float = 0.0:
	set(v):
		volume_db = v
		if audio_stream_player: audio_stream_player.volume_db = lerpf(-24.0, volume_db, volume_animation)

@export_range(0.1, 100.0, 0.01) var unit_size : float = 10.0:
	set(v):
		unit_size = v
		if audio_stream_player: audio_stream_player.unit_size = unit_size

@export_range(-24.0, 6.0, 0.01, "suffix:dB") var max_db : float = 3.0:
	set(v):
		max_db = v
		if audio_stream_player: audio_stream_player.max_db = max_db

@export_range(0.01, 4.0, 0.01) var pitch_scale : float = 1.0:
	set(v):
		pitch_scale = v
		if audio_stream_player: audio_stream_player.pitch_scale = pitch_scale

@export var audio_playing : bool = false:
	set(v):
		audio_playing = v
		if audio_stream_player: audio_stream_player.playing = audio_playing

@export var autoplay : bool = false:
	set(v):
		autoplay = v
		if audio_stream_player: audio_stream_player.autoplay = autoplay

@export var stream_paused : bool = false:
	set(v):
		stream_paused = v
		if audio_stream_player: audio_stream_player.stream_paused = stream_paused

@export_range(0.0, 2000.0, 0.01, "suffix:m") var audio_max_distance : float = 3.0:
	set(v):
		audio_max_distance = v
		if audio_stream_player: audio_stream_player.max_distance = audio_max_distance

@export var max_polyphony : int = 1:
	set(v):
		max_polyphony = v
		if audio_stream_player: audio_stream_player.max_polyphony = max_polyphony

@export_range(0.0, 3.0, 0.01) var panning_strength : float = 1.0:
	set(v):
		panning_strength = v
		if audio_stream_player: audio_stream_player.panning_strength = panning_strength

@export var bus : StringName = &"Master":
	set(v):
		bus = v
		if audio_stream_player: audio_stream_player.bus = bus

@export_group("About")

@export_tool_button("Documentation", "ExternalLink") var docs_button : Callable:
	get():
		return func(): OS.shell_open("https://bun3d.com/assets/vfx/godot_flame_fx/#usage")

@export_tool_button("Rate This Effect!", "Favorites") var rate_asset_button : Callable:
	get():
		return func(): OS.shell_open("https://binbun3d.itch.io/flame-fx/rate")
