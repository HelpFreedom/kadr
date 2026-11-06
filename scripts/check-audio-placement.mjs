// Check of where the audio mix puts every clip — the REAL ExportMuxer graph
// (electron/ffmpeg.ts, through mixdownWav), bundled with esbuild and run on the
// installed ffmpeg, many times over.
//
// The graph used to place a clip with `adelay`, and on recent ffmpeg (seen on
// 8.1 in HelpFreedom/kadr#47, reproduced on 9.0.2) the scheduler now and then
// dropped that delay: a clip from 9 s played at 0:00 and its own place stayed
// silent — in some runs and not others, with the same command. Each clip is
// now preceded by exactly round(start × 48000) samples of silence, joined with
// `concat`, which emits in order by construction.
// Asserted, in every run: each clip starts within 1 ms of its place (the
// silence prefix is sample-exact; adelay rounded to 1 ms), nothing sounds
// where nothing was placed, and levels are those of the source.
// Run: node scripts/check-audio-placement.mjs [runs]   (default 20)
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath, pathToFileURL } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const RUNS = Number(process.argv[2]) || 20
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
if (spawnSync('ffmpeg', ['-hide_banner', '-version']).status !== 0) {
  console.log('SKIP  no ffmpeg in PATH')
  process.exit(0)
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-placement-'))
try {
  const bundle = join(dir, 'ffmpeg.mjs')
  await build({
    entryPoints: [join(root, 'electron', 'ffmpeg.ts')], bundle: true, platform: 'node', format: 'esm',
    outfile: bundle, logLevel: 'error', alias: { '@shared': join(root, 'shared') }
  })
  const { mixdownWav } = await import(pathToFileURL(bundle).href)

  const ff = (args) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { encoding: 'utf8' })
    if (r.status !== 0) throw new Error(r.stderr)
  }
  // a 0.2 s burst at −6 dBFS, and a 3 s file that is silent except for a burst at 1.0 s
  const burst = join(dir, 'burst.wav')
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:d=0.2:sample_rate=48000', '-af', 'volume=4', '-ac', '2', burst])
  const long = join(dir, 'long.wav')
  ff(['-f', 'lavfi', '-i', 'sine=f=1000:d=0.2:sample_rate=48000', '-af', 'volume=4,adelay=1000|1000,apad=whole_dur=3', '-ac', '2', long])

  // an A/V file — H.264 + AAC in MP4, the case HelpFreedom/kadr#17 and #41
  // describe (an input opened with -ss whose timestamps do not start at 0) —
  // with a burst at 2.0 s, opened at an in-point of 1.5 s
  const av = join(dir, 'av.mp4')
  ff(['-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=1000:d=0.2:sample_rate=48000',
    '-filter_complex', '[1:a]volume=4,adelay=2000|2000,apad=whole_dur=4,aformat=channel_layouts=stereo[a]', '-map', '0:v', '-map', '[a]',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-shortest', av])
  const seg = (start, extra = {}) => ({ path: burst, inPoint: 0, duration: 0.2, start, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0, ...extra })
  const segments = [
    seg(0),                                             // at 0: no prefix at all
    seg(0.5), seg(1.5), seg(2.5), seg(3.5), seg(5.8), seg(7.0),
    seg(9.0),
    seg(10.00073),                                      // sub-millisecond: adelay could only round this
    { path: long, inPoint: 0.9, duration: 0.4, start: 11.0, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0 }, // burst at 11.1
    seg(12.5, { duration: 0.2, speed: 2 }),             // atempo: 0.1 s on the timeline
    { path: av, inPoint: 1.5, duration: 1.0, start: 15.0, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0 }, // burst at 15.5
    { path: av, inPoint: 1.5, duration: 1.0, start: 17.0, gain: 1, speed: 2, fadeIn: 0, fadeOut: 0 }  // 2×: burst at 17.25
  ]
  const expected = [0, 0.5, 1.5, 2.5, 3.5, 5.8, 7.0, 9.0, 10.00073, 11.1, 12.5, 15.5, 17.25]
  // atempo is a windowed overlap-add: a clip that STARTS with sound fades in
  // over its first window (~43 ms here), and a sharp onset inside a clip shows
  // up to ~half a window EARLY (measured −12.8 ms at 2×, −16.4 ms at 4×, the
  // same from a WAV and from an MP4 — atempo's, not the placement's). The
  // time-stretched clips get that window either way; every 1× clip, the A/V
  // one at an in-point included, must land within 1 ms
  const RAMP = { 12.5: [0, 0.05], 17.25: [0.025, 0.05] }
  const DURATION = 18.5
  // the level every clip must keep: the burst file's own peak
  const src = readFileSync(burst)
  const srcData = src.indexOf('data') + 8
  let srcPeak = 0
  for (let i = srcData; i + 1 < src.length; i += 2) srcPeak = Math.max(srcPeak, Math.abs(src.readInt16LE(i) / 32768))

  const out = join(dir, 'mix.wav')
  let wrongRuns = 0
  let worstOffset = 0
  let peakRange = [Infinity, -Infinity]
  for (let run = 0; run < RUNS; run++) {
    await mixdownWav(segments, DURATION, out)
    const buf = readFileSync(out)
    const data = buf.indexOf('data') + 8
    const n = (buf.length - data) / 4 // s16 stereo
    const L = (i) => buf.readInt16LE(data + i * 4) / 32768
    const firstLoud = (from, to) => {
      for (let i = Math.max(0, Math.floor(from * 48000)); i < Math.min(n, to * 48000); i++) if (Math.abs(L(i)) > 0.01) return i / 48000
      return null
    }
    const peak = (from, to) => {
      let p = 0
      for (let i = Math.max(0, Math.floor(from * 48000)); i < Math.min(n, to * 48000); i++) p = Math.max(p, Math.abs(L(i)))
      return p
    }
    let wrong = []
    for (const t of expected) {
      const at = firstLoud(t - 0.05, t + 0.25)
      // the sine starts at sample 0 with value 0: the first loud sample is a few samples in
      const [early, late] = RAMP[t] ?? [0, 0.001]
      if (at === null || at < t - early - 0.0003 || at > t + late + 0.0003) wrong.push(`${t}→${at === null ? 'missing' : at.toFixed(5)}`)
      else if (!RAMP[t]) worstOffset = Math.max(worstOffset, Math.abs(at - t))
      const p = peak(t, t + 0.12)
      peakRange = [Math.min(peakRange[0], p), Math.max(peakRange[1], p)]
    }
    // nothing anywhere else: a clip that lost its delay lands at 0
    const gaps = [[0.25, 0.45], [0.75, 1.45], [9.25, 9.95], [13.0, 14.9], [15.75, 17.2], [17.4, 18.4]]
    for (const [a, b] of gaps) if (peak(a, b) > 0.01) wrong.push(`sound in ${a}–${b} s`)
    if (wrong.length) { wrongRuns++; console.log(`      run ${run + 1}: ${wrong.join(', ')}`) }
  }
  check(`every clip on its place in all ${RUNS} runs`, wrongRuns === 0, `${wrongRuns} run(s) wrong; worst onset offset ${(worstOffset * 1000).toFixed(3)} ms`)
  check(`levels are the source's (every clip's peak within 0.2 dB of ${srcPeak.toFixed(3)})`,
    Math.abs(20 * Math.log10(peakRange[0] / srcPeak)) < 0.2 && Math.abs(20 * Math.log10(peakRange[1] / srcPeak)) < 0.2,
    peakRange.map((p) => p.toFixed(3)).join('…'))
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
