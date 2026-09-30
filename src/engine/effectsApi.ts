// Per-clip effects for scripts and agents (window.kadrEditor.effects, the
// kadr_effects tool). Every change is one undo step, like an edit in the
// Inspector; the effect catalogue is whatever src/gl/effects/ registered.
import type { Anim, Effect } from '@shared/types'
import { useEditor, findClip, uid } from '@/state/store'
import { listEffects, getEffect, defaultParams, useEffects } from '@/gl/effects'

function clipEffects(clipId: string): Effect[] {
  const f = findClip(useEditor.getState().project, clipId)
  if (!f) throw new Error(`no clip ${clipId}`)
  return f.clip.effects ?? []
}

function write(clipId: string, effects: Effect[]) {
  const st = useEditor.getState()
  st.pushHistory('hEffect')
  st.updateClip(clipId, { effects })
}

function indexOf(effects: Effect[], effectId: string): number {
  const i = effects.findIndex((e) => e.id === effectId)
  if (i < 0) throw new Error(`no effect ${effectId} on this clip`)
  return i
}

export const effectsApi = {
  /** every effect this editor can draw, with its params (ranges, defaults) and any error */
  list() {
    const errors = useEffects.getState().errors
    return listEffects().map((d) => ({
      id: d.id,
      group: d.group,
      name: d.name,
      stage: d.stage ?? 'layer',
      timeDependent: !!d.timeDependent,
      params: d.params,
      error: errors[d.id]
    }))
  },

  /** add an effect at the end of the clip's chain; returns its id */
  add(clipId: string, type: string, params: Record<string, Anim | number | string> = {}) {
    const def = getEffect(type)
    if (!def) throw new Error(`unknown effect «${type}»; known: ${listEffects().map((d) => d.id).join(', ')}`)
    const effect: Effect = { id: uid(), type, enabled: true, params: { ...defaultParams(def), ...params } }
    write(clipId, [...clipEffects(clipId), effect])
    return effect.id
  },

  /**
   * change params (merged) and/or switch the effect on or off; a numeric param
   * takes a number or an Anim — { value, keyframes: [{ time, value, easing }] }
   * with clip-local times, exactly like the transform
   */
  set(clipId: string, effectId: string, patch: { enabled?: boolean; params?: Record<string, Anim | number | string> }) {
    const effects = clipEffects(clipId)
    const i = indexOf(effects, effectId)
    const e = effects[i]
    const next = [...effects]
    next[i] = { ...e, enabled: patch.enabled ?? e.enabled, params: { ...e.params, ...(patch.params ?? {}) } }
    write(clipId, next)
  },

  /** move the effect to position `to` of the chain (0 = first applied) */
  move(clipId: string, effectId: string, to: number) {
    const next = [...clipEffects(clipId)]
    const [e] = next.splice(indexOf(next, effectId), 1)
    next.splice(Math.max(0, Math.min(next.length, to)), 0, e)
    write(clipId, next)
  },

  remove(clipId: string, effectId: string) {
    write(clipId, clipEffects(clipId).filter((e) => e.id !== effectId))
  }
}
