shader_type canvas_item;

// Cinematic focus pass — pulls the eye to the office at screen center.
// Tilt-shift style soft focus (mip-based, wallpaper-budget cheap), an
// elliptical vignette that slowly breathes, edge desaturation + a cool
// cast, a whisper of radial chromatic aberration, and soft anamorphic
// bars top/bottom. One fullscreen quad, three texture taps.

uniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap;
uniform vec2 focus_center = vec2(0.5, 0.47);
uniform float focus_radius : hint_range(0.0, 1.0) = 0.34; // fully sharp inside
uniform float focus_soft : hint_range(0.05, 1.0) = 0.45;  // falloff width
uniform float blur_max : hint_range(0.0, 5.0) = 2.4;      // mip levels at edge
uniform float vignette : hint_range(0.0, 1.0) = 0.45;
uniform float edge_desat : hint_range(0.0, 1.0) = 0.35;
uniform float edge_cool : hint_range(0.0, 1.0) = 0.25;
uniform float aberration : hint_range(0.0, 4.0) = 1.6;    // px of fringe at edge
uniform float breathe : hint_range(0.0, 1.0) = 0.6;       // vignette pulse
uniform float letterbox : hint_range(0.0, 1.0) = 0.30;    // anamorphic bars

void fragment() {
	float aspect = SCREEN_PIXEL_SIZE.y / SCREEN_PIXEL_SIZE.x;
	vec2 d = (SCREEN_UV - focus_center) * vec2(aspect, 1.0);
	float dist = length(d);

	// A slow breath so the frame feels alive rather than stamped on.
	float pulse = sin(TIME * 0.35) * 0.022 * breathe;
	float edge = smoothstep(focus_radius + pulse, focus_radius + focus_soft + pulse, dist);

	// Soft focus via mips; chromatic fringe grows with the blur.
	float lod = edge * blur_max;
	vec2 ca = normalize(d + vec2(1e-6)) * edge * aberration * SCREEN_PIXEL_SIZE;
	vec3 col;
	col.r = textureLod(screen_tex, SCREEN_UV + ca, lod).r;
	col.g = textureLod(screen_tex, SCREEN_UV, lod).g;
	col.b = textureLod(screen_tex, SCREEN_UV - ca, lod).b;

	// Edges fall away: drained colour, cooler cast, darker.
	float luma = dot(col, vec3(0.299, 0.587, 0.114));
	col = mix(col, vec3(luma), edge * edge_desat);
	col = mix(col, col * vec3(0.82, 0.90, 1.12), edge * edge_cool);
	col *= 1.0 - vignette * edge * edge;

	// Anamorphic bars: a soft gradient, not a hard crop.
	float bar = smoothstep(0.085, 0.0, SCREEN_UV.y) + smoothstep(0.915, 1.0, SCREEN_UV.y);
	col *= 1.0 - bar * letterbox;

	COLOR = vec4(col, 1.0);
}
