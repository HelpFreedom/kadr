// Test: export motion blur — a fast keyframe-animated clip exported with
// shutter blur must show smeared edges along the motion path, without it
// stays sharp; both exports complete and differ.
import WebSocket from 'ws'
import { execFileSync } from 'child_process'

const PORT = process.env.KADR_CDP_PORT || 9777

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
try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// setup: small clip flying left→right at 600 px/s (20 px per 30fps frame)
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idB = ed.uid()
  st().addAsset({ id: idB, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idB, v1.id, 0)
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().setClipDuration(c.id, 2)
  st().updateClip(c.id, { muted: true, transform: { ...c.transform,
    scale: { value: 0.35 },
    x: { value: 0, keyframes: [
      { time: 0, value: -600, easing: 'linear' },
      { time: 2, value: 600, easing: 'linear' }
    ] } } })
  st().select([])
  return true
})()`)

const runExport = (out, mb) => evalJs(`(async () => {
  const ed = window.kadrEditor
  const preset = ed.PRESETS.find(p => p.container === 'mp4')
  const t0 = performance.now()
  const h = ed.startExport(ed.useEditor.getState().project, preset,
    '${out}', () => {}, null, { motionBlur: ${mb} })
  await h.done
  return { ms: Math.round(performance.now() - t0) }
})()`)

const sharp = await runExport('/tmp/kadr-test/mb-off.mp4', false)
const blur = await runExport('/tmp/kadr-test/mb-on.mp4', true)
check('both exports complete', true, `sharp ${sharp.ms}ms, blurred ${blur.ms}ms`)

// a smeared edge is a wide gentle luma ramp; a sharp one jumps in 1-2 px.
// count pixels whose horizontal gradient is gentle-but-nonzero (8..60)
const rampPixels = (file) => {
  execFileSync('bash', ['-c',
    `ffmpeg -v error -ss 1.0 -i ${file} -frames:v 1 -vf crop=800:400:560:340,format=gray -f rawvideo -y /tmp/kadr-test/mb-f.gray`
  ])
  const out = execFileSync('python3', ['-c', `
data = open('/tmp/kadr-test/mb-f.gray', 'rb').read()
W, H = 800, 400
n = 0
for y in range(H):
    row = y * W
    for x in range(1, W):
        d = abs(data[row + x] - data[row + x - 1])
        if 8 <= d <= 60:
            n += 1
print(n)
`]).toString().trim()
  return Number(out)
}
const eSharp = rampPixels('/tmp/kadr-test/mb-off.mp4')
const eBlur = rampPixels('/tmp/kadr-test/mb-on.mp4')
check('motion blur smears moving edges (wider luma ramps)',
  eBlur > eSharp * 1.5 && eBlur > 500,
  `sharp ${eSharp} px vs blurred ${eBlur} px`)

// the two outputs differ visibly
const diff = execFileSync('bash', ['-c',
  `ffmpeg -i /tmp/kadr-test/mb-off.mp4 -i /tmp/kadr-test/mb-on.mp4 -lavfi psnr -f null - 2>&1 | grep -o 'average:[0-9.inf]*' | head -1`
]).toString().trim()
const psnr = diff.includes('inf') ? 99 : Number(diff.split(':')[1] || 0)
check('blurred output differs from sharp (PSNR < 45)', psnr > 0 && psnr < 45, diff)

ws.close()
console.log('e2e18 finished')
