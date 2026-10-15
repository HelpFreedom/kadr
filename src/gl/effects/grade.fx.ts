// Colour grade: the adjustments a clip needs before it sits with the others —
// exposure, white balance, contrast, saturation, black level, gamma. Neutral
// values change nothing, so the effect can be added and then tuned.
import type { EffectDef } from './types'

const grade: EffectDef = {
  id: 'grade',
  group: 'color',
  name: { ru: 'Цветокоррекция', en: 'Color grade' },
  params: {
    exposure: { kind: 'number', default: 0, min: -3, max: 3, step: 0.05, name: { ru: 'Экспозиция', en: 'Exposure' } },
    temperature: { kind: 'number', default: 0, min: -1, max: 1, step: 0.02, name: { ru: 'Температура', en: 'Temperature' } },
    tint: { kind: 'number', default: 0, min: -1, max: 1, step: 0.02, name: { ru: 'Оттенок', en: 'Tint' } },
    contrast: { kind: 'number', default: 1, min: 0, max: 2, step: 0.02, name: { ru: 'Контраст', en: 'Contrast' } },
    saturation: { kind: 'number', default: 1, min: 0, max: 2, step: 0.02, name: { ru: 'Насыщенность', en: 'Saturation' } },
    lift: { kind: 'number', default: 0, min: -0.5, max: 0.5, step: 0.01, name: { ru: 'Уровень чёрного', en: 'Black level' } },
    gamma: { kind: 'number', default: 1, min: 0.2, max: 3, step: 0.02, name: { ru: 'Гамма', en: 'Gamma' } }
  },
  // exposure in stops; temperature warms (+R −B) or cools, tint goes magenta
  // (−G) or green; contrast pivots on mid grey; the black level lifts (or
  // crushes) the shadows without moving white; gamma above 1 brightens mids
  glsl: `
vec4 effect(vec4 c, vec2 uv) {
  vec3 x = c.rgb * exp2(u_exposure);
  x *= vec3(1.0 + 0.25 * u_temperature, 1.0 - 0.25 * u_tint, 1.0 - 0.25 * u_temperature);
  x = (x - 0.5) * u_contrast + 0.5;
  x = mix(vec3(luma(x)), x, u_saturation);
  x = u_lift + x * (1.0 - u_lift);
  x = pow(max(x, 0.0), vec3(1.0 / u_gamma));
  return vec4(x, c.a);
}`
}
export default grade
