// The frame every single-pass effect is compiled into (see EffectDef.glsl).
// The layer buffer is premultiplied; the effect sees and returns straight
// colour, so keying and grading maths need no alpha bookkeeping.
import type { EffectDef } from './types'

export const uniformName = (param: string) => `u_${param}`

/** Params become GLSL identifiers: letters, digits and _, not starting with a digit. */
export const validParamName = (k: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)

export function fxFragmentShader(def: EffectDef): string {
  const uniforms = Object.entries(def.params)
    .map(([k, d]) => `uniform ${d.kind === 'color' ? 'vec3' : 'float'} ${uniformName(k)};`)
    .join('\n')
  return `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float uTime;
uniform vec2 uRes;
uniform float uRatio;
${uniforms}
out vec4 outColor;

vec4 texel(vec2 uv) {
  vec4 p = texture(uTex, uv);
  return p.a > 0.0 ? vec4(p.rgb / p.a, p.a) : vec4(0.0);
}
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 rgb2hsv(vec3 c) {
  vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
  vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
  vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
  float d = q.x - min(q.w, q.y);
  return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + 1e-10)), d / (q.x + 1e-10), q.x);
}
vec3 hsv2rgb(vec3 c) {
  vec3 p = abs(fract(c.xxx + vec3(1.0, 2.0 / 3.0, 1.0 / 3.0)) * 6.0 - 3.0);
  return c.z * mix(vec3(1.0), clamp(p - 1.0, 0.0, 1.0), c.y);
}
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

${def.glsl}

void main() {
  vec4 c = clamp(effect(texel(vUV), vUV), 0.0, 1.0);
  outColor = vec4(c.rgb * c.a, c.a);
}`
}

/**
 * A compile log in the effect's own lines: the driver counts from the top of
 * the wrapped shader («ERROR: 0:33: …»), which says nothing to whoever wrote
 * the 5-line body.
 */
export function effectCompileError(def: EffectDef, log: string): string {
  const src = fxFragmentShader(def)
  const at = def.glsl ? src.indexOf(def.glsl) : -1
  if (at < 0) return log
  const offset = src.slice(0, at).split('\n').length - 1
  return log.replace(/\b0:(\d+):/g, (_, n: string) => `line ${Math.max(1, Number(n) - offset)}:`)
}

/** A short stable hash of a shader's source: part of its cache key. */
export function sourceHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}
