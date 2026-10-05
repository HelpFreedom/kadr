// The effect registry. Every `./<id>.fx.ts` next to this file is picked up by
// the glob below — to add an effect, add a file; nothing else lists them. The
// registry is a store so the Inspector and the agent API see effects that
// arrive later (the project library).
import { create } from 'zustand'
import type { Anim } from '@shared/types'
import { evalAnim } from '@/engine/anim'
import type { EffectDef, EffectParamDecl, FxValues, Label } from './types'

export type { EffectDef, EffectParamDecl, FxContext, FxValues, Label } from './types'

const builtins = Object.values(import.meta.glob<{ default: EffectDef }>('./*.fx.ts', { eager: true }))
  .map((m) => m.default)

interface EffectsState {
  defs: Record<string, EffectDef>
  /** effect id → why it cannot run (a shader that does not compile) */
  errors: Record<string, string>
  /** project-library files that are not effects yet (a bad header) */
  libraryIssues: { id: string; file: string; error: string }[]
  /** the open project's kadr-lib/effects, or null for an unsaved project */
  libraryDir: string | null
}

export const useEffects = create<EffectsState>(() => ({
  defs: Object.fromEntries(builtins.map((d) => [d.id, d])),
  errors: {},
  libraryIssues: [],
  libraryDir: null
}))

/**
 * Replace the project-library effects ('lib:*') with a fresh reading of the
 * folder. Their compile errors are cleared too: an edited file compiles anew
 * (programs are keyed by source hash) and reports again if it still fails.
 */
export function setLibraryEffects(defs: EffectDef[], issues: EffectsState['libraryIssues'], dir: string | null) {
  const st = useEffects.getState()
  const keep = Object.fromEntries(Object.entries(st.defs).filter(([id]) => !id.startsWith('lib:')))
  const errors = Object.fromEntries(Object.entries(st.errors).filter(([id]) => !id.startsWith('lib:')))
  useEffects.setState({
    defs: { ...keep, ...Object.fromEntries(defs.map((d) => [d.id, d])) },
    errors,
    libraryIssues: issues,
    libraryDir: dir
  })
}

export const getEffect = (id: string): EffectDef | undefined => useEffects.getState().defs[id]
export const listEffects = (): EffectDef[] => Object.values(useEffects.getState().defs)

export function setEffectError(id: string, message: string | null) {
  const errors = { ...useEffects.getState().errors }
  if (message) errors[id] = message
  else delete errors[id]
  useEffects.setState({ errors })
}

export const labelText = (l: Label, lang: 'ru' | 'en'): string => (typeof l === 'string' ? l : l[lang])

/** Params of a freshly added effect: every declared default. */
export function defaultParams(def: EffectDef): Record<string, number | string> {
  const out: Record<string, number | string> = {}
  for (const [k, d] of Object.entries(def.params)) {
    out[k] = typeof d.default === 'boolean' ? (d.default ? 1 : 0) : d.default
  }
  return out
}

export function hexRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

const numericDefault = (d: EffectParamDecl) =>
  typeof d.default === 'number' ? d.default : d.default === true ? 1 : 0

/** A stored numeric param as an Anim: a bare number, an Anim, or the default. */
export function paramAnim(d: EffectParamDecl, v: unknown): Anim {
  if (typeof v === 'number' && Number.isFinite(v)) return { value: v }
  if (v && typeof v === 'object' && Number.isFinite((v as Anim).value)) return v as Anim
  return { value: numericDefault(d) }
}

/**
 * Stored params → shader values at clip-local time `t`, with defaults for
 * anything missing or broken. Evaluated here, before the compositor, so the
 * motion-blur signature sees the values that are really drawn.
 */
export function resolveValues(def: EffectDef, params: Record<string, unknown>, t: number): FxValues {
  const out: FxValues = {}
  for (const [k, d] of Object.entries(def.params)) {
    const v = params[k]
    if (d.kind === 'color') {
      const hex = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : String(d.default)
      out[k] = hexRgb(hex)
    } else {
      const n = evalAnim(paramAnim(d, v), t)
      out[k] = Number.isFinite(n) ? n : numericDefault(d)
    }
  }
  return out
}
