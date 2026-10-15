// Solarize: every channel brighter than the threshold is turned upside down,
// as a photo exposed to light while developing — inverted highlights, strange
// edges where the tone crosses the threshold.
import type { EffectDef } from './types'

const solarize: EffectDef = {
  id: 'solarize',
  group: 'stylize',
  name: { ru: 'Соляризация', en: 'Solarize' },
  params: {
    threshold: { kind: 'number', default: 0.5, min: 0, max: 1, step: 0.01, name: { ru: 'Порог', en: 'Threshold' } },
    amount: { kind: 'number', default: 1, min: 0, max: 1, step: 0.02, name: { ru: 'Сила', en: 'Amount' } }
  },
  glsl: `
vec4 effect(vec4 c, vec2 uv) {
  vec3 s = mix(c.rgb, 1.0 - c.rgb, step(u_threshold, c.rgb));
  return vec4(mix(c.rgb, s, u_amount), c.a);
}`
}
export default solarize
