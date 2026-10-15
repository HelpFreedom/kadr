// Hue shift: turns every colour round the colour wheel by a fixed angle, and
// keeps turning at `speed` degrees a second for a cycling, acid look.
import type { EffectDef } from './types'

const hueShift: EffectDef = {
  id: 'hueShift',
  group: 'stylize',
  name: { ru: 'Сдвиг оттенка', en: 'Hue shift' },
  params: {
    degrees: { kind: 'number', default: 90, min: -180, max: 180, step: 1, name: { ru: 'Сдвиг, °', en: 'Shift, °' } },
    speed: { kind: 'number', default: 0, min: -720, max: 720, step: 5, name: { ru: 'Вращение, °/с', en: 'Cycle, °/s' } }
  },
  timeDependent: true,
  glsl: `
vec4 effect(vec4 c, vec2 uv) {
  vec3 h = rgb2hsv(c.rgb);
  h.x = fract(h.x + (u_degrees + u_speed * uTime) / 360.0);
  return vec4(hsv2rgb(h), c.a);
}`
}
export default hueShift
