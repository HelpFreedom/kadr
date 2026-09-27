// Bars, downbeats, sections and pauses on top of the beat grid
// (shared/audioAnalysis.ts analyzeBeats — librosa's beat_track, verified beat
// for beat). Pure numbers, no node or DOM: scripts/check-beats.mjs runs it on
// synthetic audio with known bars.
//
// Why it exists: a 3D film cut to a song came out right only when its author
// found the song's "one" by hand — the kick's strength per phase — and ran a
// hierarchy on it: a big event on the first beat of a bar, a small one on the
// others, nothing in a pause. The beat grid alone has no bar: its 'strong'
// flag is the loudest quarter of the beats (whatever beat they fall on), and
// its every-4th phase was the loudest phase by overall intensity — both
// wandered, and both missed the pause before the chorus.
//
// What is measured, per beat: the KICK (the steepest rise of the < 150 Hz
// energy in −60..+40 ms — an attack, not a level), the SNARE (spectral flux
// 1.5–6 kHz) and the BASS LINE (flux of the mel bands under 250 Hz). The "one"
// of a 4/4 bar carries the kick and rarely the snare (the backbeat is 2 and 4),
// and harmony tends to change on it, so a beat scores
//   kick + 0.4·bass + 0.4·harmonic change − 0.3·snare   (each z-scored),
// and the phase whose beats score highest is the downbeat. 3/4 is chosen only
// when its best phase stands out clearly more than 4/4's. Sections are
// bar-synchronous: a self-similarity matrix of per-bar timbre (16 mel groups +
// loudness), Foote's checkerboard novelty, peaks at least 4 bars apart. Labels
// are a heuristic of energy and repetition and are reported as such.
import {
  type AudioFrames, type BeatAnalysis, envDb, envelopeBand, quantile, melCenters, LOW_ENV_DELAY_MS, ENV_RATE
} from './audioAnalysis'

export type SectionLabel = 'intro' | 'verse' | 'build' | 'chorus' | 'break' | 'outro'

export interface RhythmBeat {
  /** 1-based bar number; 0 = a pickup before the first downbeat */
  bar: number
  /** 1..meter */
  beatInBar: number
  /** 0..1 over the piece: kick attack, snare, bass-line onset */
  kick: number
  snare: number
  low: number
}

export interface Section {
  start: number
  end: number
  /** bar number of its first bar */
  startBar: number
  bars: number
  label: SectionLabel
  /** 0..1 between the quietest and the loudest section of the piece */
  energy: number
  /** index of an earlier section this one repeats (similar timbre), if any */
  repeatOf?: number
}

export interface Rhythm {
  meter: 3 | 4
  /** 0..1 — how clearly the chosen meter's downbeat phase stands out against the other meter's */
  meterConfidence: number
  /** 0..1 — how clearly the downbeat phase stands out against the next best phase */
  phaseConfidence: number
  /** parallel to BeatAnalysis.beats */
  beats: RhythmBeat[]
  sections: Section[]
  /** where the music stops for ≥ 0.3 s inside the piece (drums out, a
      break) — `depth`: dB under the 3 s before it */
  pauses: { start: number; end: number; depth: number }[]
  /** loudness 0..1 (5th..95th percentile of the piece), `rate` values per second */
  energy: { rate: number; values: number[] }
  /** where the kick attacks sit against the grid, ms (negative = before the beat) */
  kickOffsetMs?: { median: number; p90: number; clear: number; total: number }
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))

function zscore(v: number[]): number[] {
  const n = v.length
  if (!n) return v
  const m = v.reduce((s, x) => s + x, 0) / n
  const sd = Math.sqrt(v.reduce((s, x) => s + (x - m) * (x - m), 0) / n) || 1
  return v.map((x) => (x - m) / sd)
}

/** 0..1 by the 95th percentile (0 stays 0) */
function norm95(v: number[]): number[] {
  const s = [...v].sort((a, b) => a - b)
  const top = s.length ? s[Math.floor(0.95 * (s.length - 1))] : 0
  return v.map((x) => (top > 1e-12 ? clamp01(x / top) : 0))
}

