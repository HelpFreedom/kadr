// Test: outer glow effect — a clip with the glow effect must show colored
// halo pixels outside its bounds (preview canvas), the halo must respond to
// the size/color params, animate over time (smoke), and survive export
// (WYSIWYG: the rendered file carries the same halo).
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

// protect the user's live work: autosave any non-trivial project first
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

// setup: one small centered clip, paused playhead at 0.5
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
  st().updateClip(c.id, { muted: true, transform: { ...c.transform, scale: { value: 0.35 } } })
  st().setPlayhead(0.5)
  st().select([])
  await new Promise(r => setTimeout(r, 800))
  return true
})()`)

// helper injected once: mean RGB over a ring just outside the clip bounds
await rawEval(`window.__ringStats = () => {
  const cv = document.querySelector('.preview canvas') || document.querySelector('canvas')
  const w = cv.width, h = cv.height
  const t = document.createElement('canvas')
  t.width = w; t.height = h
  const ctx = t.getContext('2d')
  ctx.drawImage(cv, 0, 0)
  const d = ctx.getImageData(0, 0, w, h).data
  // the clip is centered at 35% scale → its half-extent is ~0.175 of the fit
  // size; sample a ring at 0.22..0.34 of min(w,h) radius from center
  const cx = w / 2, cy = h / 2, m = Math.min(w, h)
  let n = 0, r = 0, g = 0, b = 0, bright = 0
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      const dist = Math.hypot(x - cx, y - cy)
      if (dist < 0.22 * m || dist > 0.34 * m) continue
      const i = (y * w + x) * 4
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++
      if (d[i] + d[i + 1] + d[i + 2] > 60) bright++
    }
  }
  // signature: red channel at 96 fixed points on the ring (pattern identity)
  const sig = []
  for (let k = 0; k < 96; k++) {
    const a = (k / 96) * 2 * Math.PI
    const x = Math.round(cx + Math.cos(a) * 0.28 * m)
    const y = Math.round(cy + Math.sin(a) * 0.28 * m)
    sig.push(d[(y * w + x) * 4])
  }
  return { r: r / n, g: g / n, b: b / n, bright, n, sig }
}; 0`)

const before = await evalJs(`window.__ringStats()`)

// add a strong magenta glow and let the preview redraw
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, { effects: [{ id: ed.uid(), type: 'glow', enabled: true,
    params: { color: '#ff30c0', size: 160, intensity: 1.3, saturation: 1.2,
              smoke: 0.85, speed: 1, particles: 0.6 } }] })
  st().setPlayhead(0.501)
  await new Promise(r => setTimeout(r, 600))
  return true
})()`)

const after = await evalJs(`window.__ringStats()`)
check('glow lights up the ring outside the clip',
  after.bright > before.bright + 200 && after.r > before.r + 8,
  `bright ${before.bright}→${after.bright}, meanR ${before.r.toFixed(1)}→${after.r.toFixed(1)}`)
check('glow keeps the magenta hue (R > G)', after.r > after.g + 5,
  `r=${after.r.toFixed(1)} g=${after.g.toFixed(1)} b=${after.b.toFixed(1)}`)

// smoke animates: a different clip-local time gives a different halo pattern
await evalJs(`(async () => {
  window.kadrEditor.useEditor.getState().setPlayhead(1.3)
  await new Promise(r => setTimeout(r, 600))
  return true
})()`)
const later = await evalJs(`window.__ringStats()`)
const sigDiff = after.sig.reduce((s, v, i) => s + Math.abs(v - later.sig[i]), 0) / after.sig.length
check('smoke pattern animates over time', sigDiff > 6,
  `mean ring diff ${sigDiff.toFixed(1)}`)

// WYSIWYG: the exported file carries the halo too
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const preset = ed.PRESETS.find(p => p.container === 'mp4')
  const h = ed.startExport(ed.useEditor.getState().project, preset,
    '/tmp/kadr-test/glow.mp4', () => {}, { start: 0, end: 1 }, { motionBlur: false })
  await h.done
  return true
})()`)
const stats = execFileSync('bash', ['-c',
  `ffmpeg -v error -ss 0.5 -i /tmp/kadr-test/glow.mp4 -frames:v 1 -f rawvideo -pix_fmt rgb24 -y /tmp/kadr-test/glow-f.rgb && python3 -c "
data = open('/tmp/kadr-test/glow-f.rgb', 'rb').read()
import struct, math
# probe the project size from the byte count assuming 16:9
n = len(data) // 3
w = int(round(math.sqrt(n * 16 / 9))); h = n // w
cx, cy, m = w / 2, h / 2, min(w, h)
bright = 0; rsum = 0; gsum = 0; cnt = 0
for y in range(0, h, 2):
    for x in range(0, w, 2):
        d = math.hypot(x - cx, y - cy)
        if d < 0.22 * m or d > 0.34 * m: continue
        i = (y * w + x) * 3
        r, g, b = data[i], data[i+1], data[i+2]
        rsum += r; gsum += g; cnt += 1
        if r + g + b > 60: bright += 1
print(bright, rsum / cnt, gsum / cnt)
"`]).toString().trim().split(/\s+/).map(Number)
check('exported file carries the glow (ring lit, magenta)',
  stats[0] > 200 && stats[1] > stats[2] + 5,
  `bright=${stats[0]} meanR=${stats[1].toFixed(1)} meanG=${stats[2].toFixed(1)}`)

ws.close()
console.log('e2e19 finished')
