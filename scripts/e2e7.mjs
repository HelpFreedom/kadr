// Test: pronounced smooth easing, multi-shape masks on GPU, stage context
// menu (restore view/field), move/rotate snapping, waveform display gain.
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
async function drag(x0, y0, x1, y1) {
  await mouse('mousePressed', x0, y0)
  for (let i = 1; i <= 8; i++) {
    await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8)
    await new Promise((r) => setTimeout(r, 25))
  }
  await mouse('mouseReleased', x1, y1)
}
async function rect(sel) {
  return evalJs(`(() => {
    const el = document.querySelector('${sel}')
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: r.x, y: r.y, w: r.width, h: r.height, cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
  })()`)
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadrEditor.evalAnim`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// 1. smooth easing is pronounced. NB the curve was deliberately retuned in
// b02261e to biasEase(2.2, 1.4) — "long build-up of speed, short crisp
// settle" (q3 ≈ 78.7); the old expectation (q3 > 90) described the previous
// (1.6, 2.4) curve.
const easing = await evalJs(`(() => {
  const ev = window.kadrEditor.evalAnim
  const lin = { value: 0, keyframes: [
    { time: 0, value: 0, easing: 'linear' }, { time: 1, value: 100, easing: 'linear' }] }
  const sm = { ...lin, smooth: true }
  return {
    q1: +ev(sm, 0.25).toFixed(1),
    q3: +ev(sm, 0.75).toFixed(1),
    lin1: +ev(lin, 0.25).toFixed(1)
  }
})()`)
check('smooth: s-curve with long build-up (q1<10, 70<q3<90)',
  easing.q1 < 10 && easing.q3 > 70 && easing.q3 < 90 && easing.lin1 === 25,
  JSON.stringify(easing))

// setup clip
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  st().setZoom(50)
  st().setPlayhead(1)
  return true
})()`)

// 2. waveform of linked audio clip is clearly visible (display gain)
await new Promise((r) => setTimeout(r, 800))
const wave = await evalJs(`(() => {
  const c = document.querySelector('.lane.audio .clip-wave')
  if (!c) return null
  const ctx = c.getContext('2d')
  const d = ctx.getImageData(0, 0, c.width, c.height).data
  let lit = 0
  for (let i = 3; i < d.length; i += 4) if (d[i] > 10) lit++
  return +(lit / (c.width * c.height)).toFixed(3)
})()`)
check('audio waveform visible (lit fraction > 0.5 after norm)', wave !== null && wave > 0.5, 'litFrac=' + wave)

// 3. multi-shape mask on GPU: two rects (left & right quadrants) + inverted ellipse center
const multi = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  const A = v => ({ value: v })
  st().updateClip(c.id, { maskShapes: [
    { type: 'rect', cx: A(0.2), cy: A(0.5), w: A(0.3), h: A(0.8), featherIn: A(0), featherOut: A(0), invert: false },
    { type: 'rect', cx: A(0.8), cy: A(0.5), w: A(0.3), h: A(0.8), featherIn: A(0), featherOut: A(0), invert: false },
    { type: 'ellipse', cx: A(0.2), cy: A(0.5), w: A(0.15), h: A(0.3), featherIn: A(0), featherOut: A(0), invert: true }
  ] })
  st().setPlayhead(c.start + 1)
  await new Promise(r => setTimeout(r, 2000))
  const canvas = document.querySelector('.preview canvas')
  const off = document.createElement('canvas')
  off.width = canvas.width; off.height = canvas.height
  const ctx = off.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  const d = ctx.getImageData(0, 0, off.width, off.height).data
  const px = (fx, fy) => {
    const i = ((Math.floor(off.height * fy) * off.width) + Math.floor(off.width * fx)) * 4
    return d[i] + d[i+1] + d[i+2]
  }
  // video fills the frame: layer UV == frame fractions
  return {
    inRect1: px(0.08, 0.5),   // inside left rect, outside inverted ellipse
    holeInRect1: px(0.2, 0.5),// center of inverted ellipse -> dark
    inRect2: px(0.8, 0.5),    // inside right rect
    between: px(0.5, 0.5)     // between rects -> dark
  }
})()`)
check('multi-mask: two rects lit, gap dark, inverted ellipse cuts hole',
  multi.inRect1 > 60 && multi.inRect2 > 60 && multi.between < 20 && multi.holeInRect1 < 20,
  JSON.stringify(multi))

// 4. open editor, mask mode shows 3 shapes; context menu restores view
await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().setAnimClip(c.id)
  return 1
})()`)
await new Promise((r) => setTimeout(r, 600))
await evalJs(`(() => { [...document.querySelectorAll('.anim-toolbar button')][1].click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 400))
const shapeCount = await evalJs(`document.querySelectorAll('.mask-shape').length`)
check('editor shows 3 shapes', shapeCount === 3, 'shapes=' + shapeCount)

const stage = await rect('.anim-stage')
await mouse('mousePressed', stage.cx, stage.cy, { button: 'right', buttons: 2 })
await mouse('mouseReleased', stage.cx, stage.cy, { button: 'right', buttons: 0 })
await new Promise((r) => setTimeout(r, 300))
const menu = await evalJs(`(() => {
  const m = document.querySelector('.anim-editor ~ * , .ctx-menu')
  const el = document.querySelector('.ctx-menu')
  return el ? [...el.querySelectorAll('button')].map(b => b.textContent) : null
})()`)
check('right-click opens stage context menu', !!menu && menu.length === 2, JSON.stringify(menu))
await evalJs(`(() => { [...document.querySelectorAll('.ctx-menu button')][0].click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 300))
const restored = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t => t.name === 'V1').clips[0]
  return { shapes: (c.maskShapes || []).length, mL: c.mask ? c.mask.left.value : 0 }
})()`)
check('Restore view (mask mode) clears shapes and edges', restored.shapes === 0 && restored.mL === 0,
  JSON.stringify(restored))

// 5. move snapping: small drag near center snaps x/y back to 0
await evalJs(`(() => { [...document.querySelectorAll('.anim-toolbar button')][0].click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 300))
const layer = await rect('.anim-layer')
await drag(layer.cx, layer.cy, layer.cx + 5, layer.cy + 4)
const snapped = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t => t.name === 'V1').clips[0]
  return { x: c.transform.x.value, y: c.transform.y.value }
})()`)
check('move snap: tiny drag snaps back to center (0,0)', snapped.x === 0 && snapped.y === 0, JSON.stringify(snapped))

// 6. rotation snapping to 45°: drag the rotate handle a little
const rot = await rect('.rotate-handle')
await drag(rot.cx, rot.cy, rot.cx + 7, rot.cy)
const rotV = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t => t.name === 'V1').clips[0]
  return c.transform.rotation.value
})()`)
check('rotation snaps to 0/45 multiples', Math.abs(rotV % 45) < 0.001, 'rot=' + rotV)

ws.close()
console.log('e2e7 finished')