/** mean positive frame-to-frame rise of the mel bands in [lo, hi) Hz, per frame */
function bandFlux(a: AudioFrames, lo: number, hi: number): Float64Array {
  const out = new Float64Array(a.frames)
  const M = a.nMels ?? 0
  if (!a.mel || !M) return out
  const centers = melCenters(a.sr, M)
  const bins: number[] = []
  for (let m = 0; m < M; m++) if (centers[m] >= lo && centers[m] < hi) bins.push(m)
  if (!bins.length) return out
  for (let t = 1; t < a.frames; t++) {
    let s = 0
    for (const b of bins) {
      const d = a.mel[t * M + b] - a.mel[(t - 1) * M + b]
      if (d > 0) s += d
    }
    out[t] = s / bins.length
  }
  return out
}

/** mean of 16 mel groups over frames [f0, f1) — a coarse timbre vector */
function timbre(a: AudioFrames, f0: number, f1: number): number[] {
  const M = a.nMels ?? 0
  const G = 16
  const out = new Array(G).fill(0)
  if (!a.mel || !M || f1 <= f0) return out
  const per = M / G
  for (let t = f0; t < f1; t++) {
    for (let m = 0; m < M; m++) out[Math.min(G - 1, Math.floor(m / per))] += a.mel[t * M + m]
  }
  const n = (f1 - f0) * per
  return out.map((x) => x / n)
}

const cosine = (x: number[], y: number[]) => {
  let d = 0, nx = 0, ny = 0
  for (let i = 0; i < x.length; i++) { d += x[i] * y[i]; nx += x[i] * x[i]; ny += y[i] * y[i] }
  return nx > 0 && ny > 0 ? d / Math.sqrt(nx * ny) : 0
}

/** mean-square envelope (1 ms steps) → dB over windows of `ms` */
function windowDb(env: Float32Array, ms: number): number[] {
  const out: number[] = []
  for (let i = 0; i + ms <= env.length; i += ms) {
    let s = 0
    for (let j = i; j < i + ms; j++) s += env[j]
    out.push(10 * Math.log10(Math.max(1e-12, s / ms)))
  }
  return out
}

