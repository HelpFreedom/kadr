// Node-side check of ExportMuxer's container flags (electron/ffmpeg.ts): the
// delivered mp4/mov must carry its moov box BEFORE mdat (faststart), or a web
// player has to fetch the file's tail before it can start.
// Needs ffmpeg (PATH or KADR_FFMPEG).  Run: node scripts/check-faststart.mjs
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
const { ExportMuxer, FFMPEG } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// top-level ISO-BMFF box types, in file order
const topBoxes = (file) => {
  const b = readFileSync(file)
  const out = []
  for (let at = 0; at + 8 <= b.length;) {
    let size = b.readUInt32BE(at)
    const type = b.toString('latin1', at + 4, at + 8)
    if (size === 1) size = Number(b.readBigUInt64BE(at + 8))
    else if (size === 0) size = b.length - at
    out.push(type)
    if (size < 8) break
    at += size
  }
  return out
}

const dir = mkdtempSync(join(tmpdir(), 'kadr-faststart-'))
try {
  // the renderer's temp: video only, moov at the END (no faststart), as a
  // plain encode writes it — the mux must not inherit that order
  const videoTemp = join(dir, 'video.mp4')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=30:duration=5',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', videoTemp])
  const tone = join(dir, 'tone.wav')
  execFileSync(FFMPEG, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-ac', '2', tone])
  const tb = topBoxes(videoTemp)
  check('fixture temp has moov after mdat', tb.indexOf('moov') > tb.indexOf('mdat'), tb.join(' '))

  for (const [ext, ffmpegVideo] of [['mp4', 'copy'], ['mov', 'copy'], ['mp4', 'libx264']]) {
    const out = join(dir, `out-${ffmpegVideo}.${ext}`)
    await new ExportMuxer().run({
      projectName: 'faststart',
      preset: {
        id: 't', name: 't', container: 'mp4', codec: 'h264', ffmpegVideo,
        width: 320, height: 180, fps: 30, videoBitrate: 1_000_000,
        audioCodec: 'aac', audioBitrate: '128k'
      },
      outputPath: out, width: 320, height: 180, fps: 30, duration: 5,
      audioSegments: [{ path: tone, inPoint: 0, duration: 5, start: 0, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0 }]
    }, videoTemp, () => {})
    const boxes = topBoxes(out)
    const moov = boxes.indexOf('moov'), mdat = boxes.indexOf('mdat')
    check(`the delivered ${ext} (${ffmpegVideo}) has moov before mdat`, moov >= 0 && mdat >= 0 && moov < mdat, boxes.join(' '))
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
