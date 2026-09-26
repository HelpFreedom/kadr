/**
 * Music analysis for the timeline: onset strength, tempo, a beat grid with a
 * per-beat strength, and per-frame band energies for audio-reactive fragments.
 *
 * The beat path is a port of librosa 0.10's `beat_track` with its defaults —
 * the same analysis the /brag skill (latent-spaces/brag) precomputes its music
 * cues with, so its published cue files serve as a reference:
 *   onset_strength: |STFT|² (Hann, n_fft 2048, hop 512, centred, zero pad) →
 *     128 Slaney mel bands → power_to_db (ref 1, amin 1e-10, top_db 80 against
 *     the GLOBAL max) → first difference, half-wave rectified, mean over bands,
 *     shifted by lag + n_fft/(2·hop) = 3 frames (a centred window sees an
 *     onset half a window early; the shift puts the peak back on the onset)
 *   tempo: autocorrelation tempogram (8 s Hann windows, per-frame max-norm),
 *     mean over time, weighted by a log-normal prior around 120 BPM (σ = 1
 *     octave), nothing at or above 320 BPM
 *   beats: Ellis' dynamic programme — local score = onsets/σ convolved with a
 *     Gaussian of the period, predecessors searched in [−2P, −P/2] with a
 *     −100·log²(Δ/P) penalty, backtracked from the last strong local maximum,
 *     weak beats trimmed at both ends.
 * Two deliberate departures, both marked where they happen: the tempogram mean
 * is taken over at most ~2000 evenly spaced frames (a long project would cost
 * minutes otherwise and the mean does not move), and the bass band for the
 * beat strength comes from the same 2048-point FFT (brag used 4096).
 *
 * The strength of a beat is brag's formula:
 *   0.45·onset + 0.25·local onset contrast + 0.20·RMS + 0.10·bass
 * each normalised to 0..1 by its 98th percentile over the whole range.
 *
 * One addition on top of librosa, and only where librosa is measurably wrong:
 * `alignBeatsToAttacks` (see there) moves a grid that sits SYSTEMATICALLY after
 * the audible attacks — a brickwalled phonk track measured 110 ms — onto them.
 * On a track where librosa lands on the attacks nothing moves, so the parity
 * check against its published beats still holds.
 *
 * Pure TypeScript on purpose (no node/electron imports): `scripts/check-beats.mjs`
 * runs it in plain node, main feeds it PCM from ffmpeg.
 */

// --------------------------------------------------------------------- FFT

/** In-place iterative radix-2 complex FFT. n must be a power of two. */
class FFT {
  private readonly rev: Uint32Array
  private readonly cos: Float64Array
  private readonly sin: Float64Array
  constructor(readonly n: number) {
    if (n & (n - 1)) throw new Error('fft: n must be a power of two')
    const bits = Math.log2(n)
    this.rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
      let r = 0
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
      this.rev[i] = r
    }
    this.cos = new Float64Array(n / 2)
    this.sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n)
      this.sin[i] = -Math.sin((2 * Math.PI * i) / n)
    }
  }
  run(re: Float64Array, im: Float64Array): void {
    const n = this.n
    for (let i = 0; i < n; i++) {
      const j = this.rev[i]
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t
        t = im[i]; im[i] = im[j]; im[j] = t
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1
      const step = n / size
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step]
          const wi = this.sin[k * step]
          const a = start + k
          const b = a + half
          const xr = re[b] * wr - im[b] * wi
          const xi = re[b] * wi + im[b] * wr
          re[b] = re[a] - xr
          im[b] = im[a] - xi
          re[a] += xr
          im[a] += xi
        }
      }
    }
  }
}

// ------------------------------------------------------------ mel filters

const hzToMel = (f: number) => {
  // Slaney: linear below 1 kHz, logarithmic above (librosa htk=False)
  const fSp = 200 / 3
  const minLogHz = 1000
  const minLogMel = minLogHz / fSp
  const logstep = Math.log(6.4) / 27
  return f >= minLogHz ? minLogMel + Math.log(f / minLogHz) / logstep : f / fSp
}
const melToHz = (m: number) => {
  const fSp = 200 / 3
  const minLogHz = 1000
  const minLogMel = minLogHz / fSp
  const logstep = Math.log(6.4) / 27
  return m >= minLogMel ? minLogHz * Math.exp(logstep * (m - minLogMel)) : fSp * m
}

interface MelBand { from: number; w: Float64Array }

