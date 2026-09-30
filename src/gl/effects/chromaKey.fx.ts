// Chroma key: pixels near the key colour become transparent, with a soft edge
// and the key colour's spill taken out of what stays. The distance is measured
// in chroma only (YUV's U and V), so shadows and highlights of the screen key
// out with it; the colour is best picked from the preview (the eyedropper).
import type { EffectDef } from './types'

const chromaKey: EffectDef = {
  id: 'chromaKey',
  group: 'key',
  name: { ru: 'Хромакей', en: 'Chroma key' },
  params: {
    color: { kind: 'color', default: '#00ff00', pick: true, name: { ru: 'Цвет ключа', en: 'Key colour' } },
    similarity: { kind: 'number', default: 0.12, min: 0, max: 0.5, step: 0.005, name: { ru: 'Допуск', en: 'Similarity' } },
    softness: { kind: 'number', default: 0.06, min: 0, max: 0.3, step: 0.005, name: { ru: 'Мягкость края', en: 'Softness' } },
    spill: { kind: 'number', default: 0.8, min: 0, max: 1, step: 0.02, name: { ru: 'Подавление отсвета', en: 'Spill removal' } }
  },
  glsl: `
vec2 chroma(vec3 c) {
  return vec2(-0.169 * c.r - 0.331 * c.g + 0.5 * c.b, 0.5 * c.r - 0.419 * c.g - 0.081 * c.b);
}
vec4 effect(vec4 c, vec2 uv) {
  float d = distance(chroma(c.rgb), chroma(u_color));
  float keep = smoothstep(u_similarity, u_similarity + max(u_softness, 1e-4), d);
  // spill: the channel the key is made of may not exceed the larger of the
  // other two — green fringes and green light on skin go neutral
  vec3 x = c.rgb;
  float g = step(max(u_color.r, u_color.b), u_color.g);
  float b = (1.0 - g) * step(max(u_color.r, u_color.g), u_color.b);
  float r = (1.0 - g) * (1.0 - b);
  x.g = mix(x.g, min(x.g, max(x.r, x.b)), g * u_spill);
  x.b = mix(x.b, min(x.b, max(x.r, x.g)), b * u_spill);
  x.r = mix(x.r, min(x.r, max(x.g, x.b)), r * u_spill);
  return vec4(x, c.a * keep);
}`
}
export default chromaKey
