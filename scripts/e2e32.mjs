// Test: export decode/render fast paths must not change a single pixel.
//  1. Alpha video (VP9+alpha WebM) decodes through the packed colour+matte
//     H.264 intermediate instead of per-frame <video> seeks — same frames,
//     several times faster.
//  2. Motion blur collapses its 8 sub-composites into one whenever nothing
//     moves within the shutter — same frames again.
//  3. Alpha compositing itself stays correct (half-transparent green over
//     black reads back at ~half intensity).
import WebSocket from 'ws'
import { execFileSync } from 'child_process'

const PORT = process.env.KADR_CDP_PORT || 9777

// media: 2 s of VP9+alpha, left half opaque red, right half green at alpha 128
execFileSync('bash', ['-c', 'mkdir -p /tmp/kadr-test'])
execFileSync('python3', ['-c', `
from struct import pack
import zlib
w, h = 1280, 720
def chunk(t, d):
    c = t + d
    return pack('>I', len(d)) + c + pack('>I', zlib.crc32(c) & 0xffffffff)
rows = b''
for y in range(h):
    row = bytearray([0])
    for x in range(w):
        row += (bytes((255, 0, 0, 255)) if x < w // 3
                else bytes((0, 255, 0, 128)) if x < 2 * w // 3 else bytes((0, 0, 255, 64)))
    rows += bytes(row)
png = (b'\\x89PNG\\r\\n\\x1a\\n' + chunk(b'IHDR', pack('>IIBBBBB', w, h, 8, 6, 0, 0, 0))
       + chunk(b'IDAT', zlib.compress(rows, 6)) + chunk(b'IEND', b''))
open('/tmp/kadr-test/alpha32.png', 'wb').write(png)
`])
execFileSync('bash', ['-c',
  'ffmpeg -v error -y -loop 1 -i /tmp/kadr-test/alpha32.png -t 2 -r 30 -vf format=yuva420p ' +
  '-c:v libvpx-vp9 -pix_fmt yuva420p -crf 20 -b:v 0 -cpu-used 5 -row-mt 1 -auto-alt-ref 0 ' +
  '/tmp/kadr-test/alpha32.webm'])
// a moving clip so the shutter test also covers a frame where blur matters
execFileSync('bash', ['-c',
  'ffmpeg -v error -y -f lavfi -i "testsrc=s=1280x720:d=3:r=30" -c:v libx264 -crf 18 ' +
  '-pix_fmt yuv420p /tmp/kadr-test/move32.mp4'])

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('CDP target not found')
}

