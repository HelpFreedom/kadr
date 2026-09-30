// VHS: a played-out tape — scan lines, snow, lines that wobble sideways and
// colour that bleeds to the right of the picture. Moves by itself.
import type { EffectDef } from './types'

const vhs: EffectDef = {
  id: 'vhs',
  group: 'stylize',
  name: { ru: 'Кассета VHS', en: 'VHS tape' },
  params: {
    lines: { kind: 'number', default: 0.35, min: 0, max: 1, step: 0.02, name: { ru: 'Строки', en: 'Scan lines' } },
    noise: { kind: 'number', default: 0.25, min: 0, max: 1, step: 0.02, name: { ru: 'Шум', en: 'Noise' } },
    wobble: { kind: 'number', default: 0.3, min: 0, max: 1, step: 0.02, name: { ru: 'Дрожание', en: 'Wobble' } },
    bleed: { kind: 'number', default: 0.4, min: 0, max: 1, step: 0.02, name: { ru: 'Растекание цвета', en: 'Colour bleed' } }
  },
  timeDependent: true,
  glsl: `
vec4 effect(vec4 c, vec2 uv) {
  float frame = floor(uTime * 30.0);
  float row = floor(uv.y * uRes.y / 2.0);
  // each band of lines is pulled sideways a little, differently every frame,
  // plus a slow wave down the picture
  float dx = (hash12(vec2(row, frame)) - 0.5) * 0.012 * u_wobble
    + sin(uv.y * 40.0 + uTime * 6.0) * 0.002 * u_wobble;
  vec2 p = vec2(uv.x + dx, uv.y);
  float bl = 0.006 * u_bleed;
  vec4 m = texel(p);
  vec3 x = vec3(texel(p - vec2(bl, 0.0)).r, m.g, texel(p - vec2(bl * 0.5, 0.0)).b);
  float scan = 0.5 + 0.5 * sin(uv.y * uRes.y * 3.14159);
  x *= 1.0 - u_lines * 0.5 * scan;
  x += (hash12(uv * uRes + frame * 17.0) - 0.5) * u_noise * 0.35;
  return vec4(x, m.a);
}`
}
export default vhs
