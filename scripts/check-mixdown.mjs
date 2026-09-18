// Node-side check of ExportMuxer's audio graph (electron/ffmpeg.ts mixdownWav):
// every segment must land at its own timeline position. Some ffmpeg builds
// (e.g. gyan.dev git 2025-01-08) give adelay's padding frames broken pts, and
// the atrim after it then drops the delay — every clip collapsed onto t=0.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-mixdown.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = buildSync({
  entryPoints: [join(root, 'electron', 'ffmpeg.ts')],
  bundle: true, platform: 'node', format: 'esm', write: false,
  alias: { '@shared': join(root, 'shared') }
}).outputFiles[0].text
const { mixdownWav, FFMPEG } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-mix-'))
try {
  // a video stream next to the audio matters: a plain audio file does not
  // trigger the bad pts, an OBS-style mp4 seeked with -ss does
  const src = join(dir, 'av.mp4')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '2', '-c:v', 'libx264', '-g', '300', '-c:a', 'aac', src])
  const seg = (start) => ({ path: src, inPoint: 0.5, duration: 1, start, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0 })
  const out = join(dir, 'mix.wav')
  // tone in [0,1) and [2,3), silence in between and after
  await mixdownWav([seg(0), seg(2)], 4, out)

  const buf = readFileSync(out)
  const at = buf.indexOf('data') + 8
  const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length - ((buf.length - at) % 2)))
  const rms = (t0, t1) => {
    let s = 0, n = 0
    for (let i = Math.floor(t0 * 48000) * 2; i < Math.floor(t1 * 48000) * 2 && i < pcm.length; i++, n++) s += (pcm[i] / 32768) ** 2
    return n ? Math.sqrt(s / n) : 0
  }
  check('output is 4 s long', Math.abs(pcm.length / 2 / 48000 - 4) < 0.05, `${(pcm.length / 2 / 48000).toFixed(3)} s`)
  for (const [t0, t1, loud] of [[0.2, 0.8, true], [1.2, 1.8, false], [2.2, 2.8, true], [3.2, 3.8, false]]) {
    const r = rms(t0, t1)
    check(`${t0}–${t1} s ${loud ? 'has the tone' : 'is silent'}`, loud ? r > 0.05 : r < 0.001, `rms ${r.toFixed(4)}`)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
