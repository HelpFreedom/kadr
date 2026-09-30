// The effect registry. Every `./<id>.fx.ts` next to this file is picked up by
// the glob below — to add an effect, add a file; nothing else lists them. The
// registry is a store so the Inspector and the agent API see effects that
// arrive later (the project library).
import { create } from 'zustand'
import type { EffectDef, EffectParamDecl, FxValues, Label } from './types'

export type { EffectDef, EffectParamDecl, FxContext, FxValues, Label } from './types'

const builtins = Object.values(import.meta.glob<{ default: EffectDef }>('./*.fx.ts', { eager: true }))
  .map((m) => m.default)

interface EffectsState {
  defs: Record<string, EffectDef>
  /** effect id → why it cannot run (a shader that does not compile) */
  errors: Record<string, string>
}

export const useEffects = create<EffectsState>(() => ({
  defs: Object.fromEntries(builtins.map((d) => [d.id, d])),
  errors: {}
}))

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

function numberOf(d: EffectParamDecl, v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? Number(v) : NaN
  if (Number.isFinite(n)) return n
  return typeof d.default === 'number' ? d.default : d.default === true ? 1 : 0
}

/** Stored params → shader values, with defaults for anything missing or broken. */
export function resolveValues(def: EffectDef, params: Record<string, unknown>): FxValues {
  const out: FxValues = {}
  for (const [k, d] of Object.entries(def.params)) {
    const v = params[k]
    if (d.kind === 'color') {
      const hex = typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v) ? v : String(d.default)
      out[k] = hexRgb(hex)
    } else {
      out[k] = numberOf(d, v)
    }
  }
  return out
}
