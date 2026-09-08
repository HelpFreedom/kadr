/**
 * Loudness envelope identical to Blender's "Bake Sound to F-Curves" with its
 * default settings — the input the user's neon-wave preset was driven by.
 *
 * Verified against the curves baked inside the preset (max error 0.0007, i.e.
 * the rounding of the reference): audaspace SUMS the channels (L+R, not the
 * mean), rectifies, then runs a one-pole follower whose coefficients are
 *   bt = 0.1^(1 / (attack · sr))    (attack 5 ms)
 *   rt = 0.1^(1 / (release · sr))   (release 200 ms)
 *   last = v + (v > last ? bt : rt) · (last − v)
 * and the per-frame value is the follower output linearly interpolated at
 * t = k / fps.
 *
 * Pure TypeScript on purpose (no node/electron imports): `scripts/check-envelope.mjs`
 * loads it straight into node, and the renderer could run it on decoded PCM too.
 */

export interface EnvelopeOpts {
  /** seconds, default 0.005 */
  attack?: number
  /** seconds, default 0.2 */
  release?: number
}

const AR_THRESHOLD = 0.1

/**
 * Streaming follower: feed interleaved PCM in chunks of any length (not
 * necessarily whole frames — a trailing partial frame is carried over), then
 * read `result()`. Memory is O(frames), never O(samples).
 */
export class EnvelopeFollower {
  private readonly bt: number
  private readonly rt: number
  private readonly step: number
  private last = 0
  /** absolute index of the next sample frame to be processed */
  private index = 0
  /** next output frame to fill */
  private k = 0
  private readonly out: number[]
  private carry: number[] = []
  private fed = false

  constructor(
    readonly sr: number,
    readonly channels: number,
    readonly fps: number,
    readonly frames: number,
    opts: EnvelopeOpts = {}
  ) {
    if (!(sr > 0) || !(channels > 0) || !(fps > 0)) throw new Error('envelope: bad format')
    const attack = Math.max(1e-6, opts.attack ?? 0.005)
    const release = Math.max(1e-6, opts.release ?? 0.2)
    this.bt = Math.pow(AR_THRESHOLD, 1 / (attack * sr))
    this.rt = Math.pow(AR_THRESHOLD, 1 / (release * sr))
    this.step = sr / fps
    this.out = new Array(Math.max(0, Math.floor(frames))).fill(0)
  }

  push(pcm: Float32Array | number[]): void {
    const ch = this.channels
    let i = 0
    const n = pcm.length
    // complete a carried partial frame first
    if (this.carry.length) {
      while (this.carry.length < ch && i < n) this.carry.push(pcm[i++])
      if (this.carry.length < ch) return
      let s = 0
      for (let c = 0; c < ch; c++) s += this.carry[c]
      this.carry = []
      this.feed(s)
    }
    const whole = Math.floor((n - i) / ch) * ch
    const end = i + whole
    for (; i < end; i += ch) {
      let s = 0
      for (let c = 0; c < ch; c++) s += pcm[i + c]
      this.feed(s)
    }
    for (; i < n; i++) this.carry.push(pcm[i])
  }

  /** one summed sample → follower → frame sampling */
  private feed(sum: number): void {
    this.fed = true
    const v = sum < 0 ? -sum : sum
    const prev = this.last
    const e = v + (v > prev ? this.bt : this.rt) * (prev - v)
    this.last = e
    const idx = this.index++
    // emit every output frame k whose sample position p = k·step lies in (idx−1, idx]
    while (this.k < this.out.length) {
      const p = this.k * this.step
      const i0 = Math.floor(p)
      if (i0 > idx) break
      const f = p - i0
      if (i0 === idx) {
        if (f !== 0) break // needs e(idx+1); handled when it arrives
        this.out[this.k++] = e
        continue
      }
      // i0 === idx − 1 (earlier frames were all consumed as they became computable)
      this.out[this.k++] = prev + f * (e - prev)
    }
  }

  /** Per-frame loudness, length === frames. Frames past the end of the audio hold the last value. */
  result(): number[] {
    const res = this.out.slice()
    if (this.k < res.length) {
      const tail = this.fed ? this.last : 0
      for (let k = this.k; k < res.length; k++) res[k] = tail
    }
    return res
  }
}

/** Whole-buffer convenience (tests, small clips). */
export function envelopeFrames(
  pcm: Float32Array | number[],
  sr: number,
  channels: number,
  fps: number,
  frames: number,
  opts?: EnvelopeOpts
): number[] {
  const f = new EnvelopeFollower(sr, channels, fps, frames, opts)
  f.push(pcm)
  return f.result()
}