/** librosa.filters.mel(sr, n_fft, n_mels, fmin=0, fmax=sr/2, htk=False, norm='slaney'), stored sparse. */
function melFilters(sr: number, nFft: number, nMels: number): MelBand[] {
  const bins = nFft / 2 + 1
  const fft = new Float64Array(bins)
  for (let i = 0; i < bins; i++) fft[i] = (i * sr) / nFft
  const mMin = hzToMel(0)
  const mMax = hzToMel(sr / 2)
  const melF = new Float64Array(nMels + 2)
  for (let i = 0; i < nMels + 2; i++) melF[i] = melToHz(mMin + ((mMax - mMin) * i) / (nMels + 1))
  const bands: MelBand[] = []
  for (let m = 0; m < nMels; m++) {
    const lo = melF[m], c = melF[m + 1], hi = melF[m + 2]
    const enorm = 2 / (hi - lo)
    let from = -1
    const vals: number[] = []
    for (let b = 0; b < bins; b++) {
      const lower = (fft[b] - lo) / (c - lo)
      const upper = (hi - fft[b]) / (hi - c)
      const w = Math.max(0, Math.min(lower, upper)) * enorm
      if (w > 0) {
        if (from < 0) from = b
        // keep the run contiguous: fill any zero gap (cannot occur for a triangle, but cheap)
        while (from + vals.length < b) vals.push(0)
        vals.push(w)
      }
    }
    bands.push({ from: Math.max(0, from), w: Float64Array.from(vals) })
  }
  return bands
}

// --------------------------------------------------------------- analyser

export interface AnalysisOpts {
  /** default 2048 */
  nFft?: number
  /** default 512 */
  hop?: number
  /** default 128 */
  nMels?: number
}

/** Band edges (Hz) for the per-frame energies. */
export const BANDS = {
  bass: [30, 250],
  mid: [250, 2000],
  treble: [2000, 8000]
} as const

export interface AudioFrames {
  sr: number
  hop: number
  /** analysis frames per second (sr / hop) */
  frameRate: number
  frames: number
  /** librosa onset strength, one value per frame */
  onset: Float32Array
  /** time-domain RMS of each (unwindowed, centred) frame */
  rms: Float32Array
  /** mean |X| inside each band */
  bass: Float32Array
  mid: Float32Array
  treble: Float32Array
  /** energy envelopes at ENV_RATE (mean square per millisecond, t = 0 at index
      0): below ATTACK_LOWPASS Hz, and the whole band — for attack timing */
  envLow: Float32Array
  envFull: Float32Array
}

/** attack envelopes: one value per millisecond */
export const ENV_RATE = 1000
/** the low band the attacks are looked for in first (kick, 808) */
export const ATTACK_LOWPASS = 150

/** one RBJ low-pass biquad (Butterworth Q), state kept across chunks */
class Lowpass {
  private b0: number; private b1: number; private b2: number; private a1: number; private a2: number
  private x1 = 0; private x2 = 0; private y1 = 0; private y2 = 0
  constructor(sr: number, fc: number) {
    const w = (2 * Math.PI * fc) / sr
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2)
    const c = Math.cos(w)
    const a0 = 1 + alpha
    this.b0 = (1 - c) / 2 / a0
    this.b1 = (1 - c) / a0
    this.b2 = (1 - c) / 2 / a0
    this.a1 = (-2 * c) / a0
    this.a2 = (1 - alpha) / a0
  }
  step(x: number): number {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y
    return y
  }
}

/** growable float store — frames arrive one by one, their count is unknown up front */
class Grow {
  data: Float32Array
  length = 0
  constructor(private readonly stride: number, initial = 1024) {
    this.data = new Float32Array(initial * stride)
  }
  push(values: ArrayLike<number>): void {
    const need = (this.length + 1) * this.stride
    if (need > this.data.length) {
      const next = new Float32Array(Math.max(need, this.data.length * 2))
      next.set(this.data)
      this.data = next
    }
    const at = this.length * this.stride
    for (let i = 0; i < this.stride; i++) this.data[at + i] = values[i]
    this.length++
  }
  view(): Float32Array {
    return this.data.subarray(0, this.length * this.stride)
  }
}

/**
 * Streaming analyser: push MONO PCM in chunks of any length, then finish().
 * Frames follow librosa's centred STFT: frame k is centred on sample k·hop, the
 * signal is zero-padded by n_fft/2 on both sides, and there are
 * 1 + floor(samples / hop) frames.
 */
export class AudioAnalyzer {
  private readonly nFft: number
  private readonly hop: number
  private readonly nMels: number
  private readonly fft: FFT
  private readonly win: Float64Array
  private readonly mel: MelBand[]
  private readonly re: Float64Array
  private readonly im: Float64Array
  private readonly bandBins: Record<keyof typeof BANDS, [number, number]>
  /** padded signal not yet consumed; buf[0] is padded-signal sample `base` */
  private buf: Float32Array
  private bufLen = 0
  private base = 0
  /** padded-signal index of the next frame's first sample */
  private next = 0
  private samples = 0
  private frameCount = 0
  private finished = false
  private readonly melDb: Grow
  private readonly scalars: Grow // rms, bass, mid, treble
  // attack envelopes: two cascaded biquads (4th-order Butterworth) for the low
  // band, mean square per millisecond bucket for both
  private readonly lp1: Lowpass
  private readonly lp2: Lowpass
  private readonly envLow: Grow
  private readonly envFull: Grow
  private bucket = 0
  private accLow = 0
  private accFull = 0
  private accN = 0

