// Keyframed clip gain reaches the export (shared/gainKeys.ts). The preview
// always evaluated `evalAnim(clip.gain, rel)` per frame, while every mixdown
// took the value at t = 0 — a ramp the agent or a script drew was heard in
// the preview and exported flat. Both mix paths are checked: the single
// ffmpeg graph and the premix above PREMIX_THRESHOLD segments.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-gain-keys.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { collectRangeAudio } = await load(`export { collectRangeAudio } from './src/engine/subtitles'`)
const { evalAnim } = await load(`export { evalAnim } from './src/engine/anim'`)
const { mixdownWav, FFMPEG, PREMIX_THRESHOLD } = await load(`export { mixdownWav, FFMPEG, PREMIX_THRESHOLD } from './electron/ffmpeg'`)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const pcmOf = (file) => {
  const buf = readFileSync(file)
  const at = buf.indexOf('data') + 8
  return new Int16Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length - ((buf.length - at) % 2)))
}
const rms = (pcm, a, b) => { // stereo interleaved, seconds
  let s = 0, n = 0
  for (let i = Math.round(a * 48000) * 2; i < Math.round(b * 48000) * 2 && i < pcm.length; i++, n++) s += (pcm[i] / 32768) ** 2
  return Math.sqrt(s / Math.max(1, n))
}
const db = (x) => 20 * Math.log10(Math.max(x, 1e-9))

const dir = mkdtempSync(join(tmpdir(), 'kadr-gainkeys-'))
try {
  const src = join(dir, 'noise.wav')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=30:c=white:a=0.25:seed=7', '-ac', '2', '-ar', '48000', src])
  const asset = { id: 'a', kind: 'audio', path: src, duration: 30, hasAudio: true }
  const START = 1, DUR = 3, LEN = 5
  const mk = (gain, extra = {}) => ({ id: 'c', kind: 'media', assetId: 'a', start: START, duration: DUR, inPoint: 0, speed: 1, gain, ...extra })
  const proj = (clips) => ({ assets: [asset], tracks: clips.map((c, i) => ({ id: 't' + i, kind: 'audio', gain: 1, clips: [c] })) })
  // 64 inaudible companions push the mix over PREMIX_THRESHOLD
  const filler = Array.from({ length: PREMIX_THRESHOLD }, (_, i) =>
    ({ id: 'f' + i, kind: 'media', assetId: 'a', start: 4.5, duration: 0.1, inPoint: i, speed: 1, gain: { value: 0 } }))

  const ramps = {
    'linear 0→1': { value: 1, keyframes: [{ time: 0.5, value: 0, easing: 'linear' }, { time: 2.5, value: 1, easing: 'linear' }] },
    'easeInOut 1→0.1': { value: 1, keyframes: [{ time: 0.5, value: 1, easing: 'easeInOut' }, { time: 2.5, value: 0.1, easing: 'linear' }] },
    'hold 0.2 then 1': { value: 1, keyframes: [{ time: 0.5, value: 0.2, easing: 'hold' }, { time: 1.5, value: 1, easing: 'linear' }] },
    'smooth 3 keys': { value: 1, smooth: true, keyframes: [{ time: 0.5, value: 0.1, easing: 'linear' }, { time: 1.5, value: 1, easing: 'linear' }, { time: 2.5, value: 0.3, easing: 'linear' }] }
  }
  const cases = []
  for (const [name, gain] of Object.entries(ramps)) {
    cases.push([name, mk(gain), false])
    cases.push([name + ', premix', mk(gain), true])
  }
  cases.push(['linear 0→1 at 2×', mk(ramps['linear 0→1'], { speed: 2 }), false])

  // the level of the clip at gain 1 and the same speed (atempo alone takes
  // ~1.1 dB off white noise at 2×, keyframes or not)
  const refs = {}
  const refOf = async (speed) => {
    if (refs[speed] === undefined) {
      const out = join(dir, 'ref.wav')
      await mixdownWav(collectRangeAudio(proj([mk({ value: 1 }, { speed })]), 0, LEN), LEN, out)
      refs[speed] = rms(pcmOf(out), START, START + DUR)
    }
    return refs[speed]
  }
  for (const [name, clip, premix] of cases) {
    const ref = await refOf(clip.speed)
    const segs = collectRangeAudio(proj(premix ? [clip, ...filler] : [clip]), 0, LEN)
    if (premix && segs.length <= PREMIX_THRESHOLD) { check(`${name}: premix path taken`, false, `${segs.length} segments`); continue }
    const out = join(dir, 'mix.wav')
    await mixdownWav(segs, LEN, out)
    const pcm = pcmOf(out)
    // expected: the steady noise times the rms of the gain curve per window
    const worst = [0.5, 1, 1.5, 2, 2.5].reduce((w, a) => {
      let g2 = 0
      const N = 2000
      for (let k = 0; k < N; k++) g2 += evalAnim(clip.gain, a + (k + 0.5) * 0.5 / N) ** 2
      const want = db(ref * Math.sqrt(g2 / N)), got = db(rms(pcm, START + a, START + a + 0.5))
      return Math.abs(got - want) > Math.abs(w) ? got - want : w
    }, 0)
    check(`${name}: exported loudness follows the keyframes within 0.5 dB`, Math.abs(worst) <= 0.5, `worst window ${worst.toFixed(2)} dB`)
  }

  // a flat gain — and keyframes that never change it — mix exactly as before
  const a = join(dir, 'flat.wav'), b = join(dir, 'flatkeys.wav')
  await mixdownWav(collectRangeAudio(proj([mk({ value: 0.7 })]), 0, LEN), LEN, a)
  await mixdownWav(collectRangeAudio(proj([mk({ value: 0.3, keyframes: [{ time: 0, value: 0.7, easing: 'easeIn' }, { time: 2, value: 0.7, easing: 'linear' }] })]), 0, LEN), LEN, b)
  check('a flat gain produces bit-identical output to a plain gain', readFileSync(a).equals(readFileSync(b)))
  const flatSegs = collectRangeAudio(proj([mk({ value: 0.7 })]), 0, LEN)
  check('a flat gain carries no gain keys', flatSegs.every((s) => !s.gainKeys))
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `${fails} FAILED` : 'all passed')
process.exit(fails ? 1 : 0)
