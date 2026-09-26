/**
 * Sound-effect features and labels, so a sound the user adds to the library is
 * described the same way /brag described its 228: brightness (warm / balanced /
 * bright), high-frequency risk (low / medium / high — how sharp and fatiguing it
 * gets when repeated) and envelope shape (transient / textured / continuous).
 *
 * /brag published the labels and the numbers, not the rules. The rules below
 * were LEARNT from its 228 labelled files: the features are computed here, a
 * shallow decision tree was fitted against /brag's labels, and its thresholds
 * are written out in `labelSfx`. How well they reproduce /brag is measured by
 * `scripts/check-sfx-labels.mjs` (cross-validated agreement is printed there
 * and recorded in CLAUDE.md). One feature is exact, not approximated: the share
 * of spectral MAGNITUDE between 4 and 16 kHz matches /brag's energyRatioHigh to
 * 0.0001 on all 228 files.
 *
 * Input: mono PCM (the mean of the channels — ffmpeg's -ac 1 matrix would scale
 * a stereo file by √2) trimmed to the container duration.
 * Pure TypeScript, no node/electron imports.
 */

const N_FFT = 2048
const HOP = 256

/**
 * Bump whenever a feature or a rule below changes: catalogues cached by an
 * older version are re-analysed (the user's hand-written uses/notes survive).
 */
export const SFX_ANALYSIS_VERSION = 2

export interface SfxFeatures {
  duration: number
  peak: number
  rms: number
  crest: number
  /** share of |X| in 4–16 kHz — equals /brag's energyRatioHigh */
  hiRatio: number
  /** median spectral centroid over the active frames, Hz */
  centroidP50: number
  /**
   * seconds of frames whose RMS (2048-sample centred window, hop 256) is within
   * 18 dB of the loudest, over the duration — /brag's activeRatio: this
   * definition reproduces its activeDuration to a median 0.44 ms. Can exceed 1
   * for a sound shorter than the window.
   */
  activeRatio: number
  /** geometric / arithmetic mean of the frame level over the active frames (1 = flat) */
  flatness: number
  /** share of the active span that stays above 30 % of the loudest frame */
  continuous: number
  /** high-band level integrated over time, relative to the loudest frame, seconds */
  brightBurden: number
  /** seconds of loud frames whose magnitude is mostly above 4 kHz */
  highActive: number
  /**
   * seconds from the start of the file to the ATTACK of its loudest moment —
   * the HIT. A whoosh peaks ~0.4–1 s in, a boom with a lead-in 1.5 s in:
   * placing such a sound "at t" means putting THIS moment at t, not the file's
   * first sample. Measured on a 5 ms RMS envelope: from the loudest point back
   * to where the level first rose within 6 dB of it — the moment the sound
   * lands, not the centre of an analysis window (that read 27 ms late).
   *
   * 0 when the sound has NO single hit: a typing loop, a hum, a sand pour —
   * there the loudest instant is an accident, and aligning it would shift a
   * 30-second loop 14 s early. "Single" = at most two separate bursts reach
   * within 6 dB of the peak (50 ms power average, bursts under 100 ms apart
   * merged) and none of them lasts over a second. Measured on the user's first
   * twelve: the booms, whooshes, impact, lock and bubbles pass; the keyboard (8
   * bursts), the hum (4, a 1.2 s plateau) and the sand (a 1.1 s plateau) do not.
   */
  hit: number
  /** bursts within 6 dB of the peak (see hit) */
  bursts: number
  /** the longest of them, seconds */
  plateau: number
}

export interface SfxLabels {
  brightness: 'warm' | 'balanced' | 'bright'
  hfRisk: 'low' | 'medium' | 'high'
  envelope: 'transient' | 'textured' | 'continuous'
}

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t
      t = im[i]; im[i] = im[j]; im[j] = t
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const ang = (-2 * Math.PI) / size
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let s = 0; s < n; s += size) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < size / 2; k++) {
        const a = s + k
        const b = a + size / 2
        const xr = re[b] * cr - im[b] * ci
        const xi = re[b] * ci + im[b] * cr
        re[b] = re[a] - xr
        im[b] = im[a] - xi
        re[a] += xr
        im[a] += xi
        const t = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = t
      }
    }
  }
}

