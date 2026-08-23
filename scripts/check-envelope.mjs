// Node-side check of shared/envelope.ts (the Blender "Bake Sound" follower used by
// the neon-wave module). No test runner in the repo: transpile with esbuild and
// import through a data URL.  Run: node scripts/check-envelope.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'envelope.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { EnvelopeFollower, envelopeFrames } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// --- synthetic burst: stereo 48 kHz, 2 s, 1 kHz sine amplitude 0.5 on both channels in [0.5, 1.0)
const sr = 48000, ch = 2, fps = 60, frames = 120
const pcm = new Float32Array(sr * 2 * ch)
for (let i = 0; i < sr * 2; i++) {
  const t = i / sr
  const v = t >= 0.5 && t < 1.0 ? 0.5 * Math.sin(2 * Math.PI * 1000 * t) : 0
  pcm[i * ch] = v
  pcm[i * ch + 1] = v
}
const env = envelopeFrames(pcm, sr, ch, fps, frames)
check('length === frames', env.length === frames, String(env.length))
check('silence before the burst is exactly 0', env.slice(0, 30).every((v) => v === 0))
check('attack: 17 ms into the burst ≥ 0.85 (|L+R| peaks at 1.0)', env[31] >= 0.85, env[31].toFixed(3))
check('sustain: end of burst ≥ 0.9', env[59] >= 0.9, env[59].toFixed(3))
const r200 = env[72] / env[60] // t = 1.2 vs 1.0 → one release constant → ×0.1
check('release: 200 ms after the burst ≈ 0.1× (±25 %)', r200 > 0.075 && r200 < 0.125, r200.toFixed(3))
const r400 = env[84] / env[60]
check('release: 400 ms after ≈ 0.01× (±50 %)', r400 > 0.005 && r400 < 0.015, r400.toFixed(4))
check('monotone decay after the burst', env.slice(60).every((v, i, a) => i === 0 || v <= a[i - 1] + 1e-12))

// --- streaming equivalence: random, misaligned chunks must give identical output
const f = new EnvelopeFollower(sr, ch, fps, frames)
let pos = 0
let seed = 12345
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
while (pos < pcm.length) {
  const n = Math.min(pcm.length - pos, 1 + Math.floor(rnd() * 7001)) // odd sizes → split frames
  f.push(pcm.subarray(pos, pos + n))
  pos += n
}
const env2 = f.result()
const maxDiff = Math.max(...env.map((v, i) => Math.abs(v - env2[i])))
check('chunked push == whole buffer (1e-9)', maxDiff < 1e-9, `max diff ${maxDiff}`)

// --- edge cases
check('empty input → zeros', envelopeFrames(new Float32Array(0), sr, ch, fps, 10).every((v) => v === 0))
const short = envelopeFrames(pcm.subarray(0, sr * ch), sr, ch, fps, frames) // only the first second fed
check('frames past the audio hold the follower\'s last value', short.slice(60).every((v) => v === short[60]) && short[60] > 0.9, `${short[59].toFixed(3)} → ${short[60].toFixed(3)}`)
check('mono and fps > sr do not throw', (() => {
  try { envelopeFrames(new Float32Array([0.5, 0.5, 0.5]), 10, 1, 100, 25); return true } catch { return false }
})())
// fps > sr: frames between two samples interpolate linearly
const tiny = envelopeFrames(new Float32Array([0, 1, 1, 1]), 4, 1, 8, 6, { attack: 1e-9, release: 1e-9 })
check('sub-sample frames interpolate', Math.abs(tiny[1] - 0.5) < 1e-9 && tiny[2] === 1, tiny.map((v) => v.toFixed(2)).join(','))

console.log(fails ? `check-envelope: ${fails} FAILED` : 'check-envelope: all passed')
process.exit(fails ? 1 : 0)
