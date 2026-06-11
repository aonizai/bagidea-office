shader_type spatial;
render_mode unshaded, cull_disabled;

group_uniforms Color;
uniform vec3 primary_color : source_color;
uniform vec3 secondary_color : source_color;
uniform float emission = 4.0;
uniform float color_curve : hint_range(0.05, 32.0, 0.01) = 1.0;

group_uniforms Shape;
uniform sampler2D noise_texture;
uniform vec2 noise_scale = vec2(1.0);
uniform vec2 noise_scroll = vec2(0.0, 0.3);
uniform float edge_bottom : hint_range(0.0, 1.0, 0.01) = 0.1;
uniform float edge_top : hint_range(0.0, 1.0, 0.01) = 0.9;
//uniform float flame_density : hint_range(0.0, 1.0, 0.01) = 0.5;

group_uniforms Wobble;
uniform float wobble_amount = 1.0;
uniform float wobble_frequency = 12.0;
uniform float wobble_scroll = 4.0;

group_uniforms Displacement;
uniform float grow_offset = 0.03;
uniform float offset_animation = 0.02;

group_uniforms Animation;
uniform float effect_amount : hint_range(0.0, 1.0, 0.01) = 1.0;
uniform float speed_scale = 1.0;

varying vec3 world_pos;
varying vec3 world_normal;

float sample_wobble(float gradient) {
	return sin(gradient * wobble_frequency - (TIME * wobble_scroll * speed_scale));
}

void vertex() {
	VERTEX += NORMAL * grow_offset;
	
	world_pos = (MODEL_MATRIX * vec4(VERTEX, 1.0)).xyz;
	world_normal = (MODEL_NORMAL_MATRIX * NORMAL).xyz;
	
	VERTEX += NORMAL * (sample_wobble(world_pos.y) * 0.5 + 0.5) * offset_animation;
}

void fragment() {
	float wobble = sample_wobble(world_pos.y) * (wobble_amount * 0.1);
	
	vec2 scroll = noise_scroll * TIME * speed_scale;
	
	vec2 world_xy_uv = (world_pos.xy * noise_scale) + vec2(wobble, 0.0);
	vec2 world_zy_uv = (world_pos.zy * noise_scale) + vec2(wobble, 0.0);
	
	float noise_xy = texture(noise_texture, world_xy_uv - scroll).r;
	float noise_zy = texture(noise_texture, world_zy_uv - scroll).r;
	
	float noise_mix = abs(world_normal.x);
	float noise = mix(noise_xy, noise_zy, noise_mix);
	noise = max(noise_xy * abs(world_normal.z), noise_zy * abs(world_normal.x));
	
	float mask = world_normal.y * 0.5 + 0.5;
	mask = smoothstep(edge_bottom, edge_top, mask);
	
	noise = max(noise - mask, 0.0) + pow(1.0 - mask, 16.0) * 0.2;
	
	noise = smoothstep(0.1, 0.2, noise);
	
	float value = max(noise, (1.0 - mask) * 0.3);
	
	vec3 color = mix(secondary_color, primary_color, pow(1.0 - mask, color_curve));
	
	ALBEDO = color * emission;
	ALPHA = value * max(pow(dot(NORMAL, VIEW), 0.5),0.0);
}

//void light() {
//	// Called for every pixel for every light affecting the material.
//	// Uncomment to replace the default light processing function with this one.
//}
