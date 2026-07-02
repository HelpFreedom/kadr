// Minimal WebGL2 layer compositor: draws textured quads with
// translate/scale/rotate/opacity onto the project canvas.
import { transitionGlsl } from './transitions'
import { edgeGlsl } from './edges'
import { GLOW_FIELD_FS, GLOW_FS, type GlowParams } from './glow'

const VS = `#version 300 es
layout(location=0) in vec3 aPos;   // NDC xy premultiplied by w, plus w
layout(location=1) in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  // homogeneous w gives perspective-correct texture interpolation for 3D
  gl_Position = vec4(aPos.xy, 0.0, aPos.z);
}`

const FS = `#version 300 es
precision mediump float;
const int MAX_SHAPES = 8;
in vec2 vUV;
uniform sampler2D uTex;
uniform int uRawBGRA;                  // 1 = premultiplied BGRA capture frame
uniform float uOpacity;
uniform vec4 uCrop;                    // left, top, right, bottom cut fractions
uniform int uShapeCount;
uniform int uShapeType[MAX_SHAPES];    // 1 rect, 2 ellipse, 3 triangle
uniform vec4 uShapeRect[MAX_SHAPES];   // cx, cy, halfW, halfH in UV
uniform vec3 uShapeFeather[MAX_SHAPES];// featherIn, featherOut, invert flag
uniform float uAspect;                 // layer width/height (aspect-correct distances)
out vec4 outColor;

float edgeDist(vec2 a, vec2 b, vec2 p) {
  vec2 e = b - a;
  return (e.x * (p.y - a.y) - e.y * (p.x - a.x)) / length(e);
}

void main() {
  if (vUV.x < uCrop.x || vUV.y < uCrop.y || vUV.x > 1.0 - uCrop.z || vUV.y > 1.0 - uCrop.w) {
    outColor = vec4(0.0);
    return;
  }
  vec4 c = texture(uTex, vUV);
  if (uRawBGRA == 1) {
    c = vec4(c.b, c.g, c.r, c.a);          // offscreen captures arrive BGRA…
    if (c.a > 0.0001) c.rgb /= c.a;        // …premultiplied; pipeline wants straight
  }
  float alpha = c.a * uOpacity;

  if (uShapeCount > 0) {
    float keep = 0.0;  // union of normal shapes
    float cut = 1.0;   // product of inverted (exclude) shapes
    bool hasKeep = false;
    for (int i = 0; i < MAX_SHAPES; i++) {
      if (i >= uShapeCount) break;
      // signed distance to the shape edge, negative inside (y-height units)
      vec2 p = (vUV - uShapeRect[i].xy) * vec2(uAspect, 1.0);
      vec2 b = max(uShapeRect[i].zw, vec2(1e-4)) * vec2(uAspect, 1.0);
      float d;
      if (uShapeType[i] == 1) {
        vec2 q = abs(p) - b;
        d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
      } else if (uShapeType[i] == 2) {
        d = (length(p / b) - 1.0) * min(b.x, b.y);
      } else {
        vec2 v0 = vec2(0.0, -b.y);
        vec2 v1 = vec2(b.x, b.y);
        vec2 v2 = vec2(-b.x, b.y);
        d = -min(min(edgeDist(v0, v1, p), edgeDist(v1, v2, p)), edgeDist(v2, v0, p));
      }
      float m = 1.0 - smoothstep(-uShapeFeather[i].x, uShapeFeather[i].y + 1e-4, d);
      if (uShapeFeather[i].z > 0.5) {
        cut *= 1.0 - m;
      } else {
        keep = max(keep, m);
        hasKeep = true;
      }
    }
    alpha *= (hasKeep ? keep : 1.0) * cut;
  }

  outColor = vec4(c.rgb, alpha);
}`

// pass-through VS for transition composites (fullscreen quad, w = 1)
const TRANS_VS = `#version 300 es
layout(location=0) in vec3 aPos;
layout(location=1) in vec2 aUV;
out vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = vec4(aPos.xy, 0.0, 1.0);
}`

