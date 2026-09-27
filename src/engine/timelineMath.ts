// Pure timeline maths, kept apart from the component so it can be checked in
// plain node (scripts/check-timeline.mjs): the waveform's per-pixel peaks and
// the overlap zones of a track. Both were rewritten for speed on a 1124-clip,
// 19-minute project, and both must give EXACTLY what the old, slow code gave.
import type { Clip } from '@shared/types'

/** A waveform as the timeline draws it: peak and RMS bins (0..255) at `rate` per second. */
export interface WaveBins {
  rate: number
  max: Uint8Array
  rms: Uint8Array
  /** window k: w[i] = the max of bins [i, i + 2^k) (clipped at the end), made
      on demand. Zoomed out, one pixel spans hundreds of bins (a quarter second
      at 1000 bins/s), and scanning them all for every pixel of every visible
      clip made a zoom step cost ~275 ms on an 1100-clip project; with one
      window, a pixel's range [a, b) is max(w[a], w[b − 2^k]) — the SAME value
      as the scan. (A pyramid of merged bins was tried first and rejected: it
      widened a lone click onto the neighbouring pixel in half the columns.) */
  windows: Map<number, { max: Uint8Array; rms: Uint8Array }>
}

/** the sliding-window maxima of width 2^k (see WaveBins.windows); a few kept per waveform */
export function waveWindow(wf: WaveBins, k: number): { max: Uint8Array; rms: Uint8Array } {
  const hit = wf.windows.get(k)
  if (hit) {
    wf.windows.delete(k) // most recently used last
    wf.windows.set(k, hit)
    return hit
  }
  const n = wf.max.length
  const max = wf.max.slice()
  const rms = wf.rms.slice()
  // doubling in place: before pass j every entry covers 2^(j-1) bins; reading a
  // HIGHER index while walking upwards still sees the previous pass's value
  for (let h = 1; h < 1 << k; h *= 2) {
    for (let i = 0; i < n; i++) {
      const o = Math.min(i + h, n - 1)
      if (max[o] > max[i]) max[i] = max[o]
      if (rms[o] > rms[i]) rms[i] = rms[o]
    }
  }
  wf.windows.set(k, { max, rms })
  if (wf.windows.size > 3) wf.windows.delete(wf.windows.keys().next().value!)
  return { max, rms }
}

/**
 * The peak and RMS of every device pixel column `x` in [0, cw) of a clip's
 * visible slice: the column covers the source from its own time for one
 * pixel's worth of source (`speed / (zoom · dpr)` seconds), looping the source
 * after `span` seconds. `vis0` = the slice's left edge, clip-local CSS px.
 */
export function waveColumns(wf: WaveBins, o: {
  cw: number; vis0: number; dpr: number; zoom: number; speed: number; inPoint: number; span: number
}): { peak: Uint8Array; rms: Uint8Array } {
  const peakOut = new Uint8Array(o.cw)
  const rmsOut = new Uint8Array(o.cw)
  const srcPerPx = o.speed / (o.zoom * o.dpr)
  const n = wf.max.length
  // Two windows of 2^k cover a range of L bins exactly when 2^k ≤ L < 2^(k+1),
  // so k is taken per pixel from ITS range: neighbouring pixels differ by a bin
  // or two (floor/ceil), and one k for all left the middle bin of the longer
  // ranges uncovered (8 columns in 688 773 read one unit low — caught by
  // scripts/check-timeline.mjs). At most two adjacent k per drawing.
  const wins: ({ max: Uint8Array; rms: Uint8Array } | undefined)[] = []
  for (let x = 0; x < o.cw; x++) {
    const localT = (o.vis0 + x / o.dpr) / o.zoom
    const srcT = o.inPoint + ((localT * o.speed) % o.span)
    const i0 = Math.floor(srcT * wf.rate)
    const i1 = Math.min(n, Math.max(i0 + 1, Math.ceil((srcT + srcPerPx) * wf.rate)))
    let peak = 0
    let rms = 0
    const len = i1 - i0
    const k = len >= 2 ? 31 - Math.clz32(len) : 0 // floor(log2(len))
    if (k > 0) {
      const win = (wins[k] ??= waveWindow(wf, k))
      const j = i1 - (1 << k)
      peak = Math.max(win.max[i0], win.max[j])
      rms = Math.max(win.rms[i0], win.rms[j])
    } else {
      for (let i = i0; i < i1; i++) {
        if (wf.max[i] > peak) peak = wf.max[i]
        if (wf.rms[i] > rms) rms = wf.rms[i]
      }
    }
    peakOut[x] = peak
    rmsOut[x] = rms
  }
  return { peak: peakOut, rms: rmsOut }
}

/** Overlap zones and butt joints of a track's clips — one sweep over the
    clips sorted by start (it was every pair: 136 000 comparisons per render on
    a 522-clip track, on every zoom step). Same result: a zone runs from a
    clip's start to the furthest end of the clips that started STRICTLY before
    it, capped at its own end. */
export function trackOverlaps(clips: Clip[]) {
  const zones: { clip: Clip; from: number; to: number }[] = []
  const joints: { a: Clip; b: Clip; at: number }[] = []
  const sorted = [...clips].sort((a, b) => a.start - b.start)
  let before = -Infinity // max end over clips with a smaller start
  let groupStart = NaN
  let groupEnd = -Infinity // max end within the run of equal starts
  for (let i = 0; i < sorted.length; i++) {
    const b = sorted[i]
    if (b.start !== groupStart) {
      before = Math.max(before, groupEnd)
      groupStart = b.start
      groupEnd = -Infinity
    }
    if (i > 0) {
      const coverEnd = before > b.start ? before : 0
      const to = Math.min(coverEnd, b.start + b.duration)
      if (to > b.start + 1e-6) zones.push({ clip: b, from: b.start, to })
      // butt joint: the previous clip ends exactly where this one starts
      const a = sorted[i - 1]
      if (Math.abs(a.start + a.duration - b.start) < 0.02) joints.push({ a, b, at: b.start })
    }
    groupEnd = Math.max(groupEnd, b.start + b.duration)
  }
  return { zones, joints }
}