export function analyzeRhythm(a: AudioFrames, beatsIn: BeatAnalysis): Rhythm {
  const beats = beatsIn.beats
  const n = beats.length
  const fr = a.frameRate
  if (n < 8 || !a.mel) {
    // too little to find a bar in: every beat a "one", no sections
    return {
      meter: 4, meterConfidence: 0, phaseConfidence: 0,
      beats: beats.map((_, i) => ({ bar: i + 1, beatInBar: 1, kick: 0, snare: 0, low: 0 })),
      sections: [], pauses: [], energy: { rate: 10, values: [] }
    }
  }
  const frameOf = (t: number) => Math.max(0, Math.min(a.frames - 1, Math.round(t * fr)))
  const duration = a.envFull.length / ENV_RATE

  // ---- per-beat features ----------------------------------------------------
  const lowDb = envDb(a.envLow, LOW_ENV_DELAY_MS, 20)
  const kickRaw = beats.map((b) => {
    const B = Math.round(b.time * ENV_RATE)
    let best = 0
    for (let t = B - 60; t <= B + 40; t++) {
      if (t - 20 < 0 || t + 20 >= lowDb.length) continue
      best = Math.max(best, lowDb[t + 20] - lowDb[t - 20])
    }
    return best
  })
  const snareFlux = bandFlux(a, 1500, 6000)
  const lowFlux = bandFlux(a, 30, 250)
  const around = (f: Float64Array, t: number) => {
    const c = frameOf(t)
    let m = 0
    for (let k = Math.max(0, c - 2); k <= Math.min(a.frames - 1, c + 2); k++) m = Math.max(m, f[k])
    return m
  }
  const snareRaw = beats.map((b) => around(snareFlux, b.time))
  const lowRaw = beats.map((b) => around(lowFlux, b.time))
  // harmonic/timbral change across the beat: the beat before vs the beat after
  const novRaw = beats.map((b, i) => {
    const prev = i > 0 ? beats[i - 1].time : Math.max(0, b.time - 0.5)
    const next = i + 1 < n ? beats[i + 1].time : Math.min(duration, b.time + 0.5)
    return 1 - cosine(timbre(a, frameOf(prev), frameOf(b.time)), timbre(a, frameOf(b.time), frameOf(next)))
  })
  const kick = norm95(kickRaw)
  const snare = norm95(snareRaw)
  const low = norm95(lowRaw)

  // ---- meter and downbeat phase ---------------------------------------------
  const zk = zscore(kickRaw), zl = zscore(lowRaw), zn = zscore(novRaw), zs = zscore(snareRaw)
  const score = beats.map((_, i) => zk[i] + 0.4 * zl[i] + 0.4 * zn[i] - 0.3 * zs[i])
  const phaseScores = (m: number, from = 0, to = n) => {
    const out: number[] = []
    for (let p = 0; p < m; p++) {
      let s = 0, c = 0
      for (let i = from; i < to; i++) if ((((i - p) % m) + m) % m === 0) { s += score[i]; c++ }
      out.push(c ? s / c : -Infinity)
    }
    return out
  }
  const best = (xs: number[]) => {
    let bi = 0
    for (let i = 1; i < xs.length; i++) if (xs[i] > xs[bi]) bi = i
    const rest = xs.filter((_, i) => i !== bi)
    const second = Math.max(...rest)
    const mean = rest.reduce((s, x) => s + x, 0) / Math.max(1, rest.length)
    return { phase: bi, top: xs[bi], second, contrast: xs[bi] - mean }
  }
  const b4 = best(phaseScores(4))
  const b3 = best(phaseScores(3))
  const meter: 3 | 4 = n >= 12 && b3.contrast > 1.3 * Math.max(0, b4.contrast) && b3.contrast > 0.5 ? 3 : 4
  const chosen = meter === 4 ? b4 : b3
  const other = meter === 4 ? b3 : b4
  const meterConfidence = clamp01(chosen.contrast > 0 ? (chosen.contrast - Math.max(0, other.contrast)) / chosen.contrast : 0)
  const phaseConfidence = clamp01(chosen.top - chosen.second)

  // bar numbers from a downbeat phase, from beat `from` on (phase may be
  // re-decided per section below)
  const phaseAt = new Array(n).fill(chosen.phase)
  const numberBars = () => {
    const out: { bar: number; beatInBar: number }[] = []
    let bar = 0
    for (let i = 0; i < n; i++) {
      const pos = (((i - phaseAt[i]) % meter) + meter) % meter
      if (pos === 0) bar++
      out.push({ bar: pos === 0 || bar > 0 ? bar : 0, beatInBar: pos + 1 })
    }
    return out
  }
  let numbered = numberBars()

  // ---- pauses (before sections: a pause always ends a section) ---------------
  // A pause in music is rarely silence: on the song that motivated this the
  // drums stop for half a beat before the chorus and the level falls from
  // −5 to −17…−30 dB (100 ms windows) with a −14 dB tail between — well above
  // any "silence" threshold. So: a window is quiet when it is 12 dB under the
  // loud level of the 3 s before it; quiet runs closer than 0.25 s merge, and
  // what lasts 0.3 s or more is a pause. The dips between kicks inside a verse
  // are shorter and further apart.
  const STEP = 50
  const w50 = windowDb(a.envFull, STEP)
  const win100 = w50.map((_, i) => {
    const x = Math.pow(10, w50[i] / 10), y = Math.pow(10, (w50[i + 1] ?? w50[i]) / 10)
    return 10 * Math.log10(Math.max(1e-12, (x + y) / 2))
  })
  const pauses: { start: number; end: number; depth: number }[] = []
  {
    const back = Math.round(3000 / STEP)
    const runs: [number, number][] = []
    let s = -1
    for (let i = 0; i <= win100.length; i++) {
      let quiet = false
      if (i < win100.length && i >= 10) {
        const ref = win100.slice(Math.max(0, i - back), i).sort((x, y) => x - y)
        quiet = win100[i] < quantile(ref, 0.9) - 12
      }
      if (quiet && s < 0) s = i
      if (!quiet && s >= 0) { runs.push([s, i + 1]); s = -1 } // a 100 ms window reaches one step past its start
    }
    const merged: { a: number; b: number; quiet: number }[] = []
    for (const [r0, r1] of runs) {
      const last = merged[merged.length - 1]
      if (last && (r0 - last.b) * STEP <= 250) { last.b = r1; last.quiet += r1 - r0 }
      else merged.push({ a: r0, b: r1, quiet: r1 - r0 })
    }
    // the mean level (power) over a stretch, from the 1 ms envelope
    const meanDb = (t0: number, t1: number) => {
      const i0 = Math.max(0, Math.round(t0 * ENV_RATE)), i1 = Math.min(a.envFull.length, Math.round(t1 * ENV_RATE))
      let sum = 0
      for (let j = i0; j < i1; j++) sum += a.envFull[j]
      return 10 * Math.log10(Math.max(1e-12, sum / Math.max(1, i1 - i0)))
    }
    // inside the music only: not the silence before the first bar (a pickup
    // and the gap after it) or after the last beat
    const d0 = numbered.findIndex((x) => x.beatInBar === 1 && x.bar > 0)
    const first = beats[Math.max(0, d0)].time, last = beats[n - 1].time
    const cands: { start: number; end: number; depth: number }[] = []
    for (const m of merged) {
      const start = (m.a * STEP) / ENV_RATE, end = (m.b * STEP) / ENV_RATE
      if (end - start < 0.3 || start < first || end > last) continue
      // merging must not turn loud stretches into a "pause": mostly quiet,
      // and clearly quieter than what came before as a whole
      const depth = meanDb(start - 3, start) - meanDb(start, end)
      if (m.quiet / (m.b - m.a) < 0.5 || depth < 5) continue
      cands.push({ start, end, depth: Math.round(depth * 10) / 10 })
    }
    // A pause is an EXCEPTION, not a pattern: in a sparse arrangement the gap
    // between hits is just as far under the peaks, once a bar, every bar
    // (measured on a synthetic kick/snare/bass song: a "pause" in each of 31
    // bars). A dip with another as long and about as deep within 8 s is the
    // texture; a stop far deeper than the dips around it is still a pause.
    for (const c of cands) {
      const alike = cands.some((o) => o !== c && Math.abs(o.start - c.start) < 8 &&
        (o.end - o.start) >= 0.5 * (c.end - c.start) && o.depth >= c.depth - 3)
      if (!alike) pauses.push(c)
    }
  }

  // ---- bars → timbre → novelty → sections -------------------------------------
  const barStarts: number[] = [] // beat indices of downbeats
  numbered.forEach((x, i) => { if (x.beatInBar === 1 && x.bar > 0) barStarts.push(i) })
  const barTime = (k: number) => (k < barStarts.length ? beats[barStarts[k]].time : duration)
  const B = barStarts.length
  const feats: number[][] = []
  for (let k = 0; k < B; k++) {
    const f0 = frameOf(barTime(k)), f1 = Math.max(f0 + 1, frameOf(barTime(k + 1)))
    let rms = 0
    for (let f = f0; f < f1; f++) rms += a.rms[f] * a.rms[f]
    feats.push([...timbre(a, f0, f1), 10 * Math.log10(Math.max(1e-12, rms / (f1 - f0)))])
  }
  // z-score every dimension across bars, so timbre and loudness weigh alike
  const dims = feats[0]?.length ?? 0
  const zf = feats.map((v) => [...v])
  for (let d = 0; d < dims; d++) {
    const col = zscore(feats.map((v) => v[d]))
    col.forEach((x, k) => { zf[k][d] = x })
  }
  const sim = (i: number, j: number) => cosine(zf[i], zf[j])
  const L = 4
  const novelty = new Array(B).fill(0)
  for (let k = L; k <= B - L; k++) {
    let s = 0
    for (let i = -L; i < L; i++) {
      for (let j = -L; j < L; j++) {
        const g = Math.exp(-((i + 0.5) ** 2 + (j + 0.5) ** 2) / (2 * (L / 2) ** 2))
        const sign = (i < 0) === (j < 0) ? 1 : -1
        s += sign * g * sim(k + i, k + j)
      }
    }
    novelty[k] = s
  }
  const nz = novelty.slice(L, B - L + 1)
  const nMean = nz.reduce((s, x) => s + x, 0) / Math.max(1, nz.length)
  const nSd = Math.sqrt(nz.reduce((s, x) => s + (x - nMean) ** 2, 0) / Math.max(1, nz.length)) || 1
  const cand: number[] = []
  for (let k = L; k <= B - L; k++) {
    const v = novelty[k]
    if (v < nMean + 0.5 * nSd) continue
    let peak = true
    for (let d = -2; d <= 2; d++) if (d && novelty[k + d] !== undefined && novelty[k + d] > v) peak = false
    if (peak) cand.push(k)
  }
  // at least 4 bars apart: keep the stronger of two close peaks
  cand.sort((x, y) => novelty[y] - novelty[x])
  const bounds: number[] = []
  for (const k of cand) if (bounds.every((b) => Math.abs(b - k) >= 4)) bounds.push(k)
  // Timbre novelty misses a song that GROWS: the intro of the song this was
  // built on rose −21 → −16 → −14 → −10 dB over four bars with the same
  // instruments, and its author cut intro | build | verse exactly at the two
  // steps. A bar ≥ 3 dB louder or quieter than the one before (and the
  // biggest step within a bar either side) starts a section too.
  const barDb = feats.map((f) => f[dims - 1])
  for (let k = 1; k < B; k++) {
    const d = Math.abs(barDb[k] - barDb[k - 1])
    if (d < 3) continue
    const nb = (j: number) => (j >= 1 && j < B ? Math.abs(barDb[j] - barDb[j - 1]) : 0)
    if (nb(k - 1) > d || nb(k + 1) > d) continue
    if (bounds.every((b) => Math.abs(b - k) >= 2)) bounds.push(k)
  }
  // a pause ends a section: the bar that starts after it begins a new one
  for (const p of pauses) {
    let k = 0
    while (k < B && barTime(k) < p.end - 0.05) k++
    if (k > 0 && k < B && bounds.every((b) => Math.abs(b - k) >= 2)) bounds.push(k)
  }
  bounds.sort((x, y) => x - y)
  let spans: [number, number][] = []
  let from = 0
  for (const b of bounds) { if (b > from) spans.push([from, b]); from = b }
  if (B > from) spans.push([from, B])
  // nothing shorter than 2 bars: merge into the more similar neighbour
  const meanFeat = ([s, e]: [number, number]) => {
    const out = new Array(dims).fill(0)
    for (let k = s; k < e; k++) for (let d = 0; d < dims; d++) out[d] += zf[k][d] / (e - s)
    return out
  }
  for (let changed = true; changed && spans.length > 1;) {
    changed = false
    for (let i = 0; i < spans.length; i++) {
      if (spans[i][1] - spans[i][0] >= 2) continue
      const me = meanFeat(spans[i])
      const left = i > 0 ? cosine(me, meanFeat(spans[i - 1])) : -Infinity
      const right = i + 1 < spans.length ? cosine(me, meanFeat(spans[i + 1])) : -Infinity
      if (left >= right) { spans[i - 1] = [spans[i - 1][0], spans[i][1]] } else { spans[i + 1] = [spans[i][0], spans[i + 1][1]] }
      spans.splice(i, 1)
      changed = true
      break
    }
  }

  // neighbours that sound the same and are as loud are one section (the
  // loudness steps above cut on dynamics alone)
  const spanDb = (sp: [number, number]) => {
    let sum = 0
    for (let k = sp[0]; k < sp[1]; k++) sum += barDb[k]
    return sum / Math.max(1, sp[1] - sp[0])
  }
  for (let i = 1; i < spans.length;) {
    if (cosine(meanFeat(spans[i - 1]), meanFeat(spans[i])) > 0.95 && Math.abs(spanDb(spans[i - 1]) - spanDb(spans[i])) < 2) {
      spans[i - 1] = [spans[i - 1][0], spans[i][1]]
      spans.splice(i, 1)
    } else i++
  }

  // section bounds as BEAT indices: the bars may be renumbered below
  const spanBeats = spans.map(([s, e]) => [barStarts[s], e < B ? barStarts[e] : n] as [number, number])

  // ---- the downbeat phase, re-decided per section ------------------------------
  // Songs have bars of 2 beats, pickups and edits: a section of ≥ 8 bars whose
  // own best phase beats the global one clearly takes its own.
  if (B >= 8) {
    let moved = false
    for (const [s, e] of spans) {
      if (e - s < 8) continue
      const i0 = barStarts[s], i1 = e < B ? barStarts[e] : n
      const local = best(phaseScores(meter, i0, i1))
      const global = phaseScores(meter, i0, i1)[chosen.phase]
      if (local.phase !== chosen.phase && local.top - global > 0.6) {
        for (let i = i0; i < i1; i++) phaseAt[i] = local.phase
        moved = true
      }
    }
    if (moved) numbered = numberBars()
  }
  // a section starts on a downbeat of the FINAL numbering (the nearest one)
  const downs: number[] = []
  numbered.forEach((x, i) => { if (x.beatInBar === 1 && x.bar > 0) downs.push(i) })
  const snapDown = (i: number) => {
    if (i >= n || !downs.length) return i
    let bestI = downs[0]
    for (const d of downs) if (Math.abs(d - i) < Math.abs(bestI - i)) bestI = d
    return bestI
  }
  for (const sb of spanBeats) { sb[0] = snapDown(sb[0]); sb[1] = sb[1] >= n ? n : snapDown(sb[1]) }

  // ---- energies, repeats and labels -------------------------------------------
  const secDb = spans.map(([s, e]) => {
    let sum = 0
    for (let k = s; k < e && k < feats.length; k++) sum += feats[k][dims - 1]
    return sum / Math.max(1, e - s)
  })
  const lo = Math.min(...secDb), hi = Math.max(...secDb)
  const energyOf = (i: number) => (hi - lo > 0.5 ? (secDb[i] - lo) / (hi - lo) : 0.5)
  const feat = spans.map(meanFeat)
  const repeatOf = spans.map((_, j) => {
    let bestK = -1, bestS = 0.85
    for (let k = 0; k < j; k++) {
      const c = cosine(feat[j], feat[k])
      if (c > bestS) { bestS = c; bestK = k }
    }
    return bestK >= 0 ? bestK : undefined
  })
  const energies = spans.map((_, i) => energyOf(i))
  // the chorus is the loud END of the piece, not its loudest 30 %: a song
  // whose verses are almost as loud had half its sections called choruses
  const hiE = Math.max(...energies) - 0.15
  const labels: SectionLabel[] = spans.map((_, i) => {
    const e = energies[i]
    if (i === 0 && e < 0.5 && spans.length > 1) return 'intro'
    if (i === spans.length - 1 && e < 0.5 && spans.length > 1) return 'outro'
    if (e >= hiE && e >= 0.6) return 'chorus'
    if (e < 0.35) return 'break'
    return 'verse'
  })
  // a short section that rises into a louder one is a build
  for (let i = 0; i + 1 < spans.length; i++) {
    if (labels[i] === 'chorus' || energies[i + 1] <= energies[i]) continue
    const [s, e] = spans[i]
    if (e - s < 2 || e - s > 8) continue
    const half = Math.floor((s + e) / 2)
    const d = (x: number, y: number) => {
      let sum = 0
      for (let k = x; k < y; k++) sum += feats[k][dims - 1]
      return sum / Math.max(1, y - x)
    }
    if (d(half, e) - d(s, half) >= 1.5) labels[i] = 'build'
  }
  const tOf = (i: number) => (i < n ? beats[i].time : duration)
  const sections: Section[] = spans.map((_, i) => ({
    start: i === 0 ? 0 : tOf(spanBeats[i][0]),
    end: i === spans.length - 1 ? duration : tOf(spanBeats[i][1]),
    startBar: numbered[Math.min(n - 1, spanBeats[i][0])].bar || 1,
    bars: Math.max(1, Math.round((spanBeats[i][1] - spanBeats[i][0]) / meter)),
    label: labels[i],
    energy: Math.round(energies[i] * 1000) / 1000,
    ...(repeatOf[i] !== undefined ? { repeatOf: repeatOf[i] } : {})
  }))

  // ---- loudness curve ---------------------------------------------------------
  const E = 100 // ms → 10 values a second
  const edb = windowDb(a.envFull, E)
  const eS = [...edb].sort((x, y) => x - y)
  const p5 = eS.length ? quantile(eS, 0.05) : 0, p95 = eS.length ? quantile(eS, 0.95) : 1
  const energy = { rate: ENV_RATE / E, values: edb.map((x) => Math.round(clamp01((x - p5) / Math.max(1e-6, p95 - p5)) * 1000) / 1000) }

  // ---- where the kick sits against the grid -----------------------------------
  const lowBand = envelopeBand('low', a.envLow, LOW_ENV_DELAY_MS, 20)
  const offs = beats.map((b) => lowBand.offsetOf(b.time)).filter((o): o is number => o !== null)
  const kickOffsetMs = offs.length >= 8
    ? {
        median: Math.round(quantile([...offs].sort((x, y) => x - y), 0.5)),
        p90: Math.round(quantile(offs.map(Math.abs).sort((x, y) => x - y), 0.9)),
        clear: offs.length,
        total: n
      }
    : undefined

  const r3 = (x: number) => Math.round(x * 1000) / 1000
  return {
    meter,
    meterConfidence: r3(meterConfidence),
    phaseConfidence: r3(phaseConfidence),
    beats: numbered.map((x, i) => ({ ...x, kick: r3(kick[i]), snare: r3(snare[i]), low: r3(low[i]) })),
    sections,
    pauses: pauses.map((p) => ({ start: r3(p.start), end: r3(p.end), depth: p.depth })),
    energy,
    ...(kickOffsetMs ? { kickOffsetMs } : {})
  }
}
