import type { Anim, Easing } from '@shared/types'

const ease: Record<Easing, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => t * (2 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  hold: () => 0
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
      return k0.value + (k1.value - k0.value) * ease[k0.easing](f)
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
