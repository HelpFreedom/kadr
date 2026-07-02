// Test: frame blending — a 25 fps source in a 60 fps project repeats frames
// 2-3-2-3 without blending (many exact duplicate output frames); with
// blending nearly every output frame is a unique mix. Matched fps must stay
// bit-identical (no blanket softening).
import WebSocket from 'ws'
import { execFileSync } from 'child_process'

const PORT = process.env.KADR_CDP_PORT || 9777

// self-contained: a 25 fps white box crossing a dark frame at 900 px/s —
// fast enough that a genuine source-frame step moves ~200 sampled pixels
execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test && ' +
  'ffmpeg -v error -f lavfi -i "color=c=0x202020:s=1920x1080:r=25:d=3" ' +
  '-f lavfi -i "color=c=white:s=300x300:r=25:d=3" ' +
  '-filter_complex "[0][1]overlay=x=\'mod(900*t\\,1500)\':y=390" ' +
  '-c:v libx264 -crf 18 -pix_fmt yuv420p -y /tmp/kadr-test/t25.mp4'])

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
    await new Promise((r) => setTimeout(r, 300))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// protect the user's live work before reloading
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
} catch { /* page mid-load */ }

try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// setup: 25 fps source fills the frame, project at 60 fps
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  ed.useEditor.setState({ project: { ...st().project, fps: 60 } })
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/t25.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, { muted: true })
  st().select([])
  return st().project.assets[0].fps
})()`)

const runExport = (out, fb) => evalJs(`(async () => {
  const ed = window.kadrEditor
  const preset = ed.PRESETS.find(p => p.container === 'mp4')
  const h = ed.startExport(ed.useEditor.getState().project, preset,
    '${out}', () => {}, { start: 0.5, end: 1.5 }, { motionBlur: false, frameBlending: ${fb} })
  await h.done
  return true
})()`)

await runExport('/tmp/kadr-test/fb-off.mp4', false)
await runExport('/tmp/kadr-test/fb-on.mp4', true)

// duplicate consecutive output frames: almost no pixels changed (the moving
// box shifts ~190 sampled pixels per genuine source frame step)
const dupCount = (file) => {
  execFileSync('bash', ['-c',
    `ffmpeg -v error -i ${file} -vf format=gray,scale=320:180 -f rawvideo -y /tmp/kadr-test/fb.gray`])
  return Number(execFileSync('python3', ['-c', `
data = open('/tmp/kadr-test/fb.gray', 'rb').read()
W, H = 320, 180
n = len(data) // (W * H)
dups = 0
for k in range(1, n):
    a = data[(k - 1) * W * H : k * W * H]
    b = data[k * W * H : (k + 1) * W * H]
    c = sum(1 for i in range(0, W * H, 3) if abs(b[i] - a[i]) >= 16)
    if c < 40:
        dups += 1
print(dups)
`]).toString().trim())
}
const offDups = dupCount('/tmp/kadr-test/fb-off.mp4')
const onDups = dupCount('/tmp/kadr-test/fb-on.mp4')
check('without blending the 25→60 cadence repeats frames', offDups > 20, `${offDups} duplicate frames of ~60`)
check('with blending almost every output frame is unique', onDups < 6, `${onDups} duplicate frames`)

// matched fps: blending must be a no-op (no blanket softening)
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  ed.useEditor.setState({ project: { ...st().project, fps: 25 } })
  return true
})()`)
await runExport('/tmp/kadr-test/fb25-off.mp4', false)
await runExport('/tmp/kadr-test/fb25-on.mp4', true)
const psnr = execFileSync('bash', ['-c',
  `ffmpeg -i /tmp/kadr-test/fb25-off.mp4 -i /tmp/kadr-test/fb25-on.mp4 -lavfi psnr -f null - 2>&1 | grep -o 'average:[0-9.inf]*' | head -1`
]).toString().trim()
const pv = psnr.includes('inf') ? 99 : Number(psnr.split(':')[1] || 0)
check('matched fps stays untouched (PSNR ≥ 45)', pv >= 45, psnr)

ws.close()
console.log('e2e21 finished')