  constructor(readonly sr: number, opts: AnalysisOpts = {}) {
    if (!(sr > 0)) throw new Error('analysis: bad sample rate')
    this.nFft = opts.nFft ?? 2048
    this.hop = opts.hop ?? 512
    this.nMels = opts.nMels ?? 128
    this.fft = new FFT(this.nFft)
    this.win = new Float64Array(this.nFft)
    // periodic Hann (scipy get_window('hann', n, fftbins=True), librosa's default)
    for (let i = 0; i < this.nFft; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / this.nFft)
    this.mel = melFilters(sr, this.nFft, this.nMels)
    this.re = new Float64Array(this.nFft)
    this.im = new Float64Array(this.nFft)
    const binOf = (hz: number) => Math.round((hz * this.nFft) / sr)
    const nyq = this.nFft / 2
    const band = (lo: number, hi: number): [number, number] => {
      const a = Math.min(nyq, Math.max(0, binOf(lo)))
      const b = Math.min(nyq, Math.max(a, binOf(Math.min(hi, sr / 2))))
      return [a, b]
    }
    this.bandBins = {
      bass: band(BANDS.bass[0], BANDS.bass[1]),
      mid: band(BANDS.mid[0], BANDS.mid[1]),
      treble: band(BANDS.treble[0], BANDS.treble[1])
    }
    this.melDb = new Grow(this.nMels)
    this.scalars = new Grow(4)
    this.lp1 = new Lowpass(sr, ATTACK_LOWPASS)
    this.lp2 = new Lowpass(sr, ATTACK_LOWPASS)
    this.envLow = new Grow(1, 4096)
    this.envFull = new Grow(1, 4096)
    this.buf = new Float32Array(this.nFft * 4)
    // the leading n_fft/2 zeros of the centred STFT
    this.bufLen = this.nFft / 2
  }

  private append(src: ArrayLike<number>, from = 0, to = src.length): void {
    const n = to - from
    if (this.bufLen + n > this.buf.length) {
      // drop what no future frame can reach, then grow if still short
      const drop = Math.min(this.next - this.base, this.bufLen)
      if (drop > 0) {
        this.buf.copyWithin(0, drop, this.bufLen)
        this.bufLen -= drop
        this.base += drop
      }
      if (this.bufLen + n > this.buf.length) {
        const nb = new Float32Array(Math.max(this.bufLen + n, this.buf.length * 2))
        nb.set(this.buf.subarray(0, this.bufLen))
        this.buf = nb
      }
    }
    for (let i = 0; i < n; i++) this.buf[this.bufLen + i] = src[from + i]
    this.bufLen += n
  }

  push(mono: ArrayLike<number>): void {
    if (this.finished) throw new Error('analysis: push after finish')
    this.append(mono)
    for (let i = 0; i < mono.length; i++) {
      const b = Math.floor(((this.samples + i) * ENV_RATE) / this.sr)
      if (b !== this.bucket) this.closeBucket(b)
      const x = mono[i]
      const l = this.lp2.step(this.lp1.step(x))
      this.accLow += l * l
      this.accFull += x * x
      this.accN++
    }
    this.samples += mono.length
    this.drain(false)
  }

  private closeBucket(next: number): void {
    const n = Math.max(1, this.accN)
    this.envLow.push([this.accLow / n])
    this.envFull.push([this.accFull / n])
    this.accLow = this.accFull = 0
    this.accN = 0
    this.bucket = next
  }

  private drain(final: boolean): void {
    const total = 1 + Math.floor(this.samples / this.hop)
    while (true) {
      if (final && this.frameCount >= total) break
      const at = this.next - this.base
      if (at + this.nFft > this.bufLen) break
      this.frame(at)
      this.frameCount++
      this.next += this.hop
    }
  }

  private frame(at: number): void {
    const { nFft, re, im, win, buf } = this
    let sq = 0
    for (let i = 0; i < nFft; i++) {
      const s = buf[at + i]
      sq += s * s
      re[i] = s * win[i]
      im[i] = 0
    }
    this.fft.run(re, im)
    const bins = nFft / 2 + 1
    const pow = new Float64Array(bins)
    const mag = new Float64Array(bins)
    for (let b = 0; b < bins; b++) {
      const p = re[b] * re[b] + im[b] * im[b]
      pow[b] = p
      mag[b] = Math.sqrt(p)
    }
    const db = new Float64Array(this.nMels)
    for (let m = 0; m < this.nMels; m++) {
      const { from, w } = this.mel[m]
      let s = 0
      for (let k = 0; k < w.length; k++) s += w[k] * pow[from + k]
      db[m] = 10 * Math.log10(Math.max(1e-10, s))
    }
    this.melDb.push(db)
    const bandMean = ([a, b]: [number, number]) => {
      if (b < a) return 0
      let s = 0
      for (let k = a; k <= b; k++) s += mag[k]
      return s / (b - a + 1)
    }
    this.scalars.push([
      Math.sqrt(sq / nFft),
      bandMean(this.bandBins.bass),
      bandMean(this.bandBins.mid),
      bandMean(this.bandBins.treble)
    ])
  }

