import type { Anim, Easing } from '@shared/types'

const ease: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  hold: () => 0
}

/** Every easing the editor knows — the keys of the table above, so a new
 *  curve is known everywhere the day it is added. */
export const EASINGS = Object.keys(ease) as readonly Easing[]

/** A keyframe's easing curve; anything else — missing, misspelled, a name
 *  that only Object.prototype has ('toString') — eases linearly. A keyframe
 *  written by a script or a foreign project without one used to THROW here,
 *  and the throw took the whole frame down with it (HelpFreedom/kadr#17). */
export function easingOf(e: unknown): (t: number) => number {
  return typeof e === 'string' && Object.prototype.hasOwnProperty.call(ease, e) ? ease[e as Easing] : ease.linear
}

/** Evaluate an animatable property at time t (relative to clip start). */
export function evalAnim(a: Anim | number | undefined, t: number): number {
  // tolerate scalar anims from scripts/foreign projects — a NaN escaping
  // into WebAudio or CSS kills far more than one property
  if (typeof a === 'number') return Number.isFinite(a) ? a : 0
  if (!a) return 0
  const kfs = a.keyframes
  if (!kfs || kfs.length === 0) return Number.isFinite(a.value) ? a.value : 0
  if (t <= kfs[0].time) return kfs[0].value
  const last = kfs[kfs.length - 1]
  if (t >= last.time) return last.value
  for (let i = 0; i < kfs.length - 1; i++) {
    const k0 = kfs[i]
    const k1 = kfs[i + 1]
    if (t >= k0.time && t < k1.time) {
      const span = k1.time - k0.time
      let f = span > 0 ? (t - k0.time) / span : 0
      if (a.smooth) {
        // parabolic feel: long build-up of speed, short crisp settle
        const isFirst = i === 0
        const isLast = i === kfs.length - 2
        if (isFirst && isLast) f = biasEase(f, 2.2, 1.4)
        else if (isFirst) f = Math.pow(f, 2.2)
        else if (isLast) f = 1 - Math.pow(1 - f, 1.4)
        if (kfs.length > 2) {
          // Catmull-Rom spline keeps the velocity continuous through midpoints
          const p0 = kfs[i - 1]?.value ?? k0.value
          const p1 = k0.value
          const p2 = k1.value
          const p3 = kfs[i + 2]?.value ?? k1.value
          const f2 = f * f
          const f3 = f2 * f
          return 0.5 * (
            2 * p1 +
            (-p0 + p2) * f +
            (2 * p0 - 5 * p1 + 4 * p2 - p3) * f2 +
            (-p0 + 3 * p1 - 3 * p2 + p3) * f3
          )
        }
        return k0.value + (k1.value - k0.value) * f
      }
      return k0.value + (k1.value - k0.value) * easingOf(k0.easing)(f)
    }
  }
  return last.value
}

/** Monotonic asymmetric s-curve: p shapes the acceleration, q the settle. */
function biasEase(f: number, p: number, q: number): number {
  if (f <= 0) return 0
  if (f >= 1) return 1
  const a = Math.pow(f, p)
  const b = Math.pow(1 - f, q)
  return a / (a + b)
}

/**
 * A keyframed gain as the audio mix applies it: the preview multiplies every
 * frame by `evalAnim(clip.gain, rel) × track gain`, and the export used to take
 * the value at the clip's first instant for the whole clip — every gain
 * keyframe was silently dropped from the file (HelpFreedom/kadr#41).
 *
 * Points over [from, from + dur] in clip-local seconds, returned relative to
 * `from`, each EVALUATED by evalAnim itself: a linear stretch is exact between
 * its keyframes, an eased or smooth one is sampled in CURVE_PIECES pieces, a
 * hold is a step (two points at one time). Clamped at 0 as the preview is.
 * Null for a gain without keyframes — those mix exactly as before.
 */
const CURVE_PIECES = 32
export function gainCurve(a: Anim | number | undefined, scale: number, from: number, dur: number): { t: number; v: number }[] | null {
  if (!a || typeof a !== 'object' || !a.keyframes?.length) return null
  const kfs = a.keyframes
  const to = from + dur
  const at = (t: number) => Math.max(0, evalAnim(a, t) * scale)
  const pts: { t: number; v: number }[] = []
  const times = new Set<number>([from, to])
  for (let i = 0; i < kfs.length; i++) {
    const k0 = kfs[i]
    if (k0.time > from && k0.time < to) times.add(k0.time)
    const k1 = kfs[i + 1]
    if (!k1 || k1.time <= from || k0.time >= to) continue
    // linear (and anything unknown, which eases linearly) is exact as it is;
    // a hold is a step, handled below
    if (a.smooth || (easingOf(k0.easing) !== ease.linear && k0.easing !== 'hold')) {
      for (let j = 1; j < CURVE_PIECES; j++) {
        const t = k0.time + ((k1.time - k0.time) * j) / CURVE_PIECES
        if (t > from && t < to) times.add(t)
      }
    }
  }
  for (const t of [...times].sort((x, y) => x - y)) {
    // a hold jumps AT the next keyframe: the value up to it, then the new one
    const k = kfs.findIndex((kf) => kf.time === t)
    if (!a.smooth && k > 0 && kfs[k - 1].easing === 'hold' && t > from) pts.push({ t: t - from, v: Math.max(0, kfs[k - 1].value * scale) })
    pts.push({ t: t - from, v: at(t) })
  }
  return pts
}

/** `{ gainCurve }` for a segment whose clip has gain keyframes, `{}` otherwise
 *  — a plain gain leaves the segment exactly as it always was */
export function gainCurveField(a: Anim | number | undefined, scale: number, from: number, dur: number): { gainCurve?: { t: number; v: number }[] } {
  const c = gainCurve(a, scale, from, dur)
  return c ? { gainCurve: c } : {}
}