// gl-transitions wrapper: the body defines vec4 transition(vec2 uv)
const transFS = (body: string) => `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float progress;
uniform float ratio;
uniform float uOpacity;
out vec4 outColor;
vec4 getFromColor(vec2 uv) { return texture(uFrom, clamp(uv, 0.0, 1.0)); }
vec4 getToColor(vec2 uv) { return texture(uTo, clamp(uv, 0.0, 1.0)); }
${body}
void main() {
  // FBO colors are premultiplied; keep the composite premultiplied too
  outColor = transition(vUV) * uOpacity;
}`

// edge ("tip") effect wrapper: one source texture, AE-style clip tail/head FX
const edgeFS = (body: string) => `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uTex;
uniform float progress;
uniform float ratio;
uniform float uOpacity;
out vec4 outColor;
const float PI = 3.14159265359;
vec2 mir(vec2 p) { return 1.0 - abs(mod(p, 2.0) - 1.0); }
vec4 getColor(vec2 uv) { return texture(uTex, clamp(uv, 0.0, 1.0)); }
// spectral weights: a tap chain smears into R→G→B chromatic aberration
vec3 specW(float tt) { return vec3(1.0 - tt, 1.0 - abs(2.0 * tt - 1.0), tt); }
// continuous 0→1 ease with maximum slope at the cut (progress = 0.5);
// quartic — long wind-up, then a violent snap through the splice
float easeC(float q) {
  return q < 0.5 ? 0.5 * pow(2.0 * q, 4.0) : 1.0 - 0.5 * pow(2.0 * (1.0 - q), 4.0);
}
// normalized velocity of easeC: 0 at both ends, 1 exactly at the cut
float dEaseC(float q) {
  float x = q < 0.5 ? 2.0 * q : 2.0 * (1.0 - q);
  return x * x * x;
}
// cinematic corner falloff, k = strength
float vig(vec2 uv, float k) {
  vec2 d = (uv - 0.5) * vec2(ratio, 1.0);
  return 1.0 - k * smoothstep(0.2, 0.85, length(d));
}
${body}
void main() {
  outColor = edge(vUV) * uOpacity;
}`

// plain copy used by the motion-blur accumulation
const BLIT_FS = `#version 300 es
precision mediump float;
in vec2 vUV;
uniform sampler2D uTex;
out vec4 outColor;
void main() { outColor = texture(uTex, vUV); }`

// Separable gaussian over the premultiplied layer FBO. uDir carries one
// texel step along the pass axis; uRadius is the blur radius in pixels
// along that axis (taps spread out for big radii — 24 per side).
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

export interface LayerDraw {
  source: TexImageSource | null
  /** raw BGRA premultiplied pixels (fragment capture) instead of `source` */
  raw?: { data: Uint8Array; w: number; h: number; version: number }
  /** id used to cache the GL texture between frames */
  cacheKey: string
  /** mark true when the source content changes every frame (video) */
  dynamic: boolean
  srcWidth: number
  srcHeight: number
  x: number
  y: number
  scale: number
  rotation: number // degrees (Z)
  opacity: number
  /** 3D: tilt angles (degrees) and depth offset in project px */
  rotX?: number
  rotY?: number
  z?: number
  /** whole-track motion applied after the clip transform */
  outer?: {
    x: number
    y: number
    scale: number
    rotation: number
    rotX: number
    rotY: number
    z: number
  }
  /** cut fractions [left, top, right, bottom], 0..1 */
  crop?: [number, number, number, number]
  shapes?: ShapeUniform[]
}

export interface ShapeUniform {
  type: 1 | 2 | 3 // rect | ellipse | triangle
  cx: number
  cy: number
  halfW: number
  halfH: number
  featherIn: number
  featherOut: number
  invert: boolean
}

export const MAX_SHAPES = 8

interface TexEntry {
  tex: WebGLTexture
  lastUsed: number
  /** raw-frame version already uploaded (skip identical re-uploads) */
  rawVersion?: number
}

