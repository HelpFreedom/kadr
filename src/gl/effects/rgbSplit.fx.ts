// RGB split: the red and blue channels slide apart in opposite directions,
// the green stays — a steady chromatic fringe on the whole clip (the edge
// transition of the same name only flashes it at a cut).
import type { EffectDef } from './types'

const rgbSplit: EffectDef = {
  id: 'rgbSplit',
  group: 'stylize',
  name: { ru: 'RGB-сдвиг', en: 'RGB split' },
  params: {
    amount: { kind: 'number', default: 8, min: 0, max: 60, step: 0.5, name: { ru: 'Сдвиг, пикс.', en: 'Offset, px' } },
    angle: { kind: 'number', default: 0, min: 0, max: 360, step: 1, name: { ru: 'Направление, °', en: 'Direction, °' } }
  },
  glsl: `
vec4 effect(vec4 c, vec2 uv) {
  float a = radians(u_angle);
  vec2 off = vec2(cos(a), sin(a)) * u_amount / uRes;
  vec4 r = texel(uv + off), b = texel(uv - off);
  float alpha = max(c.a, max(r.a, b.a));
  // each channel keeps its own coverage, so the fringes show past the edge
  vec3 x = vec3(r.r * r.a, c.g * c.a, b.b * b.a) / max(alpha, 1e-4);
  return vec4(x, alpha);
}`
}
export default rgbSplit
