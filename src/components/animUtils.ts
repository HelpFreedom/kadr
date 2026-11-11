// Keyframe helpers shared by the clip animation editor and track motion.
import { useLayoutEffect, useState } from 'react'
import type { Anim, Easing, Keyframe } from '@shared/types'
import { evalAnim } from '@/engine/anim'

export const KF_EPS = 0.02

export function sortedKfs(a: Anim): Keyframe[] {
  return [...(a.keyframes ?? [])].sort((x, y) => x.time - y.time)
}

export function upsertKf(a: Anim, time: number, value: number, easing: Easing = 'linear'): Anim {
  const existing = a.keyframes?.find((k) => Math.abs(k.time - time) < KF_EPS)
  const kfs = sortedKfs(a).filter((k) => Math.abs(k.time - time) >= KF_EPS)
  kfs.push({ time, value, easing: existing?.easing ?? easing })
  kfs.sort((x, y) => x.time - y.time)
  return { ...a, keyframes: kfs }
}

/**
 * Apply a new value. A parameter that already has keyframes always records a
 * state at the given time; `linked` controls whether static params start
 * recording too.
 */
export function applyValue(anim: Anim, rel: number, value: number, linked: boolean): Anim {
  if (anim.keyframes?.length || linked) return upsertKf(anim, rel, value)
  return { ...anim, value }
}

/** Reset helper: keyframed params get a default keyframe, static ones reset. */
export function resetValue(anim: Anim, rel: number, def: number): Anim {
  return anim.keyframes?.length ? upsertKf(anim, rel, def) : { ...anim, value: def }
}

export function snap1(v: number, targets: number[], tol: number): number {
  let best = v
  let bd = tol
  for (const t of targets) {
    const d = Math.abs(t - v)
    if (d < bd) {
      bd = d
      best = t
    }
  }
  return best
}

export function windowDrag(
  e: { clientX: number; clientY: number },
  move: (dx: number, dy: number, ev: PointerEvent) => void,
  done?: (moved: boolean) => void
) {
  const sx = e.clientX
  const sy = e.clientY
  let moved = false
  const onMove = (ev: PointerEvent) => {
    if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) moved = true
    move(ev.clientX - sx, ev.clientY - sy, ev)
  }
  const onUp = () => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    window.removeEventListener('pointercancel', onUp)
    done?.(moved)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', onUp) // ends like pointerup: no pointerup follows a cancel
}

/**
 * The width of an element's content box, followed as it changes. The editors'
 * stage was `panel width − 22`, a constant that knew the padding and the
 * border but not the vertical scrollbar: once the column scrolled, the stage
 * stuck out by a few pixels and the column scrolled sideways too (kadr#26).
 * A CALLBACK ref, not a ref object: both editors render nothing while their
 * clip or track is missing, and an effect keyed on a ref object would run
 * once against no element and never look again. Null until measured.
 */
export function useContentWidth(): [(el: HTMLElement | null) => void, number | null] {
  const [el, setEl] = useState<HTMLElement | null>(null)
  const [w, setW] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!el) return
    const read = () => {
      const cs = getComputedStyle(el)
      setW(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
    }
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [el])
  return [setEl, w]
}

export { evalAnim }
