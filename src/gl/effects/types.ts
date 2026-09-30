// The shape of a per-clip effect. One effect is one file in this folder named
// `<id>.fx.ts` whose default export is an EffectDef; index.ts collects them, so
// adding an effect touches nothing else. See CLAUDE.md, EFFECTS.

/** A user-visible name: one string for every language, or one per language. */
export type Label = string | { ru: string; en: string }

export interface EffectParamDecl {
  kind: 'number' | 'color' | 'select' | 'toggle'
  /** number / select value; '#rrggbb' for a colour; boolean for a toggle */
  default: number | string | boolean
  min?: number
  max?: number
  step?: number
  /** select: the choices; the uniform receives `value` */
  options?: { value: number; name: Label }[]
  name: Label
}

/**
 * Parameter values as the shader sees them: numbers (a select gives its value,
 * a toggle 0 or 1) and colours as 0..1 RGB triples.
 */
export type FxValues = Record<string, number | [number, number, number]>

export interface FxTarget {
  fbo: WebGLFramebuffer
  tex: WebGLTexture
}

/** What a multi-pass effect gets from the compositor. */
export interface FxContext {
  gl: WebGL2RenderingContext
  /** output size in pixels */
  width: number
  height: number
  /** the project's height: sizes stored in project pixels scale by height / projectHeight */
  projectHeight: number
  /** clip-local seconds — the same clock in preview and export */
  time: number
  /** the layer so far, premultiplied, full size */
  src: WebGLTexture
  /** 'layer' stage: where the result goes (never the same buffer as src) */
  out: FxTarget
  /** 'layer' stage: a full-size scratch buffer for intermediate passes */
  temp(): FxTarget
  /** a quarter-size scratch buffer (cheap wide blurs) */
  small(): FxTarget & { w: number; h: number }
  /** 'under' stage: the composite the layer will be drawn onto */
  dest: WebGLFramebuffer | null
  /** a program over the fullscreen quad, built once per key and cached */
  program(key: string, fs: string): { prog: WebGLProgram; u(name: string): WebGLUniformLocation | null }
  /** draw the fullscreen quad (uv 0..1, bottom-left origin) */
  quad(): void
  /** the vertex shader to pair with fragment shaders passed to program() */
  vs: string
}

export interface EffectDef {
  /** stored in the project as Effect.type — never rename a shipped one */
  id: string
  group: 'color' | 'key' | 'stylize' | 'light' | 'blur'
  name: Label
  params: Record<string, EffectParamDecl>
  /**
   * Single pass: GLSL that defines `vec4 effect(vec4 c, vec2 uv)`. `c` is the
   * layer's straight (not premultiplied) colour at `uv`; return straight colour.
   * Uniforms: `u_<param>` for every param (vec3 for a colour, float otherwise),
   * `uTime`, `uRes`, `uRatio`; helpers: `texel(uv)` (straight colour anywhere),
   * `luma`, `rgb2hsv`, `hsv2rgb`, `hash12`.
   */
  glsl?: string
  /**
   * Multi-pass escape hatch. 'layer' stage: read ctx.src, write ctx.out and
   * return true, or return false to leave the layer as it is. 'under' stage:
   * draw into ctx.dest, beneath the layer.
   */
  run?: (ctx: FxContext, v: FxValues) => boolean | void
  /** 'layer' (default) changes the layer; 'under' paints beneath it (glow) */
  stage?: 'layer' | 'under'
  /** reads uTime / ctx.time: frames at different times differ even at rest */
  timeDependent?: boolean
  /** false when these values change nothing (a zero blur): the layer is drawn plainly */
  active?: (v: FxValues, project: { width: number; height: number }) => boolean
}
