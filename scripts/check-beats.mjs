// Node-side check of shared/audioAnalysis.ts (beat grid + reactive curves).
// No test runner in the repo: transpile with esbuild and import via a data URL.
//
//   node scripts/check-beats.mjs
//       synthetic material only (no files, no ffmpeg)
//   node scripts/check-beats.mjs <music dir>
//       also compares against librosa: for every <stem>.mp3 in <dir> that has a
//       <dir>/cues/<stem>.music-cues.json (the format /brag ships — librosa
//       0.11 beat_track at sr 44100, hop 512) the file is decoded with ffmpeg at the
//       same rate and the tempo and beat times are compared.
import { readFileSync, readdirSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { execFileSync } from 'child_process'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'audioAnalysis.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const A = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
// shared/rhythm.ts imports './audioAnalysis': hand it the module loaded above
const A_URL = 'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
const rsrc = readFileSync(join(root, 'shared', 'rhythm.ts'), 'utf8').replace("from './audioAnalysis'", `from '${A_URL}'`)
const R = await import('data:text/javascript;base64,' + Buffer.from(transformSync(rsrc, { loader: 'ts', format: 'esm' }).code).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const analyse = (pcm, sr, chunk = 4099) => {
  const an = new A.AudioAnalyzer(sr)
  // odd chunk sizes: frames must not depend on how the stream is cut
  for (let i = 0; i < pcm.length; i += chunk) an.push(pcm.subarray(i, Math.min(pcm.length, i + chunk)))
  return an.finish()
}

// ---- 1. a click track at a known tempo -------------------------------------
{
  const sr = 22050
  const bpm = 128
  const dur = 30
  const pcm = new Float32Array(sr * dur)
  const period = 60 / bpm
  const truth = []
  // kick-like burst: decaying 60 Hz + a noise click, accent on every 4th
  let seed = 1
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  for (let k = 0; ; k++) {
    const t0 = 0.5 + k * period
    if (t0 > dur - 0.5) break
    truth.push(t0)
    const amp = k % 4 === 0 ? 0.9 : 0.5
    const s0 = Math.round(t0 * sr)
    for (let i = 0; i < sr * 0.15 && s0 + i < pcm.length; i++) {
      const env = Math.exp(-i / (sr * 0.03))
      pcm[s0 + i] += amp * env * (0.7 * Math.sin((2 * Math.PI * 60 * i) / sr) + 0.3 * rnd() * Math.exp(-i / (sr * 0.004)))
    }
  }
  const a = analyse(pcm, sr)
  check('frame count = 1 + floor(samples / hop)', a.frames === 1 + Math.floor(pcm.length / 512), String(a.frames))
  const a2 = analyse(pcm, sr, 1 << 20)
  let same = a2.frames === a.frames
  for (let i = 0; same && i < a.frames; i++) same = a.onset[i] === a2.onset[i]
  check('chunking does not change the onsets', same)
  const b = A.analyzeBeats(a)
  // the tempo is quantised to whole analysis frames per beat (librosa too): 128 BPM
  // is 20.19 frames, so the answer is the 20-frame bin, 129.2
  const binBpm = (60 * a.frameRate) / Math.round((60 * a.frameRate) / bpm)
  check('tempo = the lag bin nearest 128 BPM', Math.abs(b.tempo - binBpm) < 1e-6, `${b.tempo.toFixed(2)} (bin ${binBpm.toFixed(2)})`)
  // Signed error to the nearest click. librosa's onset envelope peaks up to ~1.5
  // analysis frames AFTER a click that rises out of digital silence (measured:
  // +11..+36 ms, mean ≈ +23 ms, the beat sits exactly on that peak) — the bound
  // below is that, not a vague tolerance. Parity with librosa is checked on
  // real music by the optional reference pass.
  const errOf = (beats) => beats.map((x) => {
    let best = Infinity
    for (const t of truth) if (Math.abs(x.time - t) < Math.abs(best)) best = x.time - t
    return best
  })
  // librosa's own grid (what the reference pass compares against)…
  const errs = errOf(A.analyzeBeats(a, { alignAttacks: false }).beats)
  check('librosa grid: every beat 0..40 ms after its click', errs.every((e) => e >= -0.002 && e < 0.04),
    `${(Math.min(...errs) * 1000).toFixed(1)}..${(Math.max(...errs) * 1000).toFixed(1)} ms`)
  const spread = Math.max(...errs) - Math.min(...errs)
  check('no drift: the error stays inside a 2-frame band over 30 s', spread < 2 * 512 / sr, `${(spread * 1000).toFixed(1)} ms`)
  check('found at least 90 % of the clicks', b.beats.length >= 0.9 * truth.length, `${b.beats.length}/${truth.length}`)
  // …and the grid Kadr uses: that lag is systematic, so it is moved onto the clicks
  const onClick = errOf(b.beats)
  check('aligned grid: every beat within 3 ms of its click', !!b.attack && onClick.every((e) => Math.abs(e) <= 0.003),
    `${(Math.min(...onClick) * 1000).toFixed(1)}..${(Math.max(...onClick) * 1000).toFixed(1)} ms, shift ${b.attack?.shiftMs} ms (${b.attack?.band})`)
  // the accented clicks (every 4th) must come out strong and pick the right phase
  // 'strong' is a heuristic (top quarter by brag's intensity), and here exactly a
  // quarter of the clicks are accented — so demand a clear majority, not all
  const accentIdx = b.beats.map((x) => Math.round((x.time - 0.5) / period)).filter((k, i) => b.beats[i].strong)
  const onAccent = accentIdx.filter((k) => k % 4 === 0).length
  check('strong beats are mostly the accented clicks', accentIdx.length > 0 && onAccent / accentIdx.length >= 0.75,
    `${onAccent}/${accentIdx.length}`)
  const bars = A.pickBeats(b, 'bar')
  check('bar grid lands on the accents', bars.length > 0 &&
    bars.every((x) => Math.round((x.time - 0.5) / period) % 4 === 0), `${bars.length} beats`)
  check('half grid keeps every 2nd', Math.abs(A.pickBeats(b, 'half').length - b.beats.length / 2) <= 1)
}

// ---- 2. silence and a steady tone: nothing to beat on ----------------------
{
  const sr = 22050
  const silent = analyse(new Float32Array(sr * 5), sr)
  const bs = A.analyzeBeats(silent)
  check('silence: no beats, tempo 0', bs.beats.length === 0 && bs.tempo === 0, `${bs.beats.length} beats, ${bs.tempo}`)
  const f = A.featureCurves(silent)
  check('silence: all curves zero', [f.rms, f.bass, f.mid, f.treble].every((c) => c.every((v) => v === 0)))
}

// ---- 3. band curves: a bass tone then a treble tone ------------------------
{
  const sr = 22050
  const pcm = new Float32Array(sr * 4)
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sr
    pcm[i] = t < 2 ? 0.5 * Math.sin(2 * Math.PI * 80 * t) : 0.5 * Math.sin(2 * Math.PI * 5000 * t)
  }
  const a = analyse(pcm, sr)
  const f = A.featureCurves(a)
  const mean = (c, t0, t1) => {
    const i0 = Math.round(t0 * a.frameRate)
    const i1 = Math.round(t1 * a.frameRate)
    let s = 0
    for (let i = i0; i < i1; i++) s += c[i]
    return s / (i1 - i0)
  }
  check('bass curve lit by the 80 Hz tone, dark after', mean(f.bass, 0.3, 1.7) > 0.7 && mean(f.bass, 2.3, 3.7) < 0.05,
    `${mean(f.bass, 0.3, 1.7).toFixed(2)} / ${mean(f.bass, 2.3, 3.7).toFixed(2)}`)
  check('treble curve dark during the bass, lit by 5 kHz', mean(f.treble, 0.3, 1.7) < 0.05 && mean(f.treble, 2.3, 3.7) > 0.7,
    `${mean(f.treble, 0.3, 1.7).toFixed(3)} / ${mean(f.treble, 2.3, 3.7).toFixed(2)}`)
  // sampling + follower: 60 fps, attack reaches the level fast, release decays
  const times = Array.from({ length: 240 }, (_, k) => k / 60)
  const s = A.sampleCurve(f.bass, a.frameRate, times)
  check('sampled curve has one value per time', s.length === times.length)
  check('follower: bass still high 0.1 s after it stops, low 0.6 s after',
    s[Math.round(2.1 * 60)] > 0.2 && s[Math.round(2.6 * 60)] < 0.1,
    `${s[126].toFixed(2)} / ${s[156].toFixed(3)}`)
  check('sampling outside the curve is 0', A.sampleCurve(f.bass, a.frameRate, [-1, 1e6]).every((v) => v === 0))
}

// ---- 4. roundHalfEven matches Python's round() ------------------------------
check('roundHalfEven', [[10.5, 10], [11.5, 12], [-2.5, -2], [2.4, 2], [2.6, 3]].every(([x, r]) => A.roundHalfEven(x) === r))

// ---- 4b. moving a late grid onto the attacks --------------------------------
// An 808-like track: a 50 Hz note on every beat, each out of a 30 ms gap (the
// sidechain pump that made librosa's grid lag a brickwalled phonk track by ~110 ms).
{
  const sr = 44100
  const period = 0.5
  const dur = 24
  const pcm = new Float32Array(sr * dur)
  const truth = []
  for (let k = 0; ; k++) {
    const t0 = 1 + k * period
    if (t0 > dur - 1) break
    truth.push(t0)
  }
  for (let i = 0; i < pcm.length; i++) {
    const t = i / sr
    let k = truth.length - 1
    while (k >= 0 && truth[k] > t) k--
    if (k < 0) continue
    const into = t - truth[k]
    if (into > period - 0.03) continue // the gap before the next note
    const env = Math.min(1, into / 0.004) * (0.6 + 0.4 * Math.exp(-into / 0.2))
    pcm[i] = 0.8 * env * Math.sin(2 * Math.PI * 50 * into)
  }
  const a = analyse(pcm, sr)
  check('attack envelopes: one value per millisecond', Math.abs(a.envLow.length - dur * 1000) <= 1, `${a.envLow.length}`)
  const worst = (xs) => Math.max(...xs.map((x, i) => Math.abs(x - truth[i]))) * 1000
  const late = A.alignBeatsToAttacks(a, truth.map((t) => t + 0.11))
  check('a grid 110 ms late is moved onto the attacks', !!late.attack && worst(late.times) <= 8,
    `shift ${late.attack?.shiftMs} ms, ${late.attack?.snapped}/${late.attack?.total} snapped, worst ${worst(late.times).toFixed(1)} ms`)
  const exact = A.alignBeatsToAttacks(a, truth)
  check('a grid already on the attacks is left alone', !exact.attack && worst(exact.times) === 0)
  // a lag that is not systematic (±60 ms at random) is not "corrected"
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const noisy = truth.map((t) => t + 0.06 * rnd())
  const n = A.alignBeatsToAttacks(a, noisy)
  check('a grid that disagrees at random is left alone', !n.attack && n.times.every((t, i) => t === noisy[i]))
  const silent = analyse(new Float32Array(sr * 10), sr)
  const s0 = [1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]
  check('silence moves nothing', !A.alignBeatsToAttacks(silent, s0).attack)
  const off = A.analyzeBeats(a, { alignAttacks: false })
  check('analyzeBeats can be asked for the raw librosa grid', !off.attack)
}

// ---- 4c. bars, the "one", sections and pauses (shared/rhythm.ts) -------------
// A synthetic song with KNOWN bars: a kick on 1 (strong) and 3 (weaker), a
// snare on 2 and 4 (the backbeat), a bass note on 1 — the way most 4/4 pop and
// rock sits — starting with a one-beat pickup (so the first beat is NOT a
// "one"), 8 quiet bars then 24 loud ones (a section boundary by dynamics), and
// the whole band stopping for half a bar before bar 17 (a pause).
{
  const sr = 44100
  const bpm = 120
  const beat = 60 / bpm
  const bars = 32
  const lead = 1.0 // silence before the pickup
  const dur = lead + (bars * 4 + 1) * beat + 1
  const pcm = new Float32Array(Math.round(sr * dur))
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const add = (t0, len, amp, fn) => {
    const s0 = Math.round(t0 * sr)
    for (let i = 0; i < len * sr && s0 + i < pcm.length; i++) pcm[s0 + i] += amp * fn(i / sr)
  }
  const kick = (t, a) => add(t, 0.25, a, (x) => Math.exp(-x / 0.06) * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-x / 0.02)) * x))
  const snare = (t, a) => add(t, 0.15, a, (x) => Math.exp(-x / 0.03) * (0.8 * rnd() + 0.2 * Math.sin(2 * Math.PI * 200 * x)))
  const hat = (t, a) => add(t, 0.04, a, (x) => Math.exp(-x / 0.008) * rnd())
  const bassNote = (t, a) => add(t, beat * 1.8, a, (x) => Math.min(1, x / 0.01) * Math.exp(-x / 0.8) * Math.sin(2 * Math.PI * 82.4 * x))
  const pauseAt = lead + beat + 16 * 4 * beat - 2 * beat // the last half of bar 16
  const truth = []
  // the pickup: one snare beat before bar 1
  snare(lead, 0.3)
  for (let b = 0; b < bars; b++) {
    const g = b < 8 ? 0.25 : 1 // 8 quiet bars, then loud (−12 dB step)
    for (let k = 0; k < 4; k++) {
      const t = lead + beat + (b * 4 + k) * beat
      if (t >= pauseAt && t < pauseAt + 2 * beat) continue
      if (k === 0) { truth.push(t); kick(t, 0.9 * g); bassNote(t, 0.35 * g) }
      if (k === 2) kick(t, 0.55 * g)
      if (k === 1 || k === 3) snare(t, 0.5 * g)
      hat(t, 0.12 * g); hat(t + beat / 2, 0.08 * g)
    }
  }
  const a = analyse(pcm, sr, 65536)
  const bt = A.analyzeBeats(a)
  const rh = R.analyzeRhythm(a, bt)
  const downs = bt.beats.map((b, i) => ({ t: b.time, r: rh.beats[i] })).filter((x) => x.r.beatInBar === 1 && x.r.bar > 0)
  const firstDown = downs[0]?.t ?? -1
  check('rhythm: 4/4', rh.meter === 4, `meter ${rh.meter}, confidence ${rh.meterConfidence}`)
  check('rhythm: the "one" is the kick on beat 1, not the pickup and not beat 3',
    Math.abs(firstDown - truth[0]) < 0.03, `first downbeat ${firstDown.toFixed(3)} s, truth ${truth[0].toFixed(3)} s, phase confidence ${rh.phaseConfidence}`)
  const matched = truth.filter((t) => downs.some((d) => Math.abs(d.t - t) < 0.03)).length
  check('rhythm: every bar found on its "one"', matched >= truth.length - 1, `${matched}/${truth.length}`)
  const bar9 = truth[8]
  check('rhythm: the dynamics step starts a section (bar 9)',
    rh.sections.some((x) => Math.abs(x.start - bar9) < beat * 1.5), rh.sections.map((x) => `${x.start.toFixed(2)} ${x.label}`).join(', '))
  const p = rh.pauses.find((x) => x.start < pauseAt + 0.3 && x.end > pauseAt + 0.3)
  check('rhythm: the band stopping for half a bar is a pause', !!p && Math.abs(p.start - pauseAt) < 0.35,
    JSON.stringify(rh.pauses) + ` truth ${pauseAt.toFixed(2)}–${(pauseAt + 2 * beat).toFixed(2)}`)
  check('rhythm: no other pauses in a steady song', rh.pauses.length === 1, `${rh.pauses.length}`)
  check('rhythm: kicks on the grid → kick offset ≈ 0', !!rh.kickOffsetMs && Math.abs(rh.kickOffsetMs.median) <= 15,
    JSON.stringify(rh.kickOffsetMs))
  // pickBeats follows the bars once they exist
  const withBars = { beats: bt.beats.map((b, i) => ({ ...b, ...rh.beats[i] })), accentPhase: bt.accentPhase }
  const barGrid = A.pickBeats(withBars, 'bar')
  check('grid "bar" = the first beat of each bar', barGrid.length === downs.length && barGrid.every((b) => b.beatInBar === 1),
    `${barGrid.length} vs ${downs.length}`)
}

