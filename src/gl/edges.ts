// Edge ("tip") transition registry: cinematic single-clip effects in the
// After Effects / BorisFX style. Each body defines `vec4 edge(vec2 uv)` and
// may use the wrapper helpers:
//   getColor(uv)  — premultiplied source sample (clamped)
//   mir(uv)       — mirrored repeat, keeps motion blur free of black borders
//   specW(t)      — spectral RGB weights: tap chains smear into chromatic
//                   aberration along the motion path (the "RGB smooth" look)
//   easeC(q)      — continuous 0→1 ease whose slope peaks at the cut (q=0.5)
//   dEaseC(q)     — normalized velocity of easeC (0 at the ends, 1 at the cut)
//   vig(uv, k)    — cinematic corner falloff
//
// `progress` runs 0 → 1 across the whole junction with the cut at 0.5:
// the outgoing clip's tail plays 0 → 0.5, the incoming clip's head 0.5 → 1.
// Effects must be an identity at 0 and 1 and hit their peak at 0.5, so a
// hard cut between two clips at peak intensity reads as one seamless move.
import type { TKey } from '@/i18n'

export interface EdgeDef {
  id: string
  nameKey: TKey
  glsl: string
}

export const DEFAULT_EDGE_DURATION = 0.5

// whip pan: parabolic camera arc + speed-matched spectral motion blur + tilt
const whip = (dx: number, dy: number) => `
const vec2 DIR = vec2(${dx.toFixed(1)}, ${dy.toFixed(1)});
vec4 edge(vec2 uv) {
  vec2 PERP = vec2(-DIR.y, DIR.x);
  float e = easeC(progress);
  float vel = dEaseC(progress);
  // travel: one full screen, leaving on one side and arriving on the other
  float o = (progress < 0.5 ? e : e - 1.0) * 1.45;
  // parabolic arc — the camera swings instead of sliding on a rail
  float arc = 4.0 * e * (1.0 - e);
  vec2 base = DIR * o + PERP * 0.22 * arc;
  // camera-throw tilt, proportional to speed
  float ang = (progress < 0.5 ? 1.0 : -1.0) * vel * 0.14;
  vec2 ctr = vec2(0.5);
  vec2 q = (uv - ctr) * vec2(ratio, 1.0);
  q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * q;
  vec2 ruv = ctr + q / vec2(ratio, 1.0);
  // path derivative drives the blur vector (always tangent to the arc)
  vec2 v = (DIR * 1.45 + PERP * 0.88 * (1.0 - 2.0 * e)) * vel;
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(1e-5);
  float aAcc = 0.0;
  for (int i = 0; i < 22; i++) {
    float tt = float(i) / 21.0;
    vec3 w = specW(tt);
    vec4 c = getColor(mir(ruv + base + v * (tt - 0.5) * 0.75));
    acc += c.rgb * w; wsum += w; aAcc += c.a;
  }
  vec3 col = (acc / wsum) * (1.0 + vel * 0.12) * vig(uv, vel * 0.45);
  return vec4(col, aAcc / 22.0);
}`

