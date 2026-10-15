// Gaussian blur: separable, 49 taps per axis, the radius in project pixels —
// identical at any render resolution.
import type { EffectDef } from './types'

// uDir carries one texel step along the pass axis; uRadius is the blur radius in
// pixels along that axis (taps spread out for big radii — 24 per side)
const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform vec2 uDir;
uniform float uRadius;
out vec4 outColor;
void main() {
  float sigma = max(0.35, uRadius * 0.5);
  float step = max(1.0, uRadius / 24.0);
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = -24; i <= 24; i++) {
    float off = float(i) * step;
    float w = exp(-0.5 * off * off / (sigma * sigma));
    acc += texture(uTex, vUV + uDir * off) * w;
    wsum += w;
  }
  outColor = acc / wsum;
}`

const blur: EffectDef = {
  id: 'blur',
  group: 'blur',
  name: { ru: 'Размытие', en: 'Blur' },
  params: {
    size: { kind: 'number', default: 20, min: 0, max: 300, step: 1, name: { ru: 'Интенсивность', en: 'Intensity' } }
  },
  // size as a fraction of project height, so the result is the same at any
  // render resolution; below 0.02 % it changes nothing
  active: (v, project) => (v.size as number) / Math.max(1, project.height) > 0.0002,
  run(ctx, v) {
    const { gl } = ctx
    const radius = Math.max(0, v.size as number) / Math.max(1, ctx.projectHeight) * ctx.height
    if (radius <= 0.2) return false
    const p = ctx.program('blur', BLUR_FS)
    gl.useProgram(p.prog)
    gl.uniform1i(p.u('uTex'), 0)
    gl.uniform1f(p.u('uRadius'), radius)
    gl.activeTexture(gl.TEXTURE0)
    // horizontal into scratch, vertical into the result
    const tmp = ctx.temp()
    gl.bindFramebuffer(gl.FRAMEBUFFER, tmp.fbo)
    gl.bindTexture(gl.TEXTURE_2D, ctx.src)
    gl.uniform2f(p.u('uDir'), 1 / ctx.width, 0)
    ctx.quad()
    gl.bindFramebuffer(gl.FRAMEBUFFER, ctx.out.fbo)
    gl.bindTexture(gl.TEXTURE_2D, tmp.tex)
    gl.uniform2f(p.u('uDir'), 0, 1 / ctx.height)
    ctx.quad()
    return true
  }
}
export default blur