// The same idea in 3/4: kick on 1 only, snare on 2 and 3.
{
  const sr = 44100
  const beat = 0.5
  const bars = 24
  const pcm = new Float32Array(Math.round(sr * (bars * 3 * beat + 2)))
  let seed = 11
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1
  const add = (t0, len, amp, fn) => {
    const s0 = Math.round(t0 * sr)
    for (let i = 0; i < len * sr && s0 + i < pcm.length; i++) pcm[s0 + i] += amp * fn(i / sr)
  }
  const truth = []
  for (let b = 0; b < bars; b++) {
    for (let k = 0; k < 3; k++) {
      const t = 0.5 + (b * 3 + k) * beat
      if (k === 0) {
        truth.push(t)
        add(t, 0.25, 0.9, (x) => Math.exp(-x / 0.06) * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-x / 0.02)) * x))
        add(t, beat * 2.5, 0.3, (x) => Math.min(1, x / 0.01) * Math.exp(-x / 0.9) * Math.sin(2 * Math.PI * 73.4 * x))
      } else {
        add(t, 0.12, 0.45, (x) => Math.exp(-x / 0.03) * rnd())
      }
    }
  }
  const a = analyse(pcm, sr, 65536)
  const bt = A.analyzeBeats(a)
  const rh = R.analyzeRhythm(a, bt)
  const downs = bt.beats.filter((_, i) => rh.beats[i].beatInBar === 1 && rh.beats[i].bar > 0).map((b) => b.time)
  const matched = truth.filter((t) => downs.some((d) => Math.abs(d - t) < 0.03)).length
  check('rhythm: 3/4 is told from 4/4', rh.meter === 3, `meter ${rh.meter}, confidence ${rh.meterConfidence}, tempo ${bt.tempo.toFixed(1)}`)
  check('rhythm: 3/4 bars on their "one"', matched >= truth.length - 2, `${matched}/${truth.length}`)
}