interface TransProg {
  prog: WebGLProgram
  uProgress: WebGLUniformLocation
  uRatio: WebGLUniformLocation
  uOpacity: WebGLUniformLocation
}

interface Overlay {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
}

export class Compositor {
  readonly canvas: HTMLCanvasElement | OffscreenCanvas
  private gl: WebGL2RenderingContext
  private vbo: WebGLBuffer
  private prog: WebGLProgram
  private transProgs = new Map<string, TransProg>()
  private overlays: Overlay[] = []
  private overlaySize = 0
  /** current render destination: null = canvas, or the accumulation FBO */
  private target: WebGLFramebuffer | null = null
  /** what is bound right now (target or a transition overlay) — effect
      passes must restore this after detouring through their own FBOs */
  private curFbo: WebGLFramebuffer | null = null
  private blitProg: WebGLProgram | null = null
  // outer-glow buffers: full-res layer + low-res blurred silhouette field
  private fx: { layer: Overlay; field: Overlay; blur: Overlay; fw: number; fh: number } | null = null
  private fxSize = 0
  private blurProg: {
    prog: WebGLProgram
    uDir: WebGLUniformLocation
    uRadius: WebGLUniformLocation
  } | null = null
  private fieldProg: { prog: WebGLProgram; uSize: WebGLUniformLocation; uRatio: WebGLUniformLocation } | null = null
  private glowProg: {
    prog: WebGLProgram
    u: Record<'uColor' | 'uSize' | 'uIntensity' | 'uSat' | 'uSmoke' | 'uSpeed' | 'uParticles' | 'uTime' | 'ratio', WebGLUniformLocation>
  } | null = null
  private uOpacity: WebGLUniformLocation
  private uRawBGRA: WebGLUniformLocation
  private uCrop: WebGLUniformLocation
  private uShapeCount: WebGLUniformLocation
  private uShapeType: WebGLUniformLocation
  private uShapeRect: WebGLUniformLocation
  private uShapeFeather: WebGLUniformLocation
  private uAspect: WebGLUniformLocation
  private textures = new Map<string, TexEntry>()
  private frame = 0
  width = 0
  height = 0

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      preserveDrawingBuffer: true,
      desynchronized: true
    }) as WebGL2RenderingContext | null
    if (!gl) throw new Error('WebGL2 is not available')
    this.gl = gl

    const prog = this.buildProgram(VS, FS)
    this.prog = prog
    this.uOpacity = gl.getUniformLocation(prog, 'uOpacity')!
    this.uRawBGRA = gl.getUniformLocation(prog, 'uRawBGRA')!
    this.uCrop = gl.getUniformLocation(prog, 'uCrop')!
    this.uShapeCount = gl.getUniformLocation(prog, 'uShapeCount')!
    this.uShapeType = gl.getUniformLocation(prog, 'uShapeType[0]')!
    this.uShapeRect = gl.getUniformLocation(prog, 'uShapeRect[0]')!
    this.uShapeFeather = gl.getUniformLocation(prog, 'uShapeFeather[0]')!
    this.uAspect = gl.getUniformLocation(prog, 'uAspect')!

    this.vbo = gl.createBuffer()!
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferData(gl.ARRAY_BUFFER, 20 * 4, gl.DYNAMIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0)
    gl.enableVertexAttribArray(1)
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12)

    gl.enable(gl.BLEND)
    // separate alpha factors so layers accumulate correct coverage in the
    // transition FBOs (the canvas itself is alpha:false and doesn't care)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(prog)
    gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)
  }

  private buildProgram(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl
    const compile = (type: number, src: string) => {
      const sh = gl.createShader(type)!
      gl.shaderSource(sh, src)
      gl.compileShader(sh)
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        throw new Error('shader: ' + gl.getShaderInfoLog(sh))
      }
      return sh
    }
    const prog = gl.createProgram()!
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc))
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc))
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('link: ' + gl.getProgramInfoLog(prog))
    }
    return prog
  }

  setSize(w: number, h: number) {
    if (this.width === w && this.height === h) return
    this.width = w
    this.height = h
    this.canvas.width = w
    this.canvas.height = h
    this.gl.viewport(0, 0, w, h)
  }

  /** Copy the finished frame out of the default framebuffer (bottom-up rows). */
  readPixels(out: Uint8Array) {
    const gl = this.gl
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.readPixels(0, 0, this.width, this.height, gl.RGBA, gl.UNSIGNED_BYTE, out)
  }

  begin(background: string) {
    const gl = this.gl
    this.frame++
    this.curFbo = this.target
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target)
    const [r, g, b] = hexToRgb(background)
    gl.clearColor(r, g, b, 1)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  drawLayer(l: LayerDraw) {
    const gl = this.gl
    const entry = this.getTexture(l.cacheKey)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, entry.tex)
    if (l.raw) {
      if (entry.rawVersion !== l.raw.version) {
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, l.raw.w, l.raw.h, 0,
          gl.RGBA, gl.UNSIGNED_BYTE, l.raw.data)
        entry.rawVersion = l.raw.version
      }
    } else if (l.dynamic || entry.lastUsed === 0) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, l.source!)
      entry.rawVersion = undefined
    }
    gl.uniform1i(this.uRawBGRA, l.raw ? 1 : 0)
    entry.lastUsed = this.frame

    // fit the source into the project frame, then apply the clip scale
    const fit = Math.min(this.width / l.srcWidth, this.height / l.srcHeight) * l.scale
    const w = l.srcWidth * fit
    const h = l.srcHeight * fit
    const clipRot = makeRot3(l.rotation, l.rotX ?? 0, l.rotY ?? 0)
    const outer = l.outer
    const outerRot = outer ? makeRot3(outer.rotation, outer.rotX, outer.rotY) : null
    const focal = Math.max(this.width, this.height) * 1.2

    // corner order matches TRIANGLE_STRIP: TL, BL, TR, BR
    const data = new Float32Array(20)
    const corners = [
      [-w / 2, -h / 2, 0, 0],
      [-w / 2, h / 2, 0, 1],
      [w / 2, -h / 2, 1, 0],
      [w / 2, h / 2, 1, 1]
    ]
    corners.forEach(([px, py, u, v], i) => {
      // clip transform: 3D rotation around the layer center, then offset
      let P = rotApply(clipRot, px, py, 0)
      P[0] += l.x
      P[1] += l.y
      P[2] += l.z ?? 0
      // whole-track motion around the project center
      if (outer && outerRot) {
        P[0] *= outer.scale
        P[1] *= outer.scale
        P[2] *= outer.scale
        P = rotApply(outerRot, P[0], P[1], P[2])
        P[0] += outer.x
        P[1] += outer.y
        P[2] += outer.z
      }
      // perspective projection; the clip-space w must be proportional to
      // the eye depth (f+z)/f — not its inverse — or the GPU interpolates
      // the texture with inverted weights and the quad warps internally
      const wclip = Math.max(0.05, (focal + P[2]) / focal)
      const pw = 1 / wclip
      const sx = this.width / 2 + P[0] * pw
      const sy = this.height / 2 + P[1] * pw
      const ndcX = (sx / this.width) * 2 - 1
      const ndcY = 1 - (sy / this.height) * 2
      data[i * 5] = ndcX * wclip
      data[i * 5 + 1] = ndcY * wclip
      data[i * 5 + 2] = wclip
      data[i * 5 + 3] = u
      data[i * 5 + 4] = v
    })

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    gl.uniform1f(this.uOpacity, l.opacity)
    const c = l.crop ?? [0, 0, 0, 0]
    gl.uniform4f(this.uCrop, c[0], c[1], c[2], c[3])
    const shapes = (l.shapes ?? []).slice(0, MAX_SHAPES)
    gl.uniform1i(this.uShapeCount, shapes.length)
    if (shapes.length) {
      const types = new Int32Array(MAX_SHAPES)
      const rects = new Float32Array(MAX_SHAPES * 4)
      const feathers = new Float32Array(MAX_SHAPES * 3)
      shapes.forEach((s, i) => {
        types[i] = s.type
        rects.set([s.cx, s.cy, s.halfW, s.halfH], i * 4)
        feathers.set([s.featherIn, s.featherOut, s.invert ? 1 : 0], i * 3)
      })
      gl.uniform1iv(this.uShapeType, types)
      gl.uniform4fv(this.uShapeRect, rects)
      gl.uniform3fv(this.uShapeFeather, feathers)
      gl.uniform1f(this.uAspect, l.srcWidth / Math.max(1, l.srcHeight))
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  // ------------------------------------------------------------ transitions
  // Two project-sized offscreen targets: the outgoing and incoming clips are
  // rendered separately, then blended by a gl-transitions style shader.

  /** Redirect subsequent drawLayer calls into offscreen target 0 or 1. */
  beginOverlay(i: 0 | 1) {
    const gl = this.gl
    this.ensureOverlays()
    this.curFbo = this.overlays[i].fbo
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.curFbo)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
  }

  /** Back to the current composite destination (canvas or accumulator). */
  endOverlay() {
    this.curFbo = this.target
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.target)
  }

  // ------------------------------------------------------------ motion blur
  // Shutter accumulation: each export frame is the running average of
  // several sub-frame composites rendered into overlay 2 and blitted onto
  // the canvas with 1/(n+1) weights (an exact mean in 8-bit).

  /** Route whole composites into the accumulator FBO (true) or canvas. */
  setRenderTarget(accum: boolean) {
    if (accum) {
      this.ensureOverlays()
      this.target = this.overlays[2]?.fbo ?? null
    } else {
      this.target = null
    }
    this.curFbo = this.target
    this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, this.target)
  }

  /** Blend the accumulator onto the canvas with the given running weight. */
  accumBlit(alpha: number) {
    const gl = this.gl
    if (this.overlays.length < 3) return
    if (!this.blitProg) {
      this.blitProg = this.buildProgram(TRANS_VS, BLIT_FS)
      gl.useProgram(this.blitProg)
      gl.uniform1i(gl.getUniformLocation(this.blitProg, 'uTex'), 0)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.useProgram(this.blitProg)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.overlays[2].tex)
    const data = new Float32Array([
      -1, -1, 1, 0, 0,
      1, -1, 1, 1, 0,
      -1, 1, 1, 0, 1,
      1, 1, 1, 1, 1
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    gl.blendColor(0, 0, 0, alpha)
    gl.blendFuncSeparate(
      gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA,
      gl.CONSTANT_ALPHA, gl.ONE_MINUS_CONSTANT_ALPHA
    )
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.useProgram(this.prog)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target)
  }

  /** Composite overlay 0 → 1 onto the canvas with the given transition. */
  drawTransition(type: string, progress: number, opacity: number) {
    const gl = this.gl
    if (this.overlays.length < 2) return
    const tp = this.getTransProg(type)
    gl.useProgram(tp.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.overlays[0].tex)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_2D, this.overlays[1].tex)
    this.drawScreenQuad(tp, progress, opacity)
  }

  /** Composite overlay 0 onto the canvas through an edge (tip) effect. */
  drawEdgeEffect(type: string, progress: number, opacity: number) {
    const gl = this.gl
    if (!this.overlays.length) return
    const tp = this.getEdgeProg(type)
    gl.useProgram(tp.prog)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.overlays[0].tex)
    this.drawScreenQuad(tp, progress, opacity)
  }

  // ------------------------------------------------------------- outer glow
  // The layer renders into its own full-res buffer; its alpha silhouette is
  // blurred into a low-res field; the glow shader turns the field into a
  // smoky halo drawn under the layer, then the layer itself is blitted on
  // top. Works inside any destination (canvas, accumulator, transition FBO).

  /** Draw a layer (possibly frame-blended pair) with outer glows beneath. */
  drawLayerGlow(layers: LayerDraw[], glows: GlowParams[], time: number) {
    this.drawLayerFx(layers, 0, glows, time)
  }

  /**
   * Layer(s) through the effects chain: optional gaussian blur (radius as a
   * fraction of output height — resolution independent), then outer glows,
   * then the (possibly blurred) layer itself, premultiplied into curFbo.
   */
  drawLayerFx(layers: LayerDraw[], blurFrac: number, glows: GlowParams[], time: number) {
    const gl = this.gl
    this.ensureFx()
    const fx = this.fx!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fx.layer.fbo)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    for (const l of layers) this.drawLayer(l)

    const radius = blurFrac * this.height
    if (radius > 0.2) {
      if (!this.blurProg) {
        const prog = this.buildProgram(TRANS_VS, BLUR_FS)
        gl.useProgram(prog)
        gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)
        this.blurProg = {
          prog,
          uDir: gl.getUniformLocation(prog, 'uDir')!,
          uRadius: gl.getUniformLocation(prog, 'uRadius')!
        }
      }
      const bp = this.blurProg
      gl.disable(gl.BLEND)
      gl.useProgram(bp.prog)
      gl.activeTexture(gl.TEXTURE0)
      // horizontal: layer → blur scratch
      gl.bindFramebuffer(gl.FRAMEBUFFER, fx.blur.fbo)
      gl.bindTexture(gl.TEXTURE_2D, fx.layer.tex)
      gl.uniform2f(bp.uDir, 1 / this.width, 0)
      gl.uniform1f(bp.uRadius, radius)
      this.fsQuad()
      // vertical: scratch → back into the layer FBO (glow + blit read it)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fx.layer.fbo)
      gl.bindTexture(gl.TEXTURE_2D, fx.blur.tex)
      gl.uniform2f(bp.uDir, 0, 1 / this.height)
      this.fsQuad()
      gl.enable(gl.BLEND)
    }

    const ratio = this.width / Math.max(1, this.height)
    for (const g of glows) {
      // blurred silhouette at reduced resolution (radius taps stay cheap)
      gl.bindFramebuffer(gl.FRAMEBUFFER, fx.field.fbo)
      gl.viewport(0, 0, fx.fw, fx.fh)
      gl.disable(gl.BLEND)
      const fp = this.getFieldProg()
      gl.useProgram(fp.prog)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, fx.layer.tex)
      gl.uniform1f(fp.uSize, g.sizePx / Math.max(1, this.height))
      gl.uniform1f(fp.uRatio, ratio)
      this.fsQuad()
      gl.enable(gl.BLEND)
      gl.viewport(0, 0, this.width, this.height)

      // smoky halo under the layer, into the current composite destination
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.curFbo)
      const gp = this.getGlowProg()
      gl.useProgram(gp.prog)
      gl.activeTexture(gl.TEXTURE0)
      gl.bindTexture(gl.TEXTURE_2D, fx.field.tex)
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, fx.layer.tex)
      gl.uniform3f(gp.u.uColor, g.color[0], g.color[1], g.color[2])
      gl.uniform1f(gp.u.uSize, g.sizePx / Math.max(1, this.height))
      gl.uniform1f(gp.u.uIntensity, g.intensity)
      gl.uniform1f(gp.u.uSat, g.saturation)
      gl.uniform1f(gp.u.uSmoke, g.smoke)
      gl.uniform1f(gp.u.uSpeed, g.speed)
      gl.uniform1f(gp.u.uParticles, g.particles)
      gl.uniform1f(gp.u.uTime, time)
      gl.uniform1f(gp.u.ratio, ratio)
      gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      this.fsQuad()
    }

    // the layer itself on top of its glow (premultiplied)
    if (!this.blitProg) {
      this.blitProg = this.buildProgram(TRANS_VS, BLIT_FS)
      gl.useProgram(this.blitProg)
      gl.uniform1i(gl.getUniformLocation(this.blitProg, 'uTex'), 0)
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.curFbo)
    gl.useProgram(this.blitProg)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, fx.layer.tex)
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    this.fsQuad()

    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.activeTexture(gl.TEXTURE0)
    gl.useProgram(this.prog)
  }

  private fsQuad() {
    const gl = this.gl
    const data = new Float32Array([
      -1, -1, 1, 0, 0,
      1, -1, 1, 1, 0,
      -1, 1, 1, 0, 1,
      1, 1, 1, 1, 1
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  private makeFbo(w: number, h: number): Overlay {
    const gl = this.gl
    const tex = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, tex)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const fbo = gl.createFramebuffer()!
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    return { fbo, tex }
  }

  private ensureFx() {
    const gl = this.gl
    const size = this.width * 65536 + this.height
    if (this.fx && this.fxSize === size) return
    if (this.fx) {
      for (const o of [this.fx.layer, this.fx.field, this.fx.blur]) {
        gl.deleteFramebuffer(o.fbo)
        gl.deleteTexture(o.tex)
      }
    }
    const fw = Math.max(2, Math.round(this.width / 4))
    const fh = Math.max(2, Math.round(this.height / 4))
    this.fx = {
      layer: this.makeFbo(this.width, this.height),
      field: this.makeFbo(fw, fh),
      blur: this.makeFbo(this.width, this.height),
      fw, fh
    }
    this.fxSize = size
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.curFbo)
  }

  private getFieldProg() {
    if (!this.fieldProg) {
      const gl = this.gl
      const prog = this.buildProgram(TRANS_VS, GLOW_FIELD_FS)
      gl.useProgram(prog)
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)
      this.fieldProg = {
        prog,
        uSize: gl.getUniformLocation(prog, 'uSize')!,
        uRatio: gl.getUniformLocation(prog, 'ratio')!
      }
      gl.useProgram(this.prog)
    }
    return this.fieldProg
  }

  private getGlowProg() {
    if (!this.glowProg) {
      const gl = this.gl
      const prog = this.buildProgram(TRANS_VS, GLOW_FS)
      gl.useProgram(prog)
      gl.uniform1i(gl.getUniformLocation(prog, 'uField'), 0)
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 1)
      const u: Record<string, WebGLUniformLocation> = {}
      for (const name of ['uColor', 'uSize', 'uIntensity', 'uSat', 'uSmoke', 'uSpeed', 'uParticles', 'uTime', 'ratio']) {
        u[name] = gl.getUniformLocation(prog, name)!
      }
      this.glowProg = { prog, u }
      gl.useProgram(this.prog)
    }
    return this.glowProg
  }

  private drawScreenQuad(tp: TransProg, progress: number, opacity: number) {
    const gl = this.gl
    gl.uniform1f(tp.uProgress, progress)
    gl.uniform1f(tp.uRatio, this.width / Math.max(1, this.height))
    gl.uniform1f(tp.uOpacity, opacity)
    // fullscreen quad; uv origin bottom-left (gl-transitions convention)
    const data = new Float32Array([
      -1, -1, 1, 0, 0,
      1, -1, 1, 1, 0,
      -1, 1, 1, 0, 1,
      1, 1, 1, 1, 1
    ])
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo)
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data)
    // overlay colors are premultiplied — composite without re-multiplying
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.activeTexture(gl.TEXTURE0)
    gl.useProgram(this.prog)
  }

  private ensureOverlays() {
    const gl = this.gl
    const size = this.width * 65536 + this.height
    if (this.overlays.length === 3 && this.overlaySize === size) return
    for (const o of this.overlays) {
      gl.deleteFramebuffer(o.fbo)
      gl.deleteTexture(o.tex)
    }
    this.overlays = []
    // 0/1 — transition sources, 2 — motion-blur accumulator
    for (let i = 0; i < 3; i++) {
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.width, this.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fbo = gl.createFramebuffer()!
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
      this.overlays.push({ fbo, tex })
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    this.overlaySize = size
  }

  private getTransProg(type: string): TransProg {
    let tp = this.transProgs.get(type)
    if (!tp) {
      const gl = this.gl
      let prog: WebGLProgram
      try {
        prog = this.buildProgram(TRANS_VS, transFS(transitionGlsl(type)))
      } catch (err) {
        console.error(`[kadr] transition "${type}" failed to compile`, err)
        prog = this.buildProgram(TRANS_VS, transFS(transitionGlsl('crossfade')))
      }
      gl.useProgram(prog)
      gl.uniform1i(gl.getUniformLocation(prog, 'uFrom'), 0)
      gl.uniform1i(gl.getUniformLocation(prog, 'uTo'), 1)
      tp = {
        prog,
        uProgress: gl.getUniformLocation(prog, 'progress')!,
        uRatio: gl.getUniformLocation(prog, 'ratio')!,
        uOpacity: gl.getUniformLocation(prog, 'uOpacity')!
      }
      gl.useProgram(this.prog)
      this.transProgs.set(type, tp)
    }
    return tp
  }

  private getEdgeProg(type: string): TransProg {
    const key = `edge:${type}`
    let tp = this.transProgs.get(key)
    if (!tp) {
      const gl = this.gl
      let prog: WebGLProgram
      try {
        prog = this.buildProgram(TRANS_VS, edgeFS(edgeGlsl(type)))
      } catch (err) {
        console.error(`[kadr] edge effect "${type}" failed to compile`, err)
        prog = this.buildProgram(TRANS_VS, edgeFS(edgeGlsl('blurZoomIn')))
      }
      gl.useProgram(prog)
      gl.uniform1i(gl.getUniformLocation(prog, 'uTex'), 0)
      tp = {
        prog,
        uProgress: gl.getUniformLocation(prog, 'progress')!,
        uRatio: gl.getUniformLocation(prog, 'ratio')!,
        uOpacity: gl.getUniformLocation(prog, 'uOpacity')!
      }
      gl.useProgram(this.prog)
      this.transProgs.set(key, tp)
    }
    return tp
  }

  /** Drop textures unused for a while (closed clips, evicted thumbnails). */
  collect() {
    for (const [key, entry] of this.textures) {
      if (this.frame - entry.lastUsed > 300) {
        this.gl.deleteTexture(entry.tex)
        this.textures.delete(key)
      }
    }
  }

  invalidate(cacheKey: string) {
    const e = this.textures.get(cacheKey)
    if (e) {
      this.gl.deleteTexture(e.tex)
      this.textures.delete(cacheKey)
    }
  }

  private getTexture(key: string): TexEntry {
    let entry = this.textures.get(key)
    if (!entry) {
      const gl = this.gl
      const tex = gl.createTexture()!
      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      entry = { tex, lastUsed: 0 }
      this.textures.set(key, entry)
    }
    return entry
  }
}