  finish(): AudioFrames {
    if (!this.finished) {
      this.finished = true
      // the trailing n_fft/2 zeros
      this.append(new Float32Array(this.nFft / 2))
      this.drain(true)
      if (this.accN) this.closeBucket(this.bucket + 1)
    }
    const F = this.melDb.length
    const M = this.nMels
    const S = this.melDb.view()
    // power_to_db's top_db: everything is floored 80 dB below the loudest bin
    let mx = -Infinity
    for (let i = 0; i < S.length; i++) if (S[i] > mx) mx = S[i]
    const floor = mx - 80
    const onset = new Float32Array(F)
    const shift = 1 + Math.floor(this.nFft / (2 * this.hop)) // lag + n_fft/(2·hop)
    for (let t = shift; t < F; t++) {
      const j = t - shift // difference between frames j+1 and j
      if (j + 1 >= F) break
      let s = 0
      const a = j * M
      const b = (j + 1) * M
      for (let m = 0; m < M; m++) {
        const d = Math.max(S[b + m], floor) - Math.max(S[a + m], floor)
        if (d > 0) s += d
      }
      onset[t] = s / M
    }
    const sc = this.scalars.view()
    const pick = (k: number) => {
      const out = new Float32Array(F)
      for (let i = 0; i < F; i++) out[i] = sc[i * 4 + k]
      return out
    }
    return {
      sr: this.sr,
      hop: this.hop,
      frameRate: this.sr / this.hop,
      frames: F,
      onset,
      rms: pick(0),
      bass: pick(1),
      mid: pick(2),
      treble: pick(3),
      envLow: Float32Array.from(this.envLow.view()),
      envFull: Float32Array.from(this.envFull.view())
    }
  }
}

// ------------------------------------------------------------------- tempo

/** Python's round(): half to even. librosa's period arithmetic goes through it. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x)
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r
}

export interface TempoOpts {
  /** prior centre, BPM (librosa start_bpm) — default 120 */
  startBpm?: number
  /** prior width in octaves — default 1 */
  stdBpm?: number
  /** autocorrelation window, seconds — default 8 */
  acSize?: number
  /** BPM ceiling — default 320 */
  maxTempo?: number
  /** tempogram frames averaged at most — default 2000 (evenly spaced) */
  maxFrames?: number
}

/** librosa.feature.tempo(onset_envelope, aggregate=mean) — the global tempo, BPM. */
export function estimateTempo(onset: ArrayLike<number>, frameRate: number, opts: TempoOpts = {}): number {
  const F = onset.length
  const startBpm = opts.startBpm ?? 120
  const stdBpm = opts.stdBpm ?? 1
  const maxTempo = opts.maxTempo ?? 320
  const win = Math.max(2, Math.floor((opts.acSize ?? 8) * frameRate))
  if (F === 0) return 0
  // librosa's beat_track bails out on an all-zero envelope before asking for a
  // tempo; without this the prior alone would "find" ~120 BPM in silence
  let any = false
  for (let i = 0; i < F; i++) if (onset[i] > 0) { any = true; break }
  if (!any) return 0
  const half = Math.floor(win / 2)
  // np.pad(mode='linear_ramp', end_values=0) on both sides
  const padded = new Float64Array(F + 2 * half)
  for (let i = 0; i < F; i++) padded[half + i] = onset[i]
  for (let i = 0; i < half; i++) {
    padded[i] = (onset[0] * i) / half
    padded[half + F + i] = F ? (onset[F - 1] * (half - 1 - i)) / half : 0
  }
  // NOTE np.pad linear_ramp goes from end_value at the outer edge to the edge
  // value next to the data: left pad[i] = edge·i/half, right mirrored. The right
  // side above reaches edge·(half−1)/half at the first pad sample, as numpy does.
  const hann = new Float64Array(win)
  for (let i = 0; i < win; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / win)
  // departure from librosa: average over at most maxFrames evenly spaced frames
  const maxFrames = Math.max(1, opts.maxFrames ?? 2000)
  const stride = Math.max(1, Math.ceil(F / maxFrames))
  const acc = new Float64Array(win)
  let used = 0
  const x = new Float64Array(win)
  for (let t = 0; t < F; t += stride) {
    for (let i = 0; i < win; i++) x[i] = padded[t + i] * hann[i]
    let a0 = 0
    for (let i = 0; i < win; i++) a0 += x[i] * x[i]
    used++
    if (!(a0 > 1e-30)) continue // an all-zero column stays zero (util.normalize threshold)
    acc[0] += 1
    for (let l = 1; l < win; l++) {
      let s = 0
      for (let i = 0; i + l < win; i++) s += x[i] * x[i + l]
      acc[l] += s / a0
    }
  }
  if (!used) return 0
  let best = -1
  let bestScore = -Infinity
  for (let l = 1; l < win; l++) {
    const bpm = (60 * frameRate) / l
    if (bpm >= maxTempo) continue // prior[:max_idx] = 0 → log 0 = −inf
    const prior = Math.exp(-0.5 * Math.pow((Math.log2(bpm) - Math.log2(startBpm)) / stdBpm, 2))
    const tg = acc[l] / used
    const score = Math.log1p(1e6 * tg) + Math.log(prior)
    if (score > bestScore) {
      bestScore = score
      best = l
    }
  }
  return best > 0 ? (60 * frameRate) / best : 0
}