// ---- 5. against librosa (optional) ------------------------------------------
const dir = process.argv[2]
if (dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.mp3'))
  let compared = 0
  for (const f of files) {
    const stem = f.replace(/\.mp3$/, '')
    const ref = join(dir, 'cues', `${stem}.music-cues.json`)
    if (!existsSync(ref)) continue
    const cues = JSON.parse(readFileSync(ref, 'utf8'))
    const sr = cues.analysis?.sampleRate || 44100
    const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', join(dir, f), '-ac', '1', '-ar', String(sr), '-f', 'f32le', '-'],
      { maxBuffer: 1 << 30 })
    const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2)
    const a = analyse(Float32Array.from(pcm), sr)
    const b = A.analyzeBeats(a)
    const refBeats = cues.beats.map((x) => x.time)
    // how many of librosa's beats have one of ours within 25 ms, and vice versa
    const near = (xs, ys) => xs.filter((x) => ys.some((y) => Math.abs(x - y) <= 0.025)).length / Math.max(1, xs.length)
    const ours = b.beats.map((x) => x.time)
    const recall = near(refBeats, ours)
    const precision = near(ours, refBeats)
    const tempoOk = Math.abs(b.tempo - cues.tempo) / cues.tempo < 0.02
    check(`librosa ${stem}: tempo ${b.tempo.toFixed(2)} vs ${cues.tempo}`, tempoOk)
    check(`librosa ${stem}: beats matched ±25 ms`, recall > 0.95 && precision > 0.95,
      `recall ${(recall * 100).toFixed(1)} %, precision ${(precision * 100).toFixed(1)} % (${ours.length} vs ${refBeats.length})`)
    // parity, not just proximity: measured on /brag's five tracks every matched
    // beat sat within 0.05 ms of librosa's (the reference rounds to 0.1 ms) —
    // except the FIRST beat of vol-10, one analysis frame (11.6 ms) away. That
    // file is 48 kHz: librosa resamples it with soxr, we with ffmpeg's swr, and
    // the two filters differ in the first milliseconds of a file. So the first
    // and last beat may be one frame out; every other one must be exact.
    const frame = 512 / sr
    const diffs = refBeats.map((r) => Math.min(...ours.map((o) => Math.abs(o - r))))
    const inner = diffs.slice(1, -1)
    const edges = [diffs[0], diffs[diffs.length - 1]]
    check(`librosa ${stem}: inner beats within 1 ms, edge beats within 1 frame`,
      inner.every((d) => d < 0.001) && edges.every((d) => d <= frame + 1e-4),
      `inner max ${(Math.max(...inner) * 1000).toFixed(3)} ms, edges ${edges.map((d) => (d * 1000).toFixed(2)).join('/')} ms`)
    compared++
  }
  check('librosa references found', compared > 0, `${compared} tracks`)
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
