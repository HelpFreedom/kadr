// Keyframed clip gain in the export mix. The preview evaluates the clip's
// gain Anim per frame; the mix gets the same curve as piecewise-linear points
// in segment-local timeline seconds, turned into one ffmpeg `volume`
// expression that both mix paths (the single graph and the premix) run.
import type { Anim } from './types'

export interface GainKey {
  /** seconds from the segment's start, on the timeline */
  t: number
  v: number
}

/** a non-linear stretch between two keyframes becomes this many straight pieces at most */
const MAX_PIECES = 32
/** ...and none shorter than this (the mix applies the curve in 10 ms steps anyway) */
const MIN_PIECE = 0.02

/**
 * The gain curve over clip-local [from, to] as points relative to `from`, or
 * null when the gain does not change there (the caller keeps a plain scalar,
 * which mixes bit-identically to a clip that never had keyframes).
 * `at` is the evaluator the preview uses (evalAnim) — the easing maths lives
 * in one place; straight segments stay exact, eased/smooth ones are sampled.
 */
export function gainKeys(a: Anim, from: number, to: number, at: (t: number) => number): GainKey[] | null {
  const kfs = a.keyframes
  if (!kfs?.length) return null
  const pts: GainKey[] = []
  const push = (t: number, v: number) => pts.push({ t: t - from, v: Math.max(0, v) }) // the preview clamps at 0 too
  const inside = (t: number) => t > from && t < to
  push(from, at(from))
  for (let i = 0; i < kfs.length; i++) {
    const k = kfs[i]
    if (inside(k.time)) {
      if (i > 0 && kfs[i - 1].easing === 'hold' && !a.smooth) push(k.time, kfs[i - 1].value) // the step
      push(k.time, at(k.time))
    }
    const k1 = kfs[i + 1]
    if (!k1 || (k.easing === 'linear' && !a.smooth) || (k.easing === 'hold' && !a.smooth)) continue
    const span = k1.time - k.time
    const n = Math.min(MAX_PIECES, Math.max(1, Math.ceil(span / MIN_PIECE)))
    for (let j = 1; j < n; j++) {
      const t = k.time + (span * j) / n
      if (inside(t)) push(t, at(t))
    }
  }
  push(to, at(to))
  return pts.every((p) => p.v === pts[0].v) ? null : pts
}

const num = (x: number) => String(+x.toFixed(6))

/** ffmpeg expression of the curve in `t` (seconds): flat before and after, straight in between */
export function gainExpr(keys: GainKey[]): string {
  const first = keys[0]
  const last = keys[keys.length - 1]
  const terms = [`lt(t,${num(first.t)})*${num(first.v)}`]
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i]
    const b = keys[i + 1]
    if (b.t - a.t < 1e-9) continue // a step: the next piece starts at the new value
    const slope = (b.v - a.v) / (b.t - a.t)
    terms.push(`gte(t,${num(a.t)})*lt(t,${num(b.t)})*(${num(a.v)}+(${num(slope)})*(t-${num(a.t)}))`)
  }
  terms.push(`gte(t,${num(last.t)})*${num(last.v)}`)
  return terms.join('+')
}