// ------------------------------------------------------------------- beats

/** scipy.signal.convolve(a, k, 'same') for 1-D arrays */
function convolveSame(a: ArrayLike<number>, k: ArrayLike<number>): Float64Array {
  const n = a.length
  const m = k.length
  const out = new Float64Array(n)
  const off = Math.floor((m - 1) / 2)
  for (let i = 0; i < n; i++) {
    const full = i + off // index into the full convolution
    let s = 0
    const jLo = Math.max(0, full - (n - 1))
    const jHi = Math.min(m - 1, full)
    for (let j = jLo; j <= jHi; j++) s += k[j] * a[full - j]
    out[i] = s
  }
  return out
}

export interface BeatTrackOpts {
  /** librosa tightness — default 100 */
  tightness?: number
  /** drop weak leading/trailing beats — default true */
  trim?: boolean
}

/** librosa's __beat_tracker: beat positions as analysis-frame indices. */
export function trackBeats(
  onset: ArrayLike<number>,
  frameRate: number,
  bpm: number,
  opts: BeatTrackOpts = {}
): number[] {
  const n = onset.length
  if (!n || !(bpm > 0)) return []
  let any = false
  for (let i = 0; i < n; i++) if (onset[i]) { any = true; break }
  if (!any) return []
  const tightness = opts.tightness ?? 100
  const period = roundHalfEven((60 * frameRate) / bpm)
  if (period < 1) return []

  // __normalize_onsets: divide by the sample standard deviation
  let mean = 0
  for (let i = 0; i < n; i++) mean += onset[i]
  mean /= n
  let v = 0
  for (let i = 0; i < n; i++) v += (onset[i] - mean) ** 2
  const sd = n > 1 ? Math.sqrt(v / (n - 1)) : 0
  const norm = new Float64Array(n)
  for (let i = 0; i < n; i++) norm[i] = sd > 0 ? onset[i] / sd : onset[i]

  // __beat_local_score: Gaussian of the period
  const gw = new Float64Array(2 * period + 1)
  for (let i = -period; i <= period; i++) gw[i + period] = Math.exp(-0.5 * ((i * 32) / period) ** 2)
  const local = convolveSame(norm, gw)

  // __beat_track_dp
  const lo = -2 * period
  const hi = -roundHalfEven(period / 2)
  const wlen = hi - lo + 1
  const txwt = new Float64Array(wlen)
  for (let k = 0; k < wlen; k++) txwt[k] = -tightness * Math.log(-(lo + k) / period) ** 2
  let lmax = -Infinity
  for (let i = 0; i < n; i++) if (local[i] > lmax) lmax = local[i]
  const backlink = new Int32Array(n)
  const cum = new Float64Array(n)
  let first = true
  for (let i = 0; i < n; i++) {
    const w0 = lo + i // window[0] for this i
    const zpad = Math.max(0, Math.min(-w0, wlen))
    let bestK = 0
    let best = -Infinity
    for (let k = 0; k < wlen; k++) {
      const c = k < zpad ? txwt[k] : txwt[k] + cum[w0 + k]
      if (c > best) {
        best = c
        bestK = k
      }
    }
    cum[i] = local[i] + best
    if (first && local[i] < 0.01 * lmax) backlink[i] = -1
    else {
      backlink[i] = w0 + bestK
      first = false
    }
  }

  // __last_beat: the last local maximum above half the median of the maxima
  const isMax = (i: number) => {
    const prev = i > 0 ? cum[i - 1] : cum[0]
    const next = i < n - 1 ? cum[i + 1] : cum[n - 1]
    return cum[i] > prev && cum[i] >= next
  }
  const maxVals: number[] = []
  for (let i = 0; i < n; i++) if (isMax(i)) maxVals.push(cum[i])
  if (!maxVals.length) return []
  maxVals.sort((a, b) => a - b)
  const mid = maxVals.length >> 1
  const med = maxVals.length % 2 ? maxVals[mid] : (maxVals[mid - 1] + maxVals[mid]) / 2
  let tail = -1
  for (let i = n - 1; i >= 0; i--) {
    if (isMax(i) && cum[i] * 2 > med) {
      tail = i
      break
    }
  }
  if (tail < 0) return []
  const beats: number[] = [tail]
  while (backlink[beats[beats.length - 1]] >= 0) beats.push(backlink[beats[beats.length - 1]])
  beats.reverse()

  // __trim_beats, librosa 0.11: threshold = half the RMS of the beat scores
  // smoothed by np.hanning(5) (SYMMETRIC [0, .5, 1, .5, 0]) — full convolution
  // sliced from len(w)//2, which leaves nb + 2 values — then every frame from
  // either end whose local score does not exceed it loses its beat. (0.10 cut
  // on the smoothed beat scores themselves instead and kept up to ~2 s more of
  // a quiet intro; /brag's reference cues were made with the 0.11 rule.)
  if (opts.trim === false) return beats
  const w = [0, 0.5, 1, 0.5, 0]
  const vals = beats.map((b) => local[b])
  const full = new Float64Array(vals.length + w.length - 1)
  for (let i = 0; i < vals.length; i++) for (let j = 0; j < w.length; j++) full[i + j] += vals[i] * w[j]
  const smooth = full.subarray(w.length >> 1, Math.min(full.length, n + (w.length >> 1)))
  let ms = 0
  for (const s of smooth) ms += s * s
  const threshold = 0.5 * Math.sqrt(ms / Math.max(1, smooth.length))
  let lead = 0
  while (lead < n && local[lead] <= threshold) lead++
  let tailEnd = n - 1
  while (tailEnd >= 0 && local[tailEnd] <= threshold) tailEnd--
  return beats.filter((b) => b >= lead && b <= tailEnd)
}

