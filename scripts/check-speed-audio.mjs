// One speed rule for audio (shared/audioSpeed.ts): inside [1/16, 16]× a clip's
// audio follows its speed exactly, outside it the clip is silent — in the
// export mix AND in the preview. Before, the export clamped atempo to 0.25–8
// and the preview clamped playbackRate to 1/16–16, so at 20× the exported
// sound ran 2.5× past the clip's end, and at 0.1× it stopped early.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-speed-audio.mjs
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { buildSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const load = async (entry, contents) => {
  const js = buildSync({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'error',
    alias: { '@shared': join(root, 'shared'), '@': join(root, 'src') }
  }).outputFiles[0].text
  return import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
}
// the same collector the export (and every analysis mixdown) uses, the same
// query the preview asks which clips to un-mute, and main's mixer
// (the modules come with the store, which reads its settings at load)
globalThis.window = globalThis.window ?? {}
const mem = new Map()
globalThis.localStorage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) }
const { collectRangeAudio } = await load('', `export { collectRangeAudio } from './src/engine/subtitles'`)
const { audibleClipsAt } = await load('', `export { audibleClipsAt } from './src/engine/player'`)
const { mixdownWav, FFMPEG } = await load('', `export { mixdownWav, FFMPEG } from './electron/ffmpeg'`)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-speedaudio-'))
try {
  // 120 s of tone: long enough that a 1 s clip at 100× never loops
  const src = join(dir, 'tone.wav')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=120', '-ac', '2', '-ar', '48000', src])
  const asset = { id: 'a', kind: 'audio', path: src, duration: 120, hasAudio: true }
  const FRAME = 1 / 30
  const START = 0.5, DUR = 1, LEN = 5

  for (const speed of [0.02, 0.05, 1 / 16, 0.1, 0.5, 1, 4, 16, 20, 100]) {
    const clip = { id: 'c', kind: 'media', assetId: 'a', start: START, duration: DUR, inPoint: 0, speed, gain: { value: 1 } }
    const project = { assets: [asset], tracks: [{ id: 't', kind: 'audio', gain: 1, clips: [clip] }] }
    const inside = speed >= 1 / 16 && speed <= 16
    const tag = `${+speed.toFixed(4)}×`

    const heard = audibleClipsAt(project, START + DUR / 2).length > 0
    check(`${tag}: preview ${inside ? 'plays' : 'silences'} the clip`, heard === inside)

    const segs = collectRangeAudio(project, 0, LEN)
    let tone = null // [first, last] 5 ms window with the tone
    if (segs.length) {
      const out = join(dir, `mix-${speed}.wav`)
      await mixdownWav(segs, LEN, out)
      const buf = readFileSync(out)
      const at = buf.indexOf('data') + 8
      const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + at, buf.byteOffset + buf.length - ((buf.length - at) % 2)))
      const W = 240 // 5 ms of 48 kHz
      for (let w = 0; w * W * 2 < pcm.length; w++) {
        let s = 0
        for (let i = w * W * 2; i < (w + 1) * W * 2 && i < pcm.length; i++) s += (pcm[i] / 32768) ** 2
        if (Math.sqrt(s / (W * 2)) > 0.05) tone = tone ? [tone[0], (w + 1) * W / 48000] : [w * W / 48000, (w + 1) * W / 48000]
      }
    }
    if (inside) {
      const ok = tone && Math.abs(tone[0] - START) <= FRAME && Math.abs(tone[1] - (START + DUR)) <= FRAME
      check(`${tag}: export audio spans the clip ±1 frame`, !!ok,
        tone ? `tone ${tone[0].toFixed(3)}–${tone[1].toFixed(3)} s, clip ${START}–${START + DUR} s` : 'silent')
    } else {
      check(`${tag}: export audio is silent`, !tone,
        tone ? `tone ${tone[0].toFixed(3)}–${tone[1].toFixed(3)} s` : '')
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
