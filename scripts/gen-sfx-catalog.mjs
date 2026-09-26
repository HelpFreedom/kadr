// Regenerate resources/sfx/kadr-sfx.json: shared/sfxFeatures.ts over every
// bundled sound — the hit time for all of them, and labels for the ones /brag
// did not analyse (the keyboard set). /brag's own labels stay authoritative for
// the 228 it did; main merges the two (electron/sounds.ts).
//
//   node scripts/gen-sfx-catalog.mjs
//
// Needs ffmpeg/ffprobe; ~25 s. Rerun after adding or replacing a bundled sound.
import { readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = transformSync(readFileSync(join(root, 'shared', 'sfxFeatures.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code
const F = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

const SR = 44100
function decode(path) {
  const info = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=channels:format=duration', '-of', 'json', path]).toString())
  const ch = info.streams[0].channels
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 })
  const inter = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength >> 2)
  const frames = Math.min(Math.floor(inter.length / ch), Math.round(Number(info.format.duration) * SR))
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let s = 0
    for (let c = 0; c < ch; c++) s += inter[i * ch + c]
    mono[i] = s / ch
  }
  return mono
}

const sfxRoot = join(root, 'resources', 'sfx')
const files = []
for (const fam of readdirSync(sfxRoot).sort()) {
  const dir = join(sfxRoot, fam)
  if (!statSync(dir).isDirectory()) continue
  for (const name of readdirSync(dir).sort()) {
    if (!/\.(ogg|wav|mp3|flac|m4a|opus)$/i.test(name)) continue
    const x = F.sfxFeatures(decode(join(dir, name)), SR)
    files.push({ path: `${fam}/${name}`, duration: x.duration, hit: x.hit, labels: F.labelSfx(x), features: x })
  }
}
writeFileSync(join(sfxRoot, 'kadr-sfx.json'), JSON.stringify({
  schemaVersion: 1,
  analysisVersion: F.SFX_ANALYSIS_VERSION,
  generatedBy: 'scripts/gen-sfx-catalog.mjs (shared/sfxFeatures.ts)',
  files
}, null, 1) + '\n')
console.log(`kadr-sfx.json: ${files.length} sounds`)