export const EDGE_TRANSITIONS: EdgeDef[] = [
  {
    id: 'blurZoomIn',
    nameKey: 'edBlurZoomIn',
    glsl: `
vec4 edge(vec2 uv) {
  float e = easeC(progress);
  float vel = dEaseC(progress);
  // log-space zoom: constant perceived speed, continuous across the cut
  float z = progress < 0.5 ? exp(e * 1.9) : exp((e - 1.0) * 1.9);
  float blur = vel * 0.7;
  vec2 ctr = vec2(0.5);
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(1e-5);
  float aAcc = 0.0;
  for (int i = 0; i < 22; i++) {
    float tt = float(i) / 21.0;
    vec3 w = specW(tt);
    float s = z * (1.0 + (tt - 0.5) * blur);
    vec4 c = getColor(mir(ctr + (uv - ctr) / s));
    acc += c.rgb * w; wsum += w; aAcc += c.a;
  }
  vec3 col = acc / wsum;
  col *= 1.0 + vel * 0.32;       // exposure punch into the cut
  col *= vig(uv, vel * 0.6);     // cinematic corner falloff
  return vec4(col, aAcc / 22.0);
}`
  },
  {
    id: 'blurZoomOut',
    nameKey: 'edBlurZoomOut',
    glsl: `
vec4 edge(vec2 uv) {
  float e = easeC(progress);
  float vel = dEaseC(progress);
  float z = progress < 0.5 ? exp(-e * 1.8) : exp((1.0 - e) * 1.8);
  float blur = vel * 0.7;
  vec2 ctr = vec2(0.5);
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(1e-5);
  float aAcc = 0.0;
  for (int i = 0; i < 22; i++) {
    float tt = float(i) / 21.0;
    vec3 w = specW(tt);
    float s = z * (1.0 + (tt - 0.5) * blur);
    vec4 c = getColor(mir(ctr + (uv - ctr) / s));
    acc += c.rgb * w; wsum += w; aAcc += c.a;
  }
  vec3 col = (acc / wsum) * (1.0 + vel * 0.22);
  return vec4(col * vig(uv, vel * 0.6), aAcc / 22.0);
}`
  },
  {
    id: 'rgbSplit',
    nameKey: 'edRgbSplit',
    glsl: `
vec4 edge(vec2 uv) {
  float c = sin(progress * PI); c = pow(c, 1.1);
  vec2 ctr = vec2(0.5);
  float z = 1.0 + c * 0.2;             // zoom breathing
  vec2 d = normalize(vec2(1.0, 0.45)) * 0.17 * c;
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(1e-5);
  float aAcc = 0.0;
  for (int i = 0; i < 20; i++) {
    float tt = float(i) / 19.0;
    vec3 w = specW(tt);
    vec4 cc = getColor(mir(ctr + (uv - ctr) / z + d * (tt - 0.5) * 2.0));
    acc += cc.rgb * w; wsum += w; aAcc += cc.a;
  }
  vec3 col = (acc / wsum) * (1.0 + c * 0.18);
  return vec4(col * vig(uv, c * 0.35), aAcc / 20.0);
}`
  },
  { id: 'whipLeft', nameKey: 'edWhipLeft', glsl: whip(-1, 0) },
  { id: 'whipRight', nameKey: 'edWhipRight', glsl: whip(1, 0) },
  { id: 'whipUp', nameKey: 'edWhipUp', glsl: whip(0, 1) },
  { id: 'whipDown', nameKey: 'edWhipDown', glsl: whip(0, -1) },
  {
    id: 'spinBlur',
    nameKey: 'edSpinBlur',
    glsl: `
vec4 edge(vec2 uv) {
  float e = easeC(progress);
  float vel = dEaseC(progress);
  float ang = (progress < 0.5 ? e : e - 1.0) * 3.1;
  float z = 1.0 + vel * 0.45;          // zoom punch while spinning
  vec2 ctr = vec2(0.5);
  vec2 p0 = (uv - ctr) * vec2(ratio, 1.0);
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(1e-5);
  float aAcc = 0.0;
  for (int i = 0; i < 22; i++) {
    float tt = float(i) / 21.0;
    vec3 w = specW(tt);
    float a = ang + (tt - 0.5) * vel * 0.75;
    vec2 p = mat2(cos(a), -sin(a), sin(a), cos(a)) * p0;
    vec4 c = getColor(mir(ctr + p / vec2(ratio, 1.0) / z));
    acc += c.rgb * w; wsum += w; aAcc += c.a;
  }
  vec3 col = (acc / wsum) * (1.0 + vel * 0.25);
  return vec4(col * vig(uv, vel * 0.55), aAcc / 22.0);
}`
  },
  {
    id: 'flash',
    nameKey: 'edFlash',
    glsl: `
vec4 edge(vec2 uv) {
  float c = sin(progress * PI); c = pow(c, 1.4);
  vec2 ctr = vec2(0.5);
  float z = 1.0 + c * 0.16;
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(1e-5);
  float aAcc = 0.0;
  for (int i = 0; i < 14; i++) {
    float tt = float(i) / 13.0;
    vec3 w = specW(tt);
    float s = z * (1.0 + (tt - 0.5) * 0.34 * c);
    vec4 cc = getColor(mir(ctr + (uv - ctr) / s));
    acc += cc.rgb * w; wsum += w; aAcc += cc.a;
  }
  vec3 col = acc / wsum;
  // anamorphic streak: cool horizontal flare under a warm film flash
  vec3 streak = vec3(0.0);
  for (int i = 0; i < 12; i++) {
    float f = float(i) / 11.0 - 0.5;
    streak += getColor(mir(uv + vec2(f * 0.85 * c, 0.0))).rgb * (1.0 - abs(f) * 2.0);
  }
  col += streak / 6.0 * c * vec3(0.45, 0.6, 1.0) * 0.7;
  float wf = smoothstep(0.25, 0.95, c);
  col = mix(col * (1.0 + c * 0.35), vec3(1.0, 0.96, 0.88), wf);
  return vec4(col, mix(aAcc / 14.0, 1.0, wf));
}`
  },
  {
    id: 'glitch',
    nameKey: 'edGlitch',
    glsl: `
float h1(float n) { return fract(sin(n) * 43758.5453); }
vec4 edge(vec2 uv) {
  float c = sin(progress * PI); c = c * c;
  float tq = floor(progress * 30.0);   // stuttering time steps
  // two layers of horizontal bands with quantized jumps
  float b1 = floor(uv.y * 14.0);
  float b2 = floor(uv.y * 47.0);
  float j1 = (h1(b1 + tq * 13.7) - 0.5) * step(0.4, h1(b1 * 3.1 + tq)) * 0.75;
  float j2 = (h1(b2 + tq * 7.3) - 0.5) * step(0.7, h1(b2 * 1.7 + tq * 2.0)) * 0.25;
  vec2 p = uv + vec2((j1 + j2) * c, (h1(tq * 0.71) - 0.5) * 0.14 * c);
  float ca = 0.055 * c;
  vec4 mid = getColor(mir(p));
  vec3 col = vec3(
    getColor(mir(p + vec2(ca, 0.0))).r,
    mid.g,
    getColor(mir(p - vec2(ca, 0.0))).b
  );
  // thin scanlines crush in at the peak
  col *= 1.0 - 0.28 * c * step(0.5, fract(uv.y * 120.0));
  return vec4(col, mid.a);
}`
  },
  {
    id: 'stretch',
    nameKey: 'edStretch',
    glsl: `
vec4 edge(vec2 uv) {
  float c = sin(progress * PI); c = c * c;
  float po = clamp(progress * 2.0, 0.0, 1.0);
  float pin = clamp(progress * 2.0 - 1.0, 0.0, 1.0);
  // the tail winds up; the head lands with a damped jelly wobble
  float k = progress < 0.5
    ? po * po * po * po
    : exp(-3.8 * pin) * cos(pin * PI * 3.5) * (1.0 - pin * pin);
  float sy = 1.0 + k * 2.3;
  float sx = 1.0 / sqrt(max(0.35, sy)); // squash sideways — preserves "mass"
  float blur = c * 0.6 + abs(k) * 0.25;
  vec2 ctr = vec2(0.5);
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(1e-5);
  float aAcc = 0.0;
  for (int i = 0; i < 18; i++) {
    float tt = float(i) / 17.0;
    vec3 w = specW(tt);
    float s = 1.0 + (tt - 0.5) * blur;
    vec4 cc = getColor(mir(ctr + (uv - ctr) * vec2(1.0 / sx, 1.0 / (sy * s))));
    acc += cc.rgb * w; wsum += w; aAcc += cc.a;
  }
  vec3 col = (acc / wsum) * vig(uv, c * 0.3);
  return vec4(col, aAcc / 18.0);
}`
  },
  {
    id: 'lensWarp',
    nameKey: 'edLensWarp',
    glsl: `
vec4 edge(vec2 uv) {
  float c = sin(progress * PI); c = c * c;
  vec2 ctr = vec2(0.5);
  vec2 d = (uv - ctr) * vec2(ratio, 1.0);
  float r2 = dot(d, d);
  float z = 1.0 + c * 0.24;
  vec3 acc = vec3(0.0);
  vec3 wsum = vec3(1e-5);
  float aAcc = 0.0;
  for (int i = 0; i < 18; i++) {
    float tt = float(i) / 17.0;
    vec3 w = specW(tt);
    // per-tap warp strength = real lens dispersion: CA grows with radius
    float k = c * (2.2 + (tt - 0.5) * 1.2) * r2;
    vec4 cc = getColor(mir(ctr + d * (1.0 - k) / vec2(ratio, 1.0) / z));
    acc += cc.rgb * w; wsum += w; aAcc += cc.a;
  }
  vec3 col = (acc / wsum) * vig(uv, c * 0.5);
  return vec4(col, aAcc / 18.0);
}`
  }
]

export function edgeGlsl(id: string): string {
  return (EDGE_TRANSITIONS.find((e) => e.id === id) ?? EDGE_TRANSITIONS[0]).glsl
}