function hexToRgb(hex: string | undefined): [number, number, number] {
  const v = parseInt((hex ?? '#000000').replace('#', ''), 16)
  if (!Number.isFinite(v)) return [0, 0, 0]
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

/** Row-major 3×3 rotation: Ry, then Rx, then Rz (angles in degrees). */
function makeRot3(zDeg: number, xDeg: number, yDeg: number): Float64Array {
  const az = (zDeg * Math.PI) / 180
  const ax = (xDeg * Math.PI) / 180
  const ay = (yDeg * Math.PI) / 180
  const cz = Math.cos(az), sz = Math.sin(az)
  const cx = Math.cos(ax), sx = Math.sin(ax)
  const cy = Math.cos(ay), sy = Math.sin(ay)
  // R = Rz * Rx * Ry
  return new Float64Array([
    cz * cy + sz * sx * sy, -sz * cx, -cz * sy + sz * sx * cy,
    sz * cy - cz * sx * sy, cz * cx, -sz * sy - cz * sx * cy,
    cx * sy, sx, cx * cy
  ])
}

function rotApply(m: Float64Array, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0] * x + m[1] * y + m[2] * z,
    m[3] * x + m[4] * y + m[5] * z,
    m[6] * x + m[7] * y + m[8] * z
  ]
}
