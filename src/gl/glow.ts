// Outer-glow effect: a clip layer is rendered into an offscreen buffer, its
// alpha silhouette is blurred into a low-res "field", and the composite pass
// turns that field into a smoky, particle-laden halo emanating from the
// object's edges. All parameters are user-adjustable; time comes from the
// clip-local clock so preview and export render identical smoke.

/** Blurred-silhouette field pass: golden-angle spiral disc blur of alpha. */
export const GLOW_FIELD_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;   // full-res layer (premultiplied)
uniform float uSize;      // glow radius as a fraction of frame height
uniform float ratio;
out vec4 outColor;
void main() {
  float acc = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 32; i++) {
    float fi = (float(i) + 0.5) / 32.0;
    float r = sqrt(fi);            // even disc coverage
    float an = fi * 80.39997;      // 32 × golden angle — no axis banding
    vec2 off = vec2(cos(an) / ratio, sin(an)) * (r * uSize);
    float w = 1.0 - 0.8 * fi;      // center-weighted falloff
    acc += texture(uTex, vUV + off).a * w;
    wsum += w;
  }
  outColor = vec4(acc / wsum, 0.0, 0.0, 1.0);
}`

/** Composite pass: field → smoky colored halo drawn under the layer. */
export const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uField; // blurred silhouette (low-res, linear-filtered)
uniform sampler2D uTex;   // the layer itself, suppresses glow inside it
uniform vec3 uColor;
uniform float uSize;      // fraction of frame height
uniform float uIntensity;
uniform float uSat;
uniform float uSmoke;     // 0 = clean even halo … 1 = full smoke breakup
uniform float uSpeed;
uniform float uParticles;
uniform float uTime;
uniform float ratio;
out vec4 outColor;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x),
             mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
// octaves are rotated between levels — otherwise the grid of the value
// noise lines up and the smoke reads as straight ripples
const mat2 ROT = mat2(0.80, 0.60, -0.60, 0.80);
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = ROT * p * 2.07 + vec2(11.3, 7.1); a *= 0.5; }
  return s;
}
// billowy variant: folded creases; inverted it gives round puffy lobes
float bfbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * abs(2.0 * vnoise(p) - 1.0); p = ROT * p * 2.11 + vec2(5.7, 13.9); a *= 0.5; }
  return s;
}

void main() {
  float src = texture(uTex, vUV).a;
  // noise coordinates scale with the glow size so clouds read at its scale
  float sc = 2.2 / clamp(uSize, 0.02, 0.6);
  vec2 p = (vUV - 0.5) * vec2(ratio, 1.0) * sc;
  float tt = uTime * uSpeed;

  // slow billow field; it drags the halo lookup around so the boundary is
  // ragged and tendrils wander far past the blur radius
  vec2 w1 = vec2(
    fbm(p * 0.5 + vec2(0.11 * tt, -0.07 * tt)),
    fbm(p * 0.5 + vec2(-0.08 * tt, 0.09 * tt) + vec2(31.4, 17.2))
  );
  vec2 warp = (w1 - 0.5) * (uSmoke * uSize * 0.9) * vec2(1.0 / ratio, 1.0);
  vec2 fuv = vUV + warp;
  float f = texture(uField, fuv).r;
  if (f < 0.002) { outColor = vec4(0.0); return; }

  // outward direction = downhill gradient of the field (away from the object)
  vec2 e = vec2(0.008 / ratio, 0.008);
  vec2 outw = vec2(
    texture(uField, fuv - vec2(e.x, 0.0)).r - texture(uField, fuv + vec2(e.x, 0.0)).r,
    texture(uField, fuv - vec2(0.0, e.y)).r - texture(uField, fuv + vec2(0.0, e.y)).r
  );
  outw /= length(outw) + 1e-4;

  // taper everything to zero at the outer rim — no hard radius line
  float fade = smoothstep(0.0, 0.10, f);

  // base halo: lift the blurred silhouette into a soft falloff
  float halo = pow(clamp(f * 1.35, 0.0, 1.0), 1.6);

  // macro envelope: very low-frequency breathing around the silhouette —
  // some stretches barely smoulder while others belch smoke far out
  float mac = fbm(p * 0.33 + vec2(0.06 * tt, -0.045 * tt) + vec2(71.3, 23.7));
  float env = 0.4 + 1.2 * pow(smoothstep(0.28, 0.78, mac), 1.3);

  // cloud body: billow lobes stay bright, thin creases go dark — round
  // puffy clumps, warped a second time and drifting outward
  float n = bfbm(p * 0.95 + 2.6 * (w1 - 0.5) - outw * (0.4 * tt) + vec2(37.7, 11.3));
  float clouds = smoothstep(0.16, 0.68, n);
  float body = halo * (0.3 + 0.95 * clouds);

  // flakes: clumps that tear off the outer edge and float away on their own
  float nf = bfbm(p * 2.3 - outw * (0.9 * tt) + 1.7 * (w1 - 0.5) + vec2(19.1, 5.5));
  float fz = smoothstep(0.015, 0.06, f) * (1.0 - smoothstep(0.45, 0.9, f));
  float flakes = smoothstep(0.45, 0.75, nf) * fz;

  // smoke off = clean classic glow; smoke on = uneven, clumpy, alive
  float band = clamp(f * (1.0 - f) * 4.0, 0.0, 1.0);
  float g = mix(halo, env * (0.25 * halo + 1.1 * body + 0.7 * flakes), uSmoke);
  float smoke = clouds; // particles below ride the cloud density

  // particles: round twinkling embers scattered by a cellular hash, carried
  // outward with the smoke — each cell may own one dot with its own radius,
  // brightness phase and position
  if (uParticles > 0.001) {
    vec2 pp = p * 7.0 - outw * (tt * 1.5) + vec2(91.7, 53.1);
    vec2 cell = floor(pp);
    float dots = 0.0;
    for (int dy = -1; dy <= 1; dy++)
    for (int dx = -1; dx <= 1; dx++) {
      vec2 c = cell + vec2(float(dx), float(dy));
      float own = step(hash(c + 31.7), 0.55);              // sparse population
      vec2 ctr = c + vec2(hash(c), hash(c + 19.19));
      float rr = 0.10 + 0.16 * hash(c + 7.7);
      float tw = 0.5 + 0.5 * sin(tt * (2.0 + 4.0 * hash(c + 3.3)) + hash(c) * 6.2832);
      dots += own * tw * smoothstep(rr, rr * 0.3, length(pp - ctr));
    }
    g += uParticles * dots * band * 2.0 * mix(1.0, 0.35 + 0.65 * smoke, uSmoke);
  }

  g *= fade * (1.0 - src) * uIntensity; // outer only — never over the object

  float lum = dot(uColor, vec3(0.299, 0.587, 0.114));
  vec3 col = clamp(mix(vec3(lum), uColor, uSat), 0.0, 1.0);
  // premultiplied, with the color slightly outrunning alpha for a hot core
  // soft filmic shoulder instead of a hard clamp — highlights keep texture
  g = g / (1.0 + 0.35 * g);
  outColor = vec4(col * min(g, 1.3), clamp(g, 0.0, 1.0) * 0.92);
}`

/** Per-draw uniforms of one glow instance, parsed from Effect.params. */
export interface GlowParams {
  color: [number, number, number]
  sizePx: number
  intensity: number
  saturation: number
  smoke: number
  speed: number
  particles: number
}

export const GLOW_DEFAULTS = {
  color: '#7fc4ff',
  size: 70,
  intensity: 1,
  saturation: 1,
  smoke: 0.65,
  speed: 1,
  particles: 0.5
}

/** Effect.params (with defaults) → shader-ready GlowParams. */
export function glowParams(params: Record<string, number | string>): GlowParams {
  const num = (k: keyof typeof GLOW_DEFAULTS) => {
    const v = params[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : (GLOW_DEFAULTS[k] as number)
  }
  const hex = typeof params.color === 'string' ? params.color : GLOW_DEFAULTS.color
  const v = parseInt(hex.replace('#', ''), 16)
  return {
    color: [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255],
    sizePx: num('size'),
    intensity: num('intensity'),
    saturation: num('saturation'),
    smoke: num('smoke'),
    speed: num('speed'),
    particles: num('particles')
  }
}