let id = 0
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
async function rawEval(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function evalJs(expression, { timeout = 600000 } = {}) {
  const key = `k${Date.now()}_${++id}`
  await rawEval(
    `window.__e2e = window.__e2e || {};` +
    `(async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) }` +
    ` catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`
  )
  const t0 = Date.now()
  for (;;) {
    const raw = await rawEval(`window.__e2e.${key} ?? null`)
    if (raw !== null) {
      const r = JSON.parse(raw)
      if ('err' in r) throw new Error('JS exception: ' + r.err)
      return r.ok
    }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 400))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// protect the user's live project, then start clean
try {
  const saved = await evalJs(`(async () => {
    const st = window.kadrEditor?.useEditor?.getState?.()
    if (!st) return 'no-store'
    const clips = st.project.tracks.reduce((n, t) => n + t.clips.length, 0)
    if (!clips) return 'empty'
    const p = '${process.env.HOME}/Downloads/autosave-' + Date.now() + '.kadr'
    await window.kadr.writeProject(p, st.project)
    return p
  })()`, { timeout: 15000 })
  if (saved !== 'empty' && saved !== 'no-store') console.log('live project autosaved →', saved)
} catch { /* mid-load */ }
try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// ---------------------------------------------------------------- phase A
// alpha correctness: the banded clip alone over a black background, so every
// composited value is known in advance
const setup = await evalJs(`(async () => {
  const ed = window.kadrEditor, st = () => ed.useEditor.getState()
  st().setProject({ name: 'e2e32a', width: 960, height: 540, fps: 60, background: '#000000',
    assets: [], texts: [], tracks: [
      { id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 },
      { id: 'a1', name: 'A1', kind: 'audio', clips: [], gain: 1 }] }, null)
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/alpha32.webm')
  const id = ed.uid()
  st().addAsset({ id, ...asset })
  st().insertClipFromAsset(id, 'v1', 0)
  return { hasAlpha: !!asset.hasAlpha, codec: asset.codec }
})()`)
check('the alpha source is recognised as such', setup.hasAlpha, `codec=${setup.codec}`)

const runExport = async (name, flags, range = { start: 0.3, end: 1.3 }) => {
  const t0 = Date.now()
  const hashes = await evalJs(`(async () => {
    const ke = window.kadrEditor, st = () => ke.useEditor.getState()
    globalThis.KADR_FRAME_HASH = []
    globalThis.KADR_DISABLE_ALPHA_PACK = ${!!flags.noPack}
    globalThis.KADR_FORCE_FULL_SHUTTER = ${!!flags.fullShutter}
    const preset = ke.PRESETS.find(x => x.id === 'source')
    await ke.startExport(st().project, preset, '/tmp/kadr-test/e2e32-${name}.mp4', () => {},
      { start: ${range.start}, end: ${range.end} }, { motionBlur: true, frameBlending: true }).done
    const h = globalThis.KADR_FRAME_HASH
    globalThis.KADR_FRAME_HASH = null
    globalThis.KADR_DISABLE_ALPHA_PACK = false
    globalThis.KADR_FORCE_FULL_SHUTTER = false
    return h
  })()`)
  return { hashes, ms: Date.now() - t0 }
}

await runExport('warm', {})                       // build the packed intermediate
await runExport('packed', {})
await runExport('element', { noPack: true })

const bands = (tag) => {
  execFileSync('bash', ['-c',
    `ffmpeg -v error -y -ss 0.3 -i /tmp/kadr-test/e2e32-${tag}.mp4 -frames:v 1 ` +
    `-f rawvideo -pix_fmt rgb24 /tmp/kadr-test/e2e32-${tag}.rgb`])
  return execFileSync('python3', ['-c', `
d = open('/tmp/kadr-test/e2e32-${tag}.rgb','rb').read()
W, y = 960, 270
def at(x):
    i = (y*W + x) * 3
    return tuple(d[i:i+3])
print(at(160), at(480), at(800))
`]).toString().trim()
}
const pb = bands('packed')
const eb = bands('element')
const n = pb.match(/\d+/g).map(Number)
check('opaque band stays opaque red', n[0] > 200 && n[1] < 40 && n[2] < 40, pb)
check('alpha 128 composites at ~half intensity', n[4] > 100 && n[4] < 160, pb)
check('alpha 64 composites at ~quarter intensity', n[8] > 40 && n[8] < 95, pb)
check('both decode paths composite alpha identically', pb === eb, `${pb} vs ${eb}`)

const psnrOf = (a, b) => {
  const out = execFileSync('bash', ['-c',
    `ffmpeg -v error -i /tmp/kadr-test/${a}.mp4 -i /tmp/kadr-test/${b}.mp4 ` +
    `-lavfi "[0][1]psnr=stats_file=-" -f null - 2>&1 | tail -1`]).toString()
  return /psnr_avg:inf/.test(out) ? 99 : Number((out.match(/psnr_avg:([\d.]+)/) || [])[1])
}
const psnr = psnrOf('e2e32-packed', 'e2e32-element')
check('packed alpha decode renders the same picture as element seeks', psnr >= 40, `PSNR ${psnr} dB`)

// ---------------------------------------------------------------- phase B
// speed and the motion-blur shutter: the moving clip fades in, so part of the
// range collapses the shutter (nothing moves) and part cannot (opacity ramps)
await evalJs(`(async () => {
  const ed = window.kadrEditor, st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/move32.mp4')
  const id = ed.uid()
  st().addAsset({ id, ...asset })
  st().addTrack('video')
  const v2 = st().project.tracks.find(t => t.kind === 'video' && !t.clips.length)
  st().insertClipFromAsset(id, v2.id, 0)
  const clip = st().project.tracks.find(t => t.id === v2.id).clips[0]
  st().updateClip(clip.id, { fadeIn: 0.8, muted: true })
  return true
})()`)

const packed = await runExport('packedB', {}, { start: 0.2, end: 1.8 })
const element = await runExport('elementB', { noPack: true }, { start: 0.2, end: 1.8 })
check('packed alpha decode is faster', packed.ms * 1.25 < element.ms,
  `packed ${(packed.ms / 1000).toFixed(1)}s vs element ${(element.ms / 1000).toFixed(1)}s`)

const full = await runExport('full8', { fullShutter: true }, { start: 0.2, end: 1.8 })
const sameShutter = full.hashes.length === packed.hashes.length &&
  full.hashes.every((v, i) => v === packed.hashes[i])
check('collapsing a static motion-blur shutter changes nothing', sameShutter,
  `${full.hashes.filter((v, i) => v !== packed.hashes[i]).length} of ${full.hashes.length} differ`)

ws.close()
console.log('e2e32 finished')