export function sfxFeatures(mono: Float32Array | number[], sr: number): SfxFeatures {
  const n = mono.length
  const duration = n / sr
  let peak = 0
  let sq = 0
  for (let i = 0; i < n; i++) {
    const v = Math.abs(mono[i])
    if (v > peak) peak = v
    sq += mono[i] * mono[i]
  }
  const rms = n ? Math.sqrt(sq / n) : 0
  // centred STFT, zero padded, periodic Hann — the analysis /brag declares
  const pad = N_FFT / 2
  const frames = Math.max(1, 1 + Math.floor(n / HOP))
  const win = new Float64Array(N_FFT)
  for (let i = 0; i < N_FFT; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT)
  const bins = N_FFT / 2 + 1
  const hz = (b: number) => (b * sr) / N_FFT
  const hiLo = Math.ceil((4000 * N_FFT) / sr)
  const hiHi = Math.min(bins - 1, Math.floor((16000 * N_FFT) / sr))
  const level = new Float64Array(frames) // Σ|X| per frame
  const frms = new Float64Array(frames)  // time-domain RMS of the (unwindowed) frame
  const high = new Float64Array(frames)  // Σ|X| in 4–16 kHz per frame
  const cent = new Float64Array(frames)
  let totMag = 0
  let totHi = 0
  const re = new Float64Array(N_FFT)
  const im = new Float64Array(N_FFT)
  for (let f = 0; f < frames; f++) {
    const start = f * HOP - pad
    let fsq = 0
    for (let i = 0; i < N_FFT; i++) {
      const k = start + i
      const v = k >= 0 && k < n ? mono[k] : 0
      fsq += v * v
      re[i] = v * win[i]
      im[i] = 0
    }
    frms[f] = Math.sqrt(fsq / N_FFT)
    fft(re, im)
    let s = 0
    let h = 0
    let c = 0
    for (let b = 0; b < bins; b++) {
      const m = Math.hypot(re[b], im[b])
      s += m
      c += m * hz(b)
      if (b >= hiLo && b <= hiHi) h += m
    }
    level[f] = s
    high[f] = h
    cent[f] = s > 0 ? c / s : 0
    totMag += s
    totHi += h
  }
  let lmax = 0
  for (const l of level) if (l > lmax) lmax = l
  const dt = HOP / sr
  const activeIdx: number[] = []
  for (let f = 0; f < frames; f++) if (lmax > 0 && level[f] >= 0.1 * lmax) activeIdx.push(f)
  let rmax = 0
  for (const r of frms) if (r > rmax) rmax = r
  let loud = 0
  for (const r of frms) if (rmax > 0 && r >= rmax * Math.pow(10, -18 / 20)) loud++
  const activeDur = loud * dt
  const cents = activeIdx.map((f) => cent[f]).sort((a, b) => a - b)
  const centroidP50 = cents.length
    ? (cents.length % 2 ? cents[cents.length >> 1] : (cents[cents.length / 2 - 1] + cents[cents.length / 2]) / 2)
    : 0
  let logSum = 0
  let linSum = 0
  for (const f of activeIdx) {
    logSum += Math.log(level[f] / lmax)
    linSum += level[f] / lmax
  }
  const flatness = activeIdx.length ? Math.exp(logSum / activeIdx.length) / (linSum / activeIdx.length) : 0
  let continuous = 0
  if (activeIdx.length) {
    const a = activeIdx[0]
    const b = activeIdx[activeIdx.length - 1]
    let c = 0
    for (let f = a; f <= b; f++) if (level[f] >= 0.3 * lmax) c++
    continuous = c / (b - a + 1)
  }
  let brightBurden = 0
  let highActive = 0
  for (let f = 0; f < frames; f++) {
    if (lmax <= 0) break
    brightBurden += (high[f] / lmax) * dt
    if (level[f] >= 0.1 * lmax && high[f] >= 0.5 * level[f]) highActive += dt
  }
  const step = Math.max(1, Math.round(0.005 * sr))
  const fine: number[] = []
  for (let i = 0; i < n; i += step) {
    let s = 0
    const e = Math.min(n, i + step)
    for (let k = i; k < e; k++) s += mono[k] * mono[k]
    fine.push(Math.sqrt(s / (e - i)))
  }
  let pk = 0
  for (let i = 1; i < fine.length; i++) if (fine[i] > fine[pk]) pk = i
  let at = pk
  while (at > 0 && fine[at - 1] >= 0.5 * fine[pk]) at--
  // bursts near the peak: a 50 ms POWER average of the 5 ms envelope
  const K = 10
  const pow = fine.map((v) => v * v)
  const sm: number[] = []
  let acc = 0
  for (let i = 0; i < pow.length + K; i++) {
    if (i < pow.length) acc += pow[i]
    if (i - K >= 0) acc -= pow[i - K]
    const centre = i - (K >> 1)
    if (centre >= 0 && centre < pow.length) sm.push(Math.sqrt(Math.max(0, acc) / K))
  }
  let smax = 0
  for (const v of sm) if (v > smax) smax = v
  const near = sm.map((v) => smax > 0 && v >= smax * Math.pow(10, -6 / 20))
  const runs: [number, number][] = []
  for (let i = 0; i < near.length; i++) {
    if (!near[i]) continue
    let j = i
    while (j < near.length && near[j]) j++
    const last = runs[runs.length - 1]
    if (last && (i - last[1]) * step / sr < 0.1) last[1] = j
    else runs.push([i, j])
    i = j
  }
  const bursts = runs.length
  const plateau = runs.reduce((m, [a, b]) => Math.max(m, ((b - a) * step) / sr), 0)
  const single = bursts <= 2 && plateau <= 1.0
  const hit = single ? Math.min(duration, (at * step) / sr) : 0
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4
  return {
    duration: r4(duration),
    peak: r4(peak),
    rms: r4(rms),
    crest: rms > 0 ? r4(peak / rms) : 0,
    hiRatio: totMag > 0 ? r4(totHi / totMag) : 0,
    centroidP50: Math.round(centroidP50 * 10) / 10,
    activeRatio: duration > 0 ? r4(activeDur / duration) : 0,
    flatness: r4(flatness),
    continuous: r4(continuous),
    brightBurden: r4(brightBurden),
    highActive: r4(highActive),
    hit: Math.round(hit * 1000) / 1000,
    bursts,
    plateau: Math.round(plateau * 1000) / 1000
  }
}

