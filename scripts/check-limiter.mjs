// The export's master limiter (shared/audioMaster.ts), checked with the real
// ffmpeg on synthetic signals — the same chain string the export appends.
//
//   node scripts/check-limiter.mjs
//
//   1. below the limit it is transparent: pink noise comes back bit-identical
//      and exactly as long (the look-ahead delay is compensated and its buffer
//      does not eat the tail);
//   2. above it, peaks are held at MASTER_LIMIT;
//   3. and it does not move anything in time: away from an over-hot click the
//      signal is identical to the input.
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = transformSync(readFileSync(join(root, 'shared', 'audioMaster.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code
const M = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const dir = mkdtempSync(join(tmpdir(), 'kadr-limiter-'))
const chain = M.masterLimiterChain().join(',')
const ff = (...a) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...a])
const read = (p) => {
  const b = execFileSync('ffmpeg', ['-v', 'error', '-i', p, '-f', 'f32le', '-ac', '2', '-'], { maxBuffer: 1 << 28 })
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength >> 2)
}
try {
  // 1. below the limit
  ff('-f', 'lavfi', '-i', 'anoisesrc=d=2:c=pink:r=48000:a=0.3', '-ac', '2', '-c:a', 'pcm_f32le', join(dir, 'n.wav'))
  ff('-i', join(dir, 'n.wav'), '-af', chain, '-c:a', 'pcm_f32le', join(dir, 'n-out.wav'))
  const a = read(join(dir, 'n.wav')), b = read(join(dir, 'n-out.wav'))
  let same = a.length === b.length
  for (let i = 0; same && i < a.length; i++) if (a[i] !== b[i]) same = false
  check('below the limit: bit-identical and the same length', same, `${a.length / 2} vs ${b.length / 2} samples`)

  // 2 + 3. a 1.8 click over a quiet sine
  ff('-f', 'lavfi', '-i', "aevalsrc='if(between(t,0.5,0.502),1.8,0)+0.2*sin(2*PI*220*t)':s=48000:d=1.5", '-ac', '2', '-c:a', 'pcm_f32le', join(dir, 'c.wav'))
  ff('-i', join(dir, 'c.wav'), '-af', chain, '-c:a', 'pcm_f32le', join(dir, 'c-out.wav'))
  const x = read(join(dir, 'c.wav')), y = read(join(dir, 'c-out.wav'))
  let peak = 0
  for (const v of y) peak = Math.max(peak, Math.abs(v))
  check(`an over-hot click is held at ${M.MASTER_LIMIT}`, peak <= M.MASTER_LIMIT + 1e-4, `in 1.8, out ${peak.toFixed(4)}`)
  let far = true
  for (let i = 0.8 * 48000 * 2; i < 1.4 * 48000 * 2; i++) if (Math.abs(x[i] - y[i]) > 1e-7) { far = false; break }
  check('nothing moves in time: away from the click the signal is unchanged', far && x.length === y.length)
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