// ------------------------------------------------------- beat strengths

/** clip ≥ 0, divide by the 98th percentile (or the max when that is ~0), clamp 0..1 */
export function normalize98(values: ArrayLike<number>): Float32Array {
  const n = values.length
  const out = new Float32Array(n)
  if (!n) return out
  const v = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const x = values[i]
    v[i] = Number.isFinite(x) && x > 0 ? x : 0
  }
  const sorted = Float64Array.from(v).sort()
  // numpy percentile, linear interpolation
  const pos = 0.98 * (n - 1)
  const i0 = Math.floor(pos)
  const i1 = Math.min(n - 1, i0 + 1)
  let high = sorted[i0] + (sorted[i1] - sorted[i0]) * (pos - i0)
  if (high <= 1e-12) high = sorted[n - 1]
  if (high <= 1e-12) return out
  for (let i = 0; i < n; i++) out[i] = Math.min(1, v[i] / high)
  return out
}

export interface Beat {
  /** seconds from the start of the analysed audio */
  time: number
  /** brag's cue intensity, 0..1 */
  intensity: number
  /** an accent: among the strongest beats of this piece */
  strong: boolean
}

export interface BeatAnalysis {
  /** BPM, 0 when there is nothing rhythmic */
  tempo: number
  beats: Beat[]
  /**
   * For grids of every 2nd / 4th beat: the phase (0..n−1) whose beats are the
   * strongest on average — a heuristic downbeat, not a detected bar line.
   */
  accentPhase: { 2: number; 4: number }
  /** set when the grid was moved onto the attacks (see alignBeatsToAttacks) */
  attack?: AttackAlignment
}

export interface AttackAlignment {
  /** which envelope the attacks were read from */
  band: 'low' | 'full'
  /** median attack − beat before the move, ms (negative = the grid was late) */
  shiftMs: number
  /** beats put exactly on their own attack; the rest moved by the median */
  snapped: number
  total: number
}

/**
 * Where the audible attack of a beat is, in milliseconds relative to it, or
 * null when there is no clear one. Looked for in [−180, +60] ms: the STEEPEST
 * rise of the envelope there (level `span` ms after minus `span` ms before —
 * the envelope's own width, a smoothed envelope rises no faster — at least
 * 8 dB) whose next 40 ms reach within 20 dB of the piece's loud level — the
 * steepest, not the first: a riser or a sidechain pump before a drop has small
 * rises of its own. The attack is where the envelope first gets within 6 dB of
 * the level it rises to (the same −6 dB rule as a sound's HIT). The envelope is
 * an RMS stepped by 1 ms (see envDb for its width).
 */
function attackOffset(db: Float64Array, beatMs: number, loud: number, span: number, width: number, minRise = 8): number | null {
  const lo = beatMs - 180
  const hi = beatMs + 60
  if (lo < span + 1 || hi + 50 >= db.length) return null
  let best = -1
  let bestRise = minRise
  for (let t = lo; t <= hi; t++) {
    const rise = db[t + span] - db[t - span]
    if (rise < bestRise) continue
    let after = -Infinity
    for (let i = t; i <= t + 40; i++) if (db[i] > after) after = db[i]
    if (after < loud - 20) continue
    best = t
    bestRise = rise
  }
  if (best < 0) return null
  let after = -Infinity
  for (let i = best; i <= best + 40; i++) if (db[i] > after) after = db[i]
  let a = best - span
  while (db[a] < after - 6) a++
  // a centred RMS window of width W crosses −6 dB of a step W/4 BEFORE it
  // (a quarter of the window already holds the new level): measured −5 ms at
  // 20 ms on a click track, 0 after this
  return a + Math.round(width / 4) - beatMs
}

