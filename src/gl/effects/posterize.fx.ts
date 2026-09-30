// Posterize: each channel keeps only a few levels — flat bands of colour
// where there were gradients.
import type { EffectDef } from './types'

const posterize: EffectDef = {
  id: 'posterize',
  group: 'stylize',
  name: { ru: 'Постеризация', en: 'Posterize' },
  params: {
    levels: { kind: 'number', default: 4, min: 2, max: 16, step: 1, name: { ru: 'Уровней', en: 'Levels' } }
  },
  glsl: `
vec4 effect(vec4 c, vec2 uv) {
  float n = max(2.0, floor(u_levels + 0.5)) - 1.0;
  return vec4(floor(c.rgb * n + 0.5) / n, c.a);
}`
}
export default posterize
