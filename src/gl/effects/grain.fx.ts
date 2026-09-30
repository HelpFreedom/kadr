// Film grain: fine noise over the picture, stronger in the mid-tones as on
// film; new every frame (24 a second) unless switched to still.
import type { EffectDef } from './types'

const grain: EffectDef = {
  id: 'grain',
  group: 'stylize',
  name: { ru: 'Зерно плёнки', en: 'Film grain' },
  params: {
    amount: { kind: 'number', default: 0.2, min: 0, max: 1, step: 0.01, name: { ru: 'Сила', en: 'Amount' } },
    size: { kind: 'number', default: 1, min: 0.5, max: 4, step: 0.1, name: { ru: 'Размер, пикс.', en: 'Size, px' } },
    animated: { kind: 'toggle', default: true, name: { ru: 'Живое зерно', en: 'Moving grain' } }
  },
  timeDependent: true,
  glsl: `
vec4 effect(vec4 c, vec2 uv) {
  vec2 cell = floor(uv * uRes / max(u_size, 0.5));
  float seed = u_animated > 0.5 ? floor(uTime * 24.0) : 0.0;
  float n = hash12(cell + seed * 37.0) - 0.5;
  float l = luma(c.rgb);
  float w = 4.0 * l * (1.0 - l);        // mid-tones carry the most grain
  return vec4(c.rgb + n * u_amount * (0.35 + 0.65 * w), c.a);
}`
}
export default grain
