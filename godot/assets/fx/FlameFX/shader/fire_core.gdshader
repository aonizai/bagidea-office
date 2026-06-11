shader_type spatial;
render_mode unshaded, blend_mix;

group_uniforms Color;
uniform vec3 primary_color : source_color;
uniform vec3 secondary_color : source_color;
uniform float emission = 4.0;

group_uniforms Shape;
uniform sampler2D noise_texture;
uniform vec2 noise_scale = vec2(1.0);
uniform vec2 noise_scroll = vec2(0.0, 1.0);
uniform vec2 flame_scale = vec2(1.0);

group_uniforms Alpha;
uniform float edge_hardness : hint_range(0.0, 1.0, 0.01) = 0.9;
uniform float edge_position : hint_range(0.0, 1.0, 0.01) = 0.2;
uniform bool proximity_fade = false;
uniform float proximity_fade_distance : hint_range(0.0, 4.0, 0.01);
uniform sampler2D depth_texture : hint_depth_texture, repeat_disable, filter_nearest;

group_uniforms Animation;
uniform float effect_amount : hint_range(0.0, 1.0, 0.01) = 1.0;
uniform float speed_scale = 1.0;

float overlay(float base, float blend){
	float limit = step(0.5, base);
	return mix(2.0 * base * blend, 1.0 - 2.0 * (1.0 - base) * (1.0 - blend), limit);
}

void vertex() {
	// Billboard Mode: Enabled
	mat4 billboard = mat4(
			MAIN_CAM_INV_VIEW_MATRIX[0],
			MAIN_CAM_INV_VIEW_MATRIX[1],
			MAIN_CAM_INV_VIEW_MATRIX[2],
			MODEL_MATRIX[3]);
	
	MODELVIEW_MATRIX = VIEW_MATRIX * billboard;
}

void fragment() {
	vec2 scroll = noise_scroll * TIME * speed_scale;
	
	float mask = max(1.0 - length(UV * 2.0 - 1.0), 0.0);
	
	float noise = texture(noise_texture, (UV * flame_scale * noise_scale) - vec2(NORMAL.x * 0.3, 0.0) + scroll).r;
	float value = mask * 4.0 - (1.0 - noise);
	value = value / 4.0;
	
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
	
	vec3 color = primary_color;
	
	ALBEDO = color * emission;
	ALPHA = value;
}

//void light() {
//	// Called for every pixel for every light affecting the material.
//	// Uncomment to replace the default light processing function with this one.
//}
