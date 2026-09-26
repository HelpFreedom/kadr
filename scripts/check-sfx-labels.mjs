// Check shared/sfxFeatures.ts against /brag's labelled sound set.
//
//   node scripts/check-sfx-labels.mjs
//
// Decodes the 228 analysed files of resources/sfx with ffmpeg (channel mean,
// trimmed to the container duration — the input the features are defined on)
// and checks: the one exact feature matches /brag's number, and the fitted
// rules agree with /brag's labels at least as well as they did when fitted.
// Plus a synthetic check of the hit time. Needs ffmpeg/ffprobe; ~25 s.
import { readFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = transformSync(readFileSync(join(root, 'shared', 'sfxFeatures.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code
const F = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

function decode(path, sr = 44100) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=channels:format=duration', '-of', 'json', path]).toString())
  const ch = info.streams[0].channels
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ar', String(sr), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2)
  const frames = Math.min(Math.floor(inter.length / ch), Math.round(Number(info.format.duration) * sr))
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let s = 0
    for (let c = 0; c < ch; c++) s += inter[i * ch + c]
    mono[i] = s / ch
  }
  return mono
}

// ---- synthetic: the hit of a sound with a lead-in ---------------------------
{
  const sr = 44100
  const y = new Float32Array(sr * 3)
  for (let i = 0; i < y.length; i++) {
    const t = i / sr
    // a quiet rising hiss for 1.5 s, then a decaying thump
    y[i] = t < 1.5 ? 0.02 * (t / 1.5) * Math.sin(i * 1.7) : 0.8 * Math.exp(-(t - 1.5) / 0.15) * Math.sin(2 * Math.PI * 60 * (t - 1.5))
  }
  const x = F.sfxFeatures(y, sr)
  check('hit: a thump after a 1.5 s lead-in is found at 1.5 s (±25 ms)', Math.abs(x.hit - 1.5) < 0.025, `${x.hit} s`)
  // a loop of equal clicks has no single hit: placing it must not shift it
  const loop = new Float32Array(sr * 6)
  for (let k = 0; k < 20; k++) for (let i = 0; i < 400; i++) loop[Math.round((0.2 + k * 0.28) * sr) + i] = 0.6 * Math.exp(-i / 60) * Math.sin(i * 0.9)
  const lx = F.sfxFeatures(loop, sr)
  check('a loop of 20 equal clicks has no single hit (hit = 0)', lx.hit === 0 && lx.bursts > 2, `hit ${lx.hit}, ${lx.bursts} bursts`)
  // a steady tone: one long plateau, no hit either
  const hum = new Float32Array(sr * 4).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 110 * i) / sr))
  const hx = F.sfxFeatures(hum, sr)
  check('a steady 4 s hum has no single hit', hx.hit === 0 && hx.plateau > 1, `hit ${hx.hit}, plateau ${hx.plateau} s`)
  // (its risk comes out "medium": /brag's rule reads the crest factor of the
  // WHOLE file, and 1.5 s of quiet lead-in makes the crest large)
  const l = F.labelSfx(x)
  check('the thump is warm and transient', l.brightness === 'warm' && l.envelope === 'transient', JSON.stringify(l))
}

// ---- against /brag -----------------------------------------------------------
const sfxRoot = join(root, 'resources', 'sfx')
const brag = JSON.parse(readFileSync(join(sfxRoot, 'sfx-analysis.json'), 'utf8')).files
const agree = { brightness: 0, hfRisk: 0, envelope: 0, transientSplit: 0 }
const hiErr = []
const arErr = []
for (const f of brag) {
  const x = F.sfxFeatures(decode(join(sfxRoot, f.path)), 44100)
  const l = F.labelSfx(x)
  hiErr.push(Math.abs(x.hiRatio - f.spectral.energyRatioHigh))
  arErr.push(Math.abs(x.activeRatio - f.transient.activeRatio))
  if (l.brightness === f.labels.brightness) agree.brightness++
  if (l.hfRisk === f.labels.highFrequencyRisk) agree.hfRisk++
  if (l.envelope === f.labels.envelopeShape) agree.envelope++
  if ((l.envelope === 'transient') === (f.labels.envelopeShape === 'transient')) agree.transientSplit++
}
const n = brag.length
const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1]
const pct = (k) => `${agree[k]}/${n} = ${((agree[k] / n) * 100).toFixed(1)} %`
check('the exact feature: share of |X| in 4–16 kHz = /brag energyRatioHigh (median |Δ| < 0.001)',
  med(hiErr) < 0.001, `median ${med(hiErr).toFixed(5)}, max ${Math.max(...hiErr).toFixed(4)}`)
check('activeRatio = /brag\'s (median |Δ| < 0.001)', med(arErr) < 0.001, `median ${med(arErr).toFixed(4)}`)
check('brightness agrees with /brag ≥ 96 %', agree.brightness / n >= 0.96, pct('brightness'))
check('high-frequency risk agrees with /brag ≥ 98 %', agree.hfRisk / n >= 0.98, pct('hfRisk'))
check('transient vs not agrees with /brag ≥ 98 %', agree.transientSplit / n >= 0.98, pct('transientSplit'))
check('envelope (3 classes) agrees with /brag ≥ 90 %', agree.envelope / n >= 0.9, pct('envelope'))

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