function envelopeBand(band: 'low' | 'full', env: Float32Array, delay: number, width: number) {
  const db = envDb(env, delay, width)
  const sorted = Float64Array.from(db).sort()
  const loud = sorted[Math.floor(0.95 * (sorted.length - 1))]
  return {
    band,
    offsetOf: (t: number, minRise?: number) =>
      attackOffset(db, Math.round(t * ENV_RATE), loud, Math.max(8, width), width, minRise)
  }
}

const quantile = (sorted: number[], q: number) => {
  const pos = q * (sorted.length - 1)
  const i = Math.floor(pos)
  const j = Math.min(sorted.length - 1, i + 1)
  return sorted[i] + (sorted[j] - sorted[i]) * (pos - i)
}

/**
 * RMS over a centred window, in dB, one value per millisecond, from a per-ms
 * mean-square envelope. The window must span a whole period of the lowest note
 * it is meant to follow: a 5 ms RMS of a 50 Hz 808 drops by 15–20 dB at every
 * zero crossing, and those fake dips were taken for attacks.
 */
function envDb(env: Float32Array, delayMs: number, widthMs: number): Float64Array {
  const n = env.length
  const out = new Float64Array(n)
  const h = widthMs >> 1
  for (let i = 0; i < n; i++) {
    // moved back by the filter's own delay
    const c = i + delayMs
    let s = 0
    let k = 0
    for (let j = c - h; j <= c + h; j++) if (j >= 0 && j < n) { s += env[j]; k++ }
    out[i] = 10 * Math.log10(Math.max(1e-12, k ? s / k : 0))
  }
  return out
}

/**
 * librosa places a beat on the peak of its onset STRENGTH, and on most music
 * that is the attack (the bundled tracks: median −10..0 ms). On a brickwalled
 * mix whose kick or 808 starts out of a sidechain gap it is not: the spectral
 * flux peaks when the note is already sounding, and on such a track every beat
 * sat 78–120 ms (median 110) AFTER the 808 — six frames at 60 fps, so text
 * that jumps "on the beat" visibly jumped after the bass, and clips cut and
 * sounds placed on the grid landed late too.
 *
 * The grid is moved only when the lag is SYSTEMATIC: most beats (≥ 60 %) have a
 * clear attack, those attacks agree (interquartile range ≤ 50 ms) and the
 * median is further than 25 ms from the beat. Then every beat with a clear
 * attack goes exactly onto it (the lag is not constant: on that track it was
 * 0 on the drop, where librosa sees a huge broadband onset, and 50–120 ms
 * elsewhere); a beat with none there goes onto a BIG attack (≥ 12 dB) in the
 * other band if it has one, and the rest move by the median. The low
 * band (< 150 Hz: kick, 808) is tried first, then the whole band.
 */
export function alignBeatsToAttacks(a: AudioFrames, times: number[]): { times: number[]; attack?: AttackAlignment } {
  if (times.length < 8 || !a.envLow?.length) return { times }
  const bands: Array<{ band: 'low' | 'full'; offsetOf: (t: number, minRise?: number) => number | null }> = [
    // a 4th-order Butterworth delays its DC by 2·√2/(2π·fc) — ~3 ms at 150 Hz;
    // 20 ms covers a period down to 50 Hz
    envelopeBand('low', a.envLow, Math.round((1000 * 2 * Math.SQRT2) / (2 * Math.PI * ATTACK_LOWPASS)), 20),
    envelopeBand('full', a.envFull, 0, 5)
  ]
  for (const { band, offsetOf } of bands) {
    const offs = times.map((t) => offsetOf(t))
    const clear = offs.filter((o): o is number => o !== null).sort((x, y) => x - y)
    if (clear.length < Math.max(8, 0.6 * times.length)) continue
    const med = quantile(clear, 0.5)
    const iqr = quantile(clear, 0.75) - quantile(clear, 0.25)
    if (iqr > 50) continue
    if (Math.abs(med) <= 25) return { times } // this band agrees with the grid
    // a beat with no attack in this band may still carry an unmistakable one in
    // the other (the bass-less intro of that track: two hits of 15 and 22 dB,
    // which the median alone put 90–100 ms early) — only a big one counts
    const other = bands.find((x) => x.band !== band)!
    let snapped = 0
    const out = times.map((t, i) => {
      const o = offs[i] ?? other.offsetOf(t, 12)
      if (o !== null) { snapped++; return Math.max(0, t + o / ENV_RATE) }
      return Math.max(0, t + med / ENV_RATE)
    })
    return { times: out, attack: { band, shiftMs: med, snapped, total: times.length } }
  }
  return { times }
}

/** Beats below this never count as accents, however quiet the piece (brag's floor). */
export const STRONG_FLOOR = 0.45
/** …and above it only the top quarter of the piece's own beats do. */
export const STRONG_QUANTILE = 0.75

