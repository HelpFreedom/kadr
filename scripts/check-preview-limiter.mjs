// The preview's master limiter (shared/previewLimiter.ts — the DSP the
// AudioWorklet runs) against the export's: ffmpeg's alimiter with the same
// parameters as shared/audioMaster.ts, on the same input.
//
//   node scripts/check-preview-limiter.mjs      (needs ffmpeg in PATH)
//
//   1. the worklet's gain envelope matches ffmpeg alimiter within 1 dB — a +6 dB
//      tone and loud bursty stereo noise, fed in 128-frame render quanta the
//      way an AudioWorklet sees them, at 48 and 44.1 kHz;
//   2. its output never exceeds the limit (−1 dBFS);
//   3. below the limit it only delays: the input comes back exactly, 239 samples
//      later at 48 kHz — the same look-ahead the export compensates for.
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  entryPoints: [join(root, 'shared', 'previewLimiter.ts')], bundle: true, write: false, format: 'esm', platform: 'neutral'
}).outputFiles[0].text
const L = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { MASTER_LIMIT, MASTER_ATTACK_MS, MASTER_RELEASE_MS } = L

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const dir = mkdtempSync(join(tmpdir(), 'kadr-plimiter-'))

// deterministic noise
let seed = 12345
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 * 2 - 1 }

/** planar stereo signals */
function tone(sr) {
  const n = Math.round(sr * 1.9), l = new Float64Array(n), r = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const t = i / sr
    // 0.2 s silence, 1 s at +6 dBFS (amplitude 2), 0.7 s quiet tail for the release
    const a = t < 0.2 ? 0 : t < 1.2 ? 2 : 0.3
    l[i] = r[i] = a * Math.sin(2 * Math.PI * 1000 * t)
  }
  return [l, r]
}
function bursts(sr) {
  const n = Math.round(sr * 3), l = new Float64Array(n), r = new Float64Array(n)
  let lvl = 0.3
  for (let i = 0; i < n; i++) {
    if (i % Math.round(sr * 0.13) === 0) lvl = 0.2 + (rnd() + 1) * 1.4   // 0.2 … 3.0
    l[i] = lvl * rnd()
    r[i] = lvl * 0.6 * rnd() + (i % 997 === 0 ? 2.5 : 0)               // lone clicks on one side
  }
  return [l, r]
}
function quiet(sr) {
  const n = Math.round(sr * 1), l = new Float64Array(n), r = new Float64Array(n)
  for (let i = 0; i < n; i++) { l[i] = 0.8 * rnd(); r[i] = 0.5 * rnd() }
  return [l, r]
}

/** the worklet's path: 128-frame quanta, float32 in and out like WebAudio */
function viaWorklet([l, r], sr) {
  const lim = L.createLimiter(sr, 2)
  const n = l.length, ol = new Float64Array(n), or = new Float64Array(n)
  for (let s = 0; s < n; s += 128) {
    const m = Math.min(128, n - s)
    const inp = [Float32Array.from(l.subarray(s, s + m)), Float32Array.from(r.subarray(s, s + m))]
    const out = [new Float32Array(m), new Float32Array(m)]
    lim.process(inp, out, m)
    ol.set(out[0], s); or.set(out[1], s)
  }
  return [ol, or]
}

/** ffmpeg alimiter on the same float32 samples, straight (no pad/trim) */
function viaFfmpeg([l, r], sr, tag) {
  const n = l.length, inter = new Float32Array(n * 2)
  for (let i = 0; i < n; i++) { inter[2 * i] = l[i]; inter[2 * i + 1] = r[i] }
  const inF = join(dir, `${tag}.in.raw`), outF = join(dir, `${tag}.out.raw`)
  writeFileSync(inF, Buffer.from(inter.buffer))
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(sr), '-ac', '2', '-i', inF,
    '-af', `alimiter=limit=${MASTER_LIMIT}:attack=${MASTER_ATTACK_MS}:release=${MASTER_RELEASE_MS}:level=disabled`,
    '-f', 'f32le', outF])
  const b = readFileSync(outF), o = new Float32Array(b.buffer, b.byteOffset, b.length / 4)
  const ol = new Float64Array(o.length / 2), or = new Float64Array(o.length / 2)
  for (let i = 0; i < ol.length; i++) { ol[i] = o[2 * i]; or[i] = o[2 * i + 1] }
  return [ol, or]
}

const db = (x) => 20 * Math.log10(Math.max(x, 1e-12))

for (const sr of [48000, 44100]) {
  for (const [name, gen] of [['+6 dB tone', tone], ['bursty stereo noise', bursts]]) {
    const sig = gen(sr)
    const a = viaWorklet(sig, sr), b = viaFfmpeg(sig, sr, `${name.replace(/\W/g, '')}-${sr}`)
    const n = Math.min(a[0].length, b[0].length)
    // gain envelope: peak per 5 ms window, both channels
    const win = Math.round(sr * 0.005)
    let worst = 0, maxDiff = 0, peak = 0
    for (let s = 0; s + win <= n; s += win) {
      let pa = 0, pb = 0
      for (let c = 0; c < 2; c++) for (let i = s; i < s + win; i++) {
        pa = Math.max(pa, Math.abs(a[c][i])); pb = Math.max(pb, Math.abs(b[c][i]))
        maxDiff = Math.max(maxDiff, Math.abs(a[c][i] - b[c][i]))
      }
      if (pa < 1e-3 && pb < 1e-3) continue
      worst = Math.max(worst, Math.abs(db(pa) - db(pb)))
    }
    for (let c = 0; c < 2; c++) for (let i = 0; i < a[c].length; i++) peak = Math.max(peak, Math.abs(a[c][i]))
    // cost: the preview lies about clipping — it limits differently from the export
    check(`${sr} Hz, ${name}: the worklet's gain envelope matches ffmpeg alimiter within 1 dB`,
      worst <= 1 && a[0].length === b[0].length,
      `worst 5 ms window ${worst.toFixed(4)} dB, max sample diff ${maxDiff.toExponential(2)}, lengths ${a[0].length}/${b[0].length}`)
    // cost: a hot mix clips in the preview and not in the export
    check(`${sr} Hz, ${name}: output never exceeds −1 dBFS`, peak <= MASTER_LIMIT + 1e-6,
      `peak ${db(peak).toFixed(3)} dBFS`)
  }
}

{
  const sr = 48000, sig = quiet(sr), a = viaWorklet(sig, sr)
  const d = L.limiterLatency(sr, 2)
  let exact = d === 239
  for (let c = 0; c < 2; c++) for (let i = 0; i < d; i++) if (a[c][i] !== 0) exact = false
  for (let c = 0; c < 2; c++) for (let i = d; i < a[c].length; i++) if (a[c][i] !== Math.fround(sig[c][i - d])) exact = false
  // cost: a quiet mix is coloured or shifted by a stage meant only for overs
  check('below the limit the worklet only delays, by the export\'s 239-sample look-ahead', exact, `latency ${d}`)
}

rmSync(dir, { recursive: true, force: true })
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