/**
 * The labels, by rules fitted to /brag's 228 labelled files (depth-2 decision
 * trees on the features above; 5-fold cross-validated agreement with /brag in
 * brackets, full-set agreement is what scripts/check-sfx-labels.mjs prints):
 *
 *   brightness [96 %] — the share of magnitude above 4 kHz alone.
 *   hfRisk     [99 %] — a mostly-dull sound is low risk when it is compact
 *                       (crest ≤ 5.95) and medium otherwise; a bright one is
 *                       high risk once it lasts beyond 0.18 s, since it is the
 *                       LENGTH of brightness that fatigues, not a short click.
 *   envelope          — transient when under 45 % of its length is within 18 dB
 *                       of the peak: /brag's own threshold on /brag's own
 *                       feature, reproduced exactly. Beyond that /brag splits
 *                       textured/continuous by an envelope-flatness measure
 *                       that could not be reproduced (six candidate formulas,
 *                       none within 0.1); the share of the active span held
 *                       above 30 % of the peak stands in for it and agrees on
 *                       71 % of those 45 files. (A tree on duration separates
 *                       them perfectly, but only because /brag's "continuous"
 *                       sounds all happen to be clicks under 73 ms — it would
 *                       call a six-second hum "textured".)
 */
export function labelSfx(x: SfxFeatures): SfxLabels {
  const brightness: SfxLabels['brightness'] =
    x.hiRatio <= 0.1761 ? 'warm' : x.hiRatio <= 0.3425 ? 'balanced' : 'bright'
  const hfRisk: SfxLabels['hfRisk'] = x.hiRatio <= 0.4427
    ? (x.crest <= 5.9515 ? 'low' : 'medium')
    : (x.duration <= 0.1797 ? 'medium' : 'high')
  const envelope: SfxLabels['envelope'] = x.activeRatio <= 0.4509
    ? 'transient'
    : x.continuous > 0.6459 ? 'continuous' : 'textured'
  return { brightness, hfRisk, envelope }
}
