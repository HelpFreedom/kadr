// Check of what the export's audio mix does with a clip's gain KEYFRAMES and
// with speeds outside 0.25–8× — the REAL code: gainCurve/evalAnim from
// src/engine/anim.ts and the ExportMuxer chain from electron/ffmpeg.ts
// (mixdownWav and premixSegments, the two mix paths), bundled with esbuild and
// run on the installed ffmpeg.
//
// The export used to take a clip's gain at its first instant and ignore every
// keyframe, while the preview follows them (HelpFreedom/kadr#41); and atempo
// was clamped to 0.25–8×, so a 20× clip's sound ran 2.5 times past the clip and
// a 0.1× clip's stopped early.
// Asserted: every 10 ms the mixed level is the curve evalAnim gives (linear,
// eased, hold, smooth; a segment starting mid-clip; both mix paths), a plain
// gain mixes as before, and a sped-up or slowed clip sounds exactly as long
// as it lasts on the timeline.
// Run: node scripts/check-gain-keys.mjs
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
if (spawnSync('ffmpeg', ['-hide_banner', '-version']).status !== 0) {
  console.log('SKIP  no ffmpeg in PATH')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-gainkeys-'))
try {
  const bundle = async (entry, name) => {
    const out = join(dir, name)
    await build({ entryPoints: [join(root, entry)], bundle: true, platform: 'node', format: 'esm', outfile: out, logLevel: 'error', alias: { '@shared': join(root, 'shared') } })
    return import(pathToFileURL(out).href)
  }
  const { mixdownWav, premixSegments, gainExpr } = await bundle('electron/ffmpeg.ts', 'ffmpeg.mjs')
  const { gainCurve, evalAnim } = await bundle('src/engine/anim.ts', 'anim.mjs')

  const ff = (args) => { const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(r.stderr) }
  // a steady 1 kHz tone at −6 dBFS: every 10 ms window holds 10 whole periods,
  // so its RMS × √2 is the amplitude, i.e. 0.5 × gain
  const tone = join(dir, 'tone.wav')
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:d=8:sample_rate=48000', '-af', 'volume=4', '-ac', '2', tone])
  const AMP = (() => { const b = readFileSync(tone); const d = b.indexOf('data') + 8; let p = 0; for (let i = d; i + 1 < b.length; i += 4) p = Math.max(p, Math.abs(b.readInt16LE(i) / 32768)); return p })()
  const read = (path) => {
    const b = readFileSync(path)
    const fmt = b.readUInt16LE(b.indexOf('fmt ') + 8 + 0), bits = b.readUInt16LE(b.indexOf('fmt ') + 8 + 14)
    const d = b.indexOf('data') + 8
    const n = Math.floor((b.length - d) / (bits / 8) / 2)
    const L = (i) => (fmt === 3 ? b.readFloatLE(d + i * 8) : b.readInt16LE(d + i * 4) / 32768)
    return { n, L }
  }
  // amplitude in a 10 ms window centred at t (RMS × √2)
  const ampAt = (w, t) => {
    const a = Math.max(0, Math.round((t - 0.005) * 48000)), z = Math.min(w.n, a + 480)
    if (z - a < 480) return 0
    let s = 0
    for (let i = a; i < z; i++) s += w.L(i) ** 2
    return Math.sqrt(s / 480) * Math.SQRT2
  }

  check('a gain without keyframes gives no curve (it mixes exactly as before)', gainCurve({ value: 0.7 }, 1, 0, 4) === null && gainCurve(0.7, 1, 0, 4) === null)
  check('the expression puts negative numbers in parentheses', !/[-+]-|\*-/.test(gainExpr([{ t: 0, v: 1 }, { t: 1, v: 0 }])), gainExpr([{ t: 0, v: 1 }, { t: 1, v: 0 }]))

  const gain = {
    value: 0.2,
    keyframes: [
      { time: 0.0, value: 0.2, easing: 'linear' },
      { time: 1.0, value: 1.0, easing: 'easeInOut' },
      { time: 2.0, value: 0.5, easing: 'hold' },
      { time: 3.0, value: 0.1, easing: 'linear' },
      { time: 3.5, value: 0.9, easing: 'linear' }
    ]
  }
  const smooth = { value: 0.3, smooth: true, keyframes: [{ time: 0, value: 0.3, easing: 'linear' }, { time: 1.5, value: 1, easing: 'linear' }, { time: 3, value: 0.2, easing: 'linear' }] }
  const TRACK = 0.8
  const seg = (start, from, dur, anim, extra = {}) => ({
    path: tone, inPoint: from, duration: dur, start, gain: evalAnim(anim, 0) * TRACK, speed: 1, fadeIn: 0, fadeOut: 0,
    gainCurve: gainCurve(anim, TRACK, from, dur), ...extra
  })
  // three segments: the whole curve at 1 s; the same clip's tail from 1.5 s
  // (a segment that starts mid-clip, as a loop or a range export makes); a smooth curve
  const segs = [seg(1.0, 0, 4, gain), seg(6.0, 1.5, 2.5, gain), seg(9.0, 0, 3, smooth)]
  const expect = (t) => {
    if (t >= 1.0 && t < 5.0) return evalAnim(gain, t - 1.0) * TRACK
    if (t >= 6.0 && t < 8.5) return evalAnim(gain, 1.5 + t - 6.0) * TRACK
    if (t >= 9.0 && t < 12.0) return evalAnim(smooth, t - 9.0) * TRACK
    return 0
  }
  const steps = [1.0 + 2.0, 1.0 + 3.0, 6.0 + 0.5, 6.0 + 1.5] // hold jumps and linear corners: the 10 ms around them is mixed
  const measure = (path) => {
    const w = read(path)
    let worst = 0, where = 0
    for (let t = 0.02; t < 12.4; t += 0.01) {
      if (steps.some((s) => Math.abs(t - s) < 0.011) || [1, 5, 6, 8.5, 9, 12].some((e) => Math.abs(t - e) < 0.011)) continue
      const err = Math.abs(ampAt(w, t) / AMP - expect(t))
      if (err > worst) { worst = err; where = t }
    }
    return { worst, where }
  }
  const one = join(dir, 'graph.wav')
  await mixdownWav(segs, 12.5, one)
  const g = measure(one)
  check('one graph: the level follows the keyframed curve every 10 ms (within 0.01 of gain)', g.worst < 0.01, `worst ${g.worst.toFixed(4)} at ${g.where.toFixed(2)} s`)
  const pm = join(dir, 'premix.wav')
  await premixSegments(segs, 12.5, pm)
  const p = measure(pm)
  check('premix (> 64 clips): the same curve', p.worst < 0.01, `worst ${p.worst.toFixed(4)} at ${p.where.toFixed(2)} s`)
  const w = read(one)
  // the hold at clip-local 2–3 s is timeline 3–4 s: 0.5 × track all the way, then the jump to 0.1
  const before = ampAt(w, 3.95) / AMP, after = ampAt(w, 4.015) / AMP
  check('the hold holds 0.5 to its end and jumps at the next keyframe', Math.abs(before - 0.5 * TRACK) < 0.005 && Math.abs(after - expect(4.015)) < 0.01,
    `${before.toFixed(3)} (want ${(0.5 * TRACK).toFixed(3)}) → ${after.toFixed(3)} (want ${expect(4.015).toFixed(3)})`)

  // a plain gain: the same level as always
  const plainOut = join(dir, 'plain.wav')
  await mixdownWav([{ path: tone, inPoint: 0, duration: 1, start: 0, gain: 0.7, speed: 1, fadeIn: 0, fadeOut: 0 }], 1.2, plainOut)
  const pw = read(plainOut)
  check('a plain gain mixes at its level', Math.abs(ampAt(pw, 0.5) / AMP - 0.7) < 0.002, (ampAt(pw, 0.5) / AMP).toFixed(4))

  // speeds outside the old clamp: the sound lasts exactly the clip's timeline length
  const soundSpan = (path) => {
    const v = read(path)
    let first = -1, last = -1
    for (let i = 0; i < v.n; i += 48) if (Math.abs(v.L(i)) > 0.01 || ampAt(v, i / 48000 + 0.005) > 0.02) { if (first < 0) first = i; last = i }
    return [first / 48000, last / 48000]
  }
  for (const [speed, src] of [[20, 4], [0.1, 0.1], [12, 2.4], [2, 1]]) {
    const out = join(dir, `speed${speed}.wav`)
    await mixdownWav([{ path: tone, inPoint: 0, duration: src, start: 0.5, gain: 1, speed, fadeIn: 0, fadeOut: 0 }], 0.5 + src / speed + 1, out)
    const [a, b] = soundSpan(out)
    const len = src / speed
    check(`${speed}×: ${src} s of source sound for ${len.toFixed(2)} s, as the clip lasts`, a >= 0.45 && a <= 0.56 && Math.abs(b - (0.5 + len)) < 0.03,
      `sounds ${a.toFixed(3)}–${b.toFixed(3)} s, clip 0.500–${(0.5 + len).toFixed(3)} s`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
