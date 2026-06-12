// Test: perspective-correct 3D texturing (internal bar edges stay straight
// under rotY) and Restore view resetting the 3D params.
import WebSocket from 'ws'

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
async function evalJs(expression, { timeout = 120000 } = {}) {
  const key = `r${++id}`
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
    await new Promise((r) => setTimeout(r, 250))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
async function mouse(type, x, y, opts = {}) {
  await send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...opts
  })
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

// setup: smptebars clip (clean vertical bars) tilted around Y
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idB = ed.uid()
  st().addAsset({ id: idB, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idB, v1.id, 0)
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, { muted: true, transform: { ...c.transform,
    rotX: {value:0}, rotY: {value:55}, z: {value:0} } })
  st().setPlayhead(c.start + 1)
  return true
})()`)

// 1. internal bar boundaries stay vertical (projective texturing)
const straight = await evalJs(`(async () => {
  await new Promise(r => setTimeout(r, 2200))
  const canvas = document.querySelector('.preview canvas')
  const off = document.createElement('canvas')
  off.width = canvas.width; off.height = canvas.height
  const ctx = off.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  const img = ctx.getImageData(0, 0, off.width, off.height)
  const d = img.data
  const W = off.width, H = off.height
  const px = (x, y) => {
    const i = (y * W + x) * 4
    return [d[i], d[i+1], d[i+2]]
  }
  const lum = (x, y) => { const p = px(x, y); return p[0] + p[1] + p[2] }
  // boundaries (strong horizontal color transitions) inside the lit region
  const boundaries = (y) => {
    let minX = W, maxX = 0
    for (let x = 0; x < W; x++) {
      if (lum(x, y) > 30) { minX = Math.min(minX, x); maxX = Math.max(maxX, x) }
    }
    const out = []
    for (let x = minX + 6; x < maxX - 6; x++) {
      const a = px(x - 2, y), b = px(x + 2, y)
      const diff = Math.abs(a[0]-b[0]) + Math.abs(a[1]-b[1]) + Math.abs(a[2]-b[2])
      if (diff > 120) {
        if (!out.length || x - out[out.length - 1] > 6) out.push(x)
      }
    }
    return { minX, maxX, out }
  }
  // smptebars: the top ~2/3 has uniform vertical bars; sample two rows there
  const y1 = Math.floor(H * 0.30)
  const y2 = Math.floor(H * 0.48)
  const b1 = boundaries(y1)
  const b2 = boundaries(y2)
  const n = Math.min(b1.out.length, b2.out.length)
  let maxDev = 0
  for (let i = 0; i < n; i++) maxDev = Math.max(maxDev, Math.abs(b1.out[i] - b2.out[i]))
  return { n, maxDev, b1: b1.out.slice(0, 8), b2: b2.out.slice(0, 8) }
})()`)
check('3D texture is projective: bar edges vertical (max deviation ≤ 3px)',
  straight.n >= 4 && straight.maxDev <= 3, JSON.stringify(straight))

// 2. Restore view resets the 3D params too
await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().setAnimClip(c.id)
  return 1
})()`)
await new Promise((r) => setTimeout(r, 500))
const stage = await evalJs(`(() => {
  const el = document.querySelector('.anim-stage')
  const r = el.getBoundingClientRect()
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
})()`)
await mouse('mousePressed', stage.cx, stage.cy, { button: 'right', buttons: 2 })
await mouse('mouseReleased', stage.cx, stage.cy, { button: 'right', buttons: 0 })
await new Promise((r) => setTimeout(r, 250))
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.ctx-menu button')]
    .find(b => /Восстановить вид|Restore view/.test(b.textContent))
  btn.click()
  return 1
})()`)
await new Promise((r) => setTimeout(r, 250))
const restored = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const c = st.project.tracks.find(t => t.name === 'V1').clips[0]
  const rel = st.playhead - c.start
  return {
    rotY: +ed.evalAnim(c.transform.rotY, rel).toFixed(2),
    rotX: +ed.evalAnim(c.transform.rotX, rel).toFixed(2),
    is3D: !!c.transform.rotX
  }
})()`)
check('Restore view zeroes the 3D rotations (3D mode kept on)',
  restored.rotY === 0 && restored.rotX === 0 && restored.is3D, JSON.stringify(restored))

ws.close()
console.log('e2e12 finished')
