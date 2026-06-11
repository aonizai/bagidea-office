shader_type spatial;
render_mode unshaded, blend_mix;

group_uniforms Color;
uniform vec3 primary_color : source_color;
uniform vec3 secondary_color : source_color;
uniform float emission = 4.0;
uniform float color_curve : hint_range(0.05, 32.0, 0.01) = 1.0;

group_uniforms Shape;
uniform sampler2D noise_texture;
uniform vec2 noise_scale = vec2(1.0);
uniform vec2 noise_scroll = vec2(0.0, 1.0);
uniform float flame_density : hint_range(0.0, 1.0, 0.01) = 0.5;
uniform vec3 flame_direction = vec3(0.0, 1.0, 0.0);

group_uniforms Wobble;
uniform float wobble_amount = 1.0;
uniform float wobble_frequency = 12.0;
uniform float wobble_scroll = 4.0;

group_uniforms Alpha;
uniform float edge_hardness : hint_range(0.0, 1.0, 0.01) = 0.9;
uniform float edge_position : hint_range(0.0, 1.0, 0.01) = 0.2;
uniform bool proximity_fade = false;
uniform float proximity_fade_distance : hint_range(0.0, 4096.0, 0.01);
uniform sampler2D depth_texture : hint_depth_texture, repeat_disable, filter_nearest;

group_uniforms Animation;
uniform float effect_amount : hint_range(0.0, 1.0, 0.01) = 1.0;
uniform float speed_scale = 1.0;

varying vec3 world_pos;
varying vec3 world_normal;

float overlay(float base, float blend){
	float limit = step(0.5, base);
	return mix(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), limit);
}

void vertex() {
	world_normal = (MODEL_MATRIX * vec4(NORMAL, 1.0)).xyz;
	
	// Billboard Mode: Enabled
	mat4 billboard = mat4(
			MAIN_CAM_INV_VIEW_MATRIX[0],
			MAIN_CAM_INV_VIEW_MATRIX[1],
			MAIN_CAM_INV_VIEW_MATRIX[2],
			MODEL_MATRIX[3]);
	
	MODELVIEW_MATRIX = VIEW_MATRIX * billboard;
	
	world_pos = (billboard * vec4(VERTEX, 1.0)).xyz;
}

void fragment() {
	float wobble = sin(world_pos.y * wobble_frequency - (TIME * wobble_scroll * speed_scale)) * (wobble_amount * 0.1);
	
	vec2 scroll = noise_scroll * TIME * speed_scale;
	
	vec2 world_xy_uv = ((world_pos.xy * noise_scale) + vec2(wobble, 0.0) - vec2(NORMAL.x * 0.3, 0.0)) * vec2(-sign(NORMAL.z), 1.0);
	vec2 world_zy_uv = ((world_pos.zy * noise_scale) + vec2(wobble, 0.0) + vec2(NORMAL.z * 0.3, 0.0)) * vec2(-sign(NORMAL.x), 1.0);
	
	float noise_xy_offset = texture(noise_texture, world_xy_uv * 0.5).r * 0.1;
	float noise_zy_offset = texture(noise_texture, world_zy_uv * 0.5).r * 0.1;
	
	float noise_xy = texture(noise_texture, world_xy_uv + vec2(0.0, noise_xy_offset) - scroll).r;
	float noise_zy = texture(noise_texture, world_zy_uv + vec2(0.0, noise_zy_offset) - scroll).r;
	
	float noise_mix = abs(NORMAL.x);
	float noise = mix(noise_xy, noise_zy, noise_mix);
	
	float mask = max((1.0 - length(UV * 2.0 - 1.0)) - (1.0 - COLOR.a), 0.0);
	float value = noise * mask;
	value += pow(mask, (1.0 - flame_density) * 8.0) * pow(COLOR.a, 8.0);
	
	value -= (1.0 - effect_amount);
	value = clamp(value, 0.0, 1.0);
	
	if(proximity_fade){
		float proximity_depth_tex = textureLod(depth_texture, SCREEN_UV, 0.0).r;
		vec4 ndc = OUTPUT_IS_SRGB ? vec4(vec3(SCREEN_UV, proximity_depth_tex) * 2.0 - 1.0, 1.0) : vec4(SCREEN_UV * 2.0 - 1.0, proximity_depth_tex, 1.0);
		vec4 proximity_view_pos = INV_PROJECTION_MATRIX * ndc;
		proximity_view_pos.xyz /= proximity_view_pos.w;
		value *= clamp(1.0 - smoothstep(proximity_view_pos.z + proximity_fade_distance, proximity_view_pos.z, VERTEX.z), 0.0, 1.0);
	}
	
	float r_edge = mix(1.0, edge_position + 0.01, edge_hardness);
	value = smoothstep(edge_position, r_edge, value);
	
	vec3 color = mix(primary_color, secondary_color, pow(COLOR.r, color_curve));
	
	ALBEDO = color * emission * (1.0 - COLOR.r);
	
	ALPHA = value;
	
}

//void light() {
//	// Called for every pixel for every light affecting the material.
//	// Uncomment to replace the default light processing function with this one.
//}
