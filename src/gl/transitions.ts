// Transition shader registry, gl-transitions style: each body defines
// `vec4 transition(vec2 uv)` and may use getFromColor/getToColor/progress/ratio
// (uv has a bottom-left origin, exactly like on gl-transitions.com).
import type { TKey } from '@/i18n'

export interface TransitionDef {
  id: string
  nameKey: TKey
  glsl: string
}

export const DEFAULT_TRANSITION = 'crossfade'

export const TRANSITIONS: TransitionDef[] = [
  {
    id: 'crossfade',
    nameKey: 'trCrossfade',
    glsl: `
vec4 transition(vec2 uv) {
  return mix(getFromColor(uv), getToColor(uv), progress);
}`
  },
  {
    id: 'dipToBlack',
    nameKey: 'trDipToBlack',
    glsl: `
vec4 transition(vec2 uv) {
  vec4 black = vec4(0.0, 0.0, 0.0, 1.0);
  return mix(
    mix(black, getFromColor(uv), smoothstep(0.6, 0.0, progress)),
    mix(black, getToColor(uv), smoothstep(0.4, 1.0, progress)),
    progress
  );
}`
  },
  {
    id: 'wipeRight',
    nameKey: 'trWipeRight',
    glsl: `
vec4 transition(vec2 uv) {
  float s = 0.03;
  float pp = mix(-s, 1.0 + s, progress);
  return mix(getToColor(uv), getFromColor(uv), smoothstep(pp - s, pp + s, uv.x));
}`
  },
  {
    id: 'wipeLeft',
    nameKey: 'trWipeLeft',
    glsl: `
vec4 transition(vec2 uv) {
  float s = 0.03;
  float pp = mix(-s, 1.0 + s, progress);
  return mix(getToColor(uv), getFromColor(uv), smoothstep(pp - s, pp + s, 1.0 - uv.x));
}`
  },
  {
    id: 'wipeUp',
    nameKey: 'trWipeUp',
    glsl: `
vec4 transition(vec2 uv) {
  float s = 0.03;
  float pp = mix(-s, 1.0 + s, progress);
  return mix(getToColor(uv), getFromColor(uv), smoothstep(pp - s, pp + s, uv.y));
}`
  },
  {
    id: 'wipeDown',
    nameKey: 'trWipeDown',
    glsl: `
vec4 transition(vec2 uv) {
  float s = 0.03;
  float pp = mix(-s, 1.0 + s, progress);
  return mix(getToColor(uv), getFromColor(uv), smoothstep(pp - s, pp + s, 1.0 - uv.y));
}`
  },
  {
    id: 'circleOpen',
    nameKey: 'trCircleOpen',
    glsl: `
vec4 transition(vec2 uv) {
  vec2 d = (uv - 0.5) * vec2(ratio, 1.0);
  float dist = length(d) / (0.5 * sqrt(ratio * ratio + 1.0));
  return mix(getToColor(uv), getFromColor(uv),
             smoothstep(progress - 0.05, progress + 0.05, dist));
}`
  },
  {
    id: 'circleClose',
    nameKey: 'trCircleClose',
    glsl: `
vec4 transition(vec2 uv) {
  vec2 d = (uv - 0.5) * vec2(ratio, 1.0);
  float dist = length(d) / (0.5 * sqrt(ratio * ratio + 1.0));
  float r = 1.0 - progress;
  return mix(getFromColor(uv), getToColor(uv),
             smoothstep(r - 0.05, r + 0.05, dist));
}`
  },
  {
    id: 'slideLeft',
    nameKey: 'trSlideLeft',
    glsl: `
vec4 transition(vec2 uv) {
  vec2 p = uv + vec2(progress, 0.0);
  if (p.x > 1.0) return getToColor(vec2(p.x - 1.0, p.y));
  return getFromColor(p);
}`
  },
  {
    id: 'slideRight',
    nameKey: 'trSlideRight',
    glsl: `
vec4 transition(vec2 uv) {
  vec2 p = uv - vec2(progress, 0.0);
  if (p.x < 0.0) return getToColor(vec2(p.x + 1.0, p.y));
  return getFromColor(p);
}`
  },
  {
    id: 'dissolve',
    nameKey: 'trDissolve',
    glsl: `
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}
vec4 transition(vec2 uv) {
  float r = hash(uv);
  float m = smoothstep(0.0, 0.1, progress * 1.1 - r);
  return mix(getFromColor(uv), getToColor(uv), m);
}`
  },
  {
    id: 'pixelize',
    nameKey: 'trPixelize',
    glsl: `
vec4 transition(vec2 uv) {
  float d = min(progress, 1.0 - progress);
  float dist = ceil(d * 20.0) / 20.0;
  vec2 squareSize = 2.0 * dist / vec2(40.0, 40.0 / ratio);
  vec2 p = dist > 0.0 ? (floor(uv / squareSize) + 0.5) * squareSize : uv;
  return mix(getFromColor(p), getToColor(p), progress);
}`
  },
  {
    id: 'zoom',
    nameKey: 'trZoom',
    glsl: `
vec2 zoomUv(vec2 uv, float amount) {
  return 0.5 + (uv - 0.5) * (1.0 - amount);
}
vec4 transition(vec2 uv) {
  float zf = smoothstep(0.0, 1.0, progress) * 0.85;
  return mix(getFromColor(zoomUv(uv, zf)), getToColor(uv),
             smoothstep(0.55, 1.0, progress));
}`
  },
  {
    id: 'radial',
    nameKey: 'trRadial',
    glsl: `
vec4 transition(vec2 uv) {
  const float PI = 3.141592653589;
  vec2 rp = uv * 2.0 - 1.0;
  return mix(
    getToColor(uv),
    getFromColor(uv),
    smoothstep(0.0, 1.0, atan(rp.y, rp.x) - (progress - 0.5) * PI * 2.5)
  );
}`
  }
]

export function transitionGlsl(id: string): string {
  return (TRANSITIONS.find((t) => t.id === id) ?? TRANSITIONS[0]).glsl
}
