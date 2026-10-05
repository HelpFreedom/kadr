// Effects that live in a project: `<project>/kadr-lib/effects/<name>.glsl`,
// one file each — a header comment with JSON, then the GLSL body:
//
//   /* kadr-effect
//   { "name": { "ru": "Сепия", "en": "Sepia" }, "group": "color",
//     "params": { "amount": { "kind": "number", "default": 1, "min": 0, "max": 1,
//                             "name": { "ru": "Сила", "en": "Amount" } } } }
//   */
//   vec4 effect(vec4 c, vec2 uv) { ... return c; }
//
// Parsing is pure (main reads the files, the renderer compiles them) so it can
// be checked in plain node. No code but GLSL: it runs in WebGL's sandbox.

export const EFFECT_GROUPS = ['color', 'key', 'stylize', 'light', 'blur'] as const
export type EffectGroup = (typeof EFFECT_GROUPS)[number]

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
  /** color: offer the eyedropper, which takes the colour from the preview */
  pick?: boolean
  name: Label
}

export interface EffectFile {
  /** 'lib:<file name>' — what Effect.type stores */
  id: string
  file: string
  name: Label
  group: EffectGroup
  params: Record<string, EffectParamDecl>
  glsl: string
  /** the shader reads uTime */
  timeDependent: boolean
}

export interface EffectFileError {
  id: string
  file: string
  error: string
}

export const MAX_EFFECT_FILE = 256 * 1024

/** A file name → the effect's id; null for names that cannot be one. */
export function effectFileId(fileName: string): string | null {
  const m = /^([A-Za-z0-9][A-Za-z0-9_-]{0,63})\.glsl$/.exec(fileName)
  return m ? `lib:${m[1]}` : null
}

const isLabel = (v: unknown): v is Label =>
  (typeof v === 'string' && v.length > 0) ||
  (!!v && typeof v === 'object' && typeof (v as { ru?: unknown }).ru === 'string' &&
    typeof (v as { en?: unknown }).en === 'string')

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function checkParam(key: string, raw: unknown): EffectParamDecl | string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `param «${key}»: a name is letters, digits and _`
  if (!raw || typeof raw !== 'object') return `param «${key}»: not an object`
  const p = raw as Record<string, unknown>
  const name = isLabel(p.name) ? p.name : key
  switch (p.kind) {
    case 'number': {
      if (!finite(p.default)) return `param «${key}»: a number needs a numeric "default"`
      if (p.min !== undefined && !finite(p.min)) return `param «${key}»: "min" is not a number`
      if (p.max !== undefined && !finite(p.max)) return `param «${key}»: "max" is not a number`
      if (finite(p.min) && finite(p.max) && p.max <= p.min) return `param «${key}»: "max" must be above "min"`
      if (p.step !== undefined && !(finite(p.step) && p.step > 0)) return `param «${key}»: "step" must be positive`
      return { kind: 'number', default: p.default, min: p.min as number | undefined,
        max: p.max as number | undefined, step: p.step as number | undefined, name }
    }
    case 'color':
      if (typeof p.default !== 'string' || !/^#[0-9a-f]{6}$/i.test(p.default)) {
        return `param «${key}»: a colour needs a "#rrggbb" default`
      }
      return { kind: 'color', default: p.default, pick: p.pick === true, name }
    case 'toggle':
      if (typeof p.default !== 'boolean') return `param «${key}»: a toggle needs a true/false default`
      return { kind: 'toggle', default: p.default, name }
    case 'select': {
      const opts = Array.isArray(p.options) ? p.options : []
      const options = opts.filter((o): o is { value: number; name: Label } =>
        !!o && finite((o as { value?: unknown }).value) && isLabel((o as { name?: unknown }).name))
      if (!options.length || options.length !== opts.length) {
        return `param «${key}»: a select needs "options": [{ "value": number, "name": text }]`
      }
      if (!finite(p.default) || !options.some((o) => o.value === p.default)) {
        return `param «${key}»: the default must be one of the option values`
      }
      return { kind: 'select', default: p.default, options, name }
    }
    default:
      return `param «${key}»: "kind" is number, color, select or toggle`
  }
}

/** Parse one effect file; every problem comes back as a readable error. */
export function parseEffectFile(file: string, text: string): EffectFile | EffectFileError {
  const id = effectFileId(file) ?? `lib:${file}`
  const fail = (error: string): EffectFileError => ({ id, file, error })
  if (!effectFileId(file)) return fail('the file name is letters, digits, - and _, ending in .glsl')
  if (text.length > MAX_EFFECT_FILE) return fail(`the file is over ${MAX_EFFECT_FILE / 1024} KB`)
  const m = /^\s*\/\*\s*kadr-effect\b([\s\S]*?)\*\//.exec(text)
  if (!m) return fail('the file must start with a /* kadr-effect { … } */ header')
  let head: Record<string, unknown>
  try {
    head = JSON.parse(m[1])
  } catch (e) {
    return fail(`the header is not JSON: ${(e as Error).message}`)
  }
  if (!head || typeof head !== 'object') return fail('the header must be a JSON object')
  const glsl = text.slice(m.index + m[0].length).trim()
  if (!/\bvec4\s+effect\s*\(/.test(glsl)) return fail('the body must define vec4 effect(vec4 c, vec2 uv)')
  const group = head.group === undefined ? 'stylize' : head.group
  if (!EFFECT_GROUPS.includes(group as EffectGroup)) return fail(`"group" is one of ${EFFECT_GROUPS.join(', ')}`)
  const params: Record<string, EffectParamDecl> = {}
  const rawParams = head.params ?? {}
  if (typeof rawParams !== 'object' || Array.isArray(rawParams)) return fail('"params" must be an object')
  for (const [k, v] of Object.entries(rawParams as Record<string, unknown>)) {
    const p = checkParam(k, v)
    if (typeof p === 'string') return fail(p)
    params[k] = p
  }
  return {
    id,
    file,
    name: isLabel(head.name) ? head.name : file.replace(/\.glsl$/, ''),
    group: group as EffectGroup,
    params,
    glsl,
    timeDependent: head.time === true || /\buTime\b/.test(glsl)
  }
}