export function analyzeBeats(
  a: AudioFrames,
  opts: TempoOpts & BeatTrackOpts & { alignAttacks?: boolean } = {}
): BeatAnalysis {
  const tempo = estimateTempo(a.onset, a.frameRate, opts)
  const frames = tempo > 0 ? trackBeats(a.onset, a.frameRate, tempo, opts) : []
  const onsetN = normalize98(a.onset)
  // local contrast: the frame's onset above the median of ±0.5 s around it
  const r = Math.max(1, Math.round((0.5 * a.sr) / a.hop))
  const contrast = new Float64Array(a.frames)
  const windowVals: number[] = []
  for (let f = 0; f < a.frames; f++) {
    windowVals.length = 0
    for (let k = Math.max(0, f - r); k <= Math.min(a.frames - 1, f + r); k++) windowVals.push(onsetN[k])
    windowVals.sort((x, y) => x - y)
    const m = windowVals.length >> 1
    const med = windowVals.length % 2 ? windowVals[m] : (windowVals[m - 1] + windowVals[m]) / 2
    contrast[f] = Math.max(0, onsetN[f] - med)
  }
  const contrastN = normalize98(contrast)
  const rmsN = normalize98(a.rms)
  const bassN = normalize98(a.bass)
  const at = (arr: Float32Array, f: number) => arr[Math.min(arr.length - 1, Math.max(0, f))] ?? 0
  const intens = frames.map((f) =>
    Math.min(1, Math.max(0,
      0.45 * at(onsetN, f) + 0.25 * at(contrastN, f) + 0.2 * at(rmsN, f) + 0.1 * at(bassN, f))))
  const sorted = [...intens].sort((x, y) => x - y)
  const q = sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(STRONG_QUANTILE * (sorted.length - 1)))] : 1
  const strongAt = Math.max(STRONG_FLOOR, q)
  const grid = frames.map((f) => (f * a.hop) / a.sr)
  const aligned = opts.alignAttacks === false ? { times: grid } : alignBeatsToAttacks(a, grid)
  const beats: Beat[] = frames.map((_, i) => ({
    time: aligned.times[i],
    intensity: intens[i],
    strong: intens[i] >= strongAt
  }))
  const phaseOf = (every: number) => {
    let best = 0
    let bestMean = -1
    for (let p = 0; p < every; p++) {
      let s = 0
      let c = 0
      for (let i = p; i < intens.length; i += every) { s += intens[i]; c++ }
      const mean = c ? s / c : 0
      if (mean > bestMean) { bestMean = mean; best = p }
    }
    return best
  }
  return { tempo, beats, accentPhase: { 2: phaseOf(2), 4: phaseOf(4) }, ...(aligned.attack ? { attack: aligned.attack } : {}) }
}

/** Which beats a grid keeps: every one, every 2nd/4th (from the accent phase), or accents only. */
export type BeatGrid = 'all' | 'half' | 'bar' | 'strong'

export function pickBeats(b: BeatAnalysis, grid: BeatGrid): Beat[] {
  if (grid === 'all') return b.beats
  if (grid === 'strong') return b.beats.filter((x) => x.strong)
  const every = grid === 'half' ? 2 : 4
  const phase = b.accentPhase[every]
  return b.beats.filter((_, i) => i % every === phase)
}

// --------------------------------------------------- reactive features

export interface FeatureCurves {
  rms: number[]
  bass: number[]
  mid: number[]
  treble: number[]
}

/**
 * The four energies, 0..1 (98th-percentile normalised over the analysed range
 * so a quiet piece still moves), at the analysis frame rate.
 */
export function featureCurves(a: AudioFrames): FeatureCurves {
  const r4 = (x: Float32Array) => Array.from(x, (v) => Math.round(v * 1e4) / 1e4)
  return {
    rms: r4(normalize98(a.rms)),
    bass: r4(normalize98(a.bass)),
    mid: r4(normalize98(a.mid)),
    treble: r4(normalize98(a.treble))
  }
}

/**
 * Sample a curve (given at `rate` values per second, t = 0 at index 0) at the
 * times `times` (seconds) — linear interpolation, 0 outside the curve — then
 * run a one-pole attack/release follower over the result so the motion
 * breathes instead of flickering. `attack`/`release` are seconds to reach ~90 %.
 */
export function sampleCurve(
  curve: ArrayLike<number>,
  rate: number,
  times: number[],
  attack = 0.03,
  release = 0.25
): number[] {
  const raw = times.map((t) => {
    const p = t * rate
    if (!(p >= 0) || p > curve.length - 1) return 0
    const i0 = Math.floor(p)
    const i1 = Math.min(curve.length - 1, i0 + 1)
    return curve[i0] + (curve[i1] - curve[i0]) * (p - i0)
  })
  const out: number[] = []
  let last = 0
  for (let i = 0; i < raw.length; i++) {
    const dt = i > 0 ? Math.max(1e-6, Math.abs(times[i] - times[i - 1])) : 0
    if (i === 0) last = raw[0]
    else {
      const tc = raw[i] > last ? attack : release
      const k = tc > 0 ? 1 - Math.pow(0.1, dt / tc) : 1
      last += (raw[i] - last) * k
    }
    out.push(Math.round(last * 1e4) / 1e4)
  }
  return out
}
