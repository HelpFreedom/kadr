/**
 * The preview's master limiter: ffmpeg's alimiter (libavfilter/af_alimiter.c,
 * n7.1) ported line for line, so the preview clips exactly where the export
 * does — at the export's parameters (shared/audioMaster.ts). The AudioWorklet
 * (src/engine/limiter.worklet.ts) runs it; scripts/check-preview-limiter.mjs
 * runs it in node against the real ffmpeg.
 *
 * Only the path the export uses is ported: asc (auto release) off, level
 * (auto level) off, level_in = level_out = 1. State is double precision, as in
 * the C; the order of every operation is kept, because the gain is an
 * accumulated ramp and a reordered division drifts it.
 *
 * Like alimiter, it DELAYS the signal by its look-ahead — `limiterLatency`,
 * 239 samples at 48 kHz. The export trims that delay away; the preview cannot
 * (it is live), so its audio runs 5 ms behind the picture — a third of a frame
 * at 60 fps, and thirty times under the player's resync tolerance.
 */
import { MASTER_LIMIT, MASTER_ATTACK_MS, MASTER_RELEASE_MS } from './audioMaster'

export { MASTER_LIMIT, MASTER_ATTACK_MS, MASTER_RELEASE_MS }

type Samples = ArrayLike<number>

export interface Limiter {
  /** n frames of planar input into planar output (arrays may be shorter than `channels`: missing ones read as silence / are dropped) */
  process(input: Samples[], output: { [i: number]: number }[], n: number): void
}

function bufferSize(sampleRate: number, channels: number, attackMs: number): number {
  let size = Math.trunc(sampleRate * (attackMs / 1000) * channels)
  size -= size % channels
  return size
}

/** samples of delay the limiter adds at this rate */
export function limiterLatency(sampleRate: number, channels = 2, attackMs = MASTER_ATTACK_MS): number {
  return bufferSize(sampleRate, channels, attackMs) / channels - 1
}

export function createLimiter(
  sampleRate: number, channels: number,
  limit = MASTER_LIMIT, attackMs = MASTER_ATTACK_MS, releaseMs = MASTER_RELEASE_MS
): Limiter {
  const release = releaseMs / 1000
  const size = bufferSize(sampleRate, channels, attackMs)
  if (size <= 0) throw new Error('attack is too small')
  const obuf = Math.trunc(sampleRate * channels * 100 / 1000 + channels)
  const buffer = new Float64Array(obuf)
  const nextdelta = new Float64Array(obuf)
  const nextpos = new Int32Array(obuf).fill(-1)
  let att = 1, delta = 0, pos = 0, nextiter = 0, nextlen = 0

  return {
    process(input, output, n) {
      for (let f = 0; f < n; f++) {
        let peak = 0
        for (let c = 0; c < channels; c++) {
          const sample = input[c] ? input[c][f] : 0
          buffer[pos + c] = sample
          peak = Math.max(peak, Math.abs(sample))
        }

        if (peak > limit) {
          const patt = Math.min(limit / peak, 1)
          const rdelta = (1.0 - patt) / (sampleRate * release)
          const d = (limit / peak - att) / size * channels
          let found = false
          if (d < delta) {
            delta = d
            nextpos[0] = pos
            nextpos[1] = -1
            nextdelta[0] = rdelta
            nextlen = 1
            nextiter = 0
          } else {
            let i = nextiter
            for (; i < nextiter + nextlen; i++) {
              const j = i % size
              let ppeak = 0
              if (nextpos[j] >= 0) {
                for (let c = 0; c < channels; c++) ppeak = Math.max(ppeak, Math.abs(buffer[nextpos[j] + c]))
              }
              // C integer division: (int % int) / int
              const span = Math.trunc(((size - nextpos[j] + pos) % size) / channels)
              const pdelta = (limit / peak - limit / ppeak) / span
              if (pdelta < nextdelta[j]) {
                nextdelta[j] = pdelta
                found = true
                break
              }
            }
            if (found) {
              nextlen = i - nextiter + 1
              nextpos[(nextiter + nextlen) % size] = pos
              nextdelta[(nextiter + nextlen) % size] = rdelta
              nextpos[(nextiter + nextlen + 1) % size] = -1
              nextlen++
            }
          }
        }

        const b = (pos + channels) % size
        peak = 0
        for (let c = 0; c < channels; c++) peak = Math.max(peak, Math.abs(buffer[b + c]))

        att += delta
        const g = att   // the C multiplies here; the lines below only move the state

        if (b === nextpos[nextiter]) {
          delta = nextdelta[nextiter]
          att = limit / peak
          nextlen -= 1
          nextpos[nextiter] = -1
          nextiter = (nextiter + 1) % size
        }

        if (att > 1) {
          att = 1
          delta = 0
          nextiter = 0
          nextlen = 0
          nextpos[0] = -1
        }
        if (att <= 0) {
          att = 0.0000000000001
          delta = (1.0 - att) / (sampleRate * release)
        }
        if (att !== 1 && (1 - att) < 0.0000000000001) att = 1
        if (delta !== 0 && Math.abs(delta) < 0.00000000000001) delta = 0

        for (let c = 0; c < channels; c++) {
          const out = output[c]
          if (out) out[f] = Math.min(limit, Math.max(-limit, buffer[b + c] * g))
        }
        pos = (pos + channels) % size
      }
    }
  }
}
