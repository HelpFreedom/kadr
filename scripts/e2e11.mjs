// Test: 3D orbit handle on the clip stage; track-motion stage preview
// (move / scale / rotate / 3D orbit by mouse).
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
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// setup clip + open anim editor + enable 3D
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().setAnimClip(c.id)
  st().setPlayhead(c.start + 1)
  return true
})()`)
await new Promise((r) => setTimeout(r, 600))
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.anim-toolbar button')].find(b => b.textContent.trim() === '3D')
  btn.click()
  return 1
})()`)
await new Promise((r) => setTimeout(r, 300))

// 1. orbit handle exists and drags rotX/rotY (diagonal: dx=50 -> rotY≈20, dy=30 -> rotX≈-12)
const orbit = await rect('.anim-editor .orbit-handle')
check('orbit handle appears in 3D mode', !!orbit)
await drag(orbit.cx, orbit.cy, orbit.cx + 50, orbit.cy + 30)
const rot3d = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const c = st.project.tracks.find(t => t.name === 'V1').clips[0]
  const rel = st.playhead - c.start
  return {
    rotY: +ed.evalAnim(c.transform.rotY, rel).toFixed(1),
    rotX: +ed.evalAnim(c.transform.rotX, rel).toFixed(1)
  }
})()`)
check('orbit drag sets rotY≈+20 and rotX≈-12', Math.abs(rot3d.rotY - 20) < 3 && Math.abs(rot3d.rotX + 12) < 3,
  JSON.stringify(rot3d))

// 2. track motion stage: open via ✥ on V1
await evalJs(`(() => {
  const head = [...document.querySelectorAll('.track-head')]
    .find(h => h.querySelector('.track-name')?.textContent === 'V1')
  const btn = [...head.querySelectorAll('button')].find(b => b.textContent === '✥')
  btn.click()
  return 1
})()`)
await new Promise((r) => setTimeout(r, 500))
const stageThere = await evalJs(`!!document.querySelector('.anim-editor .motion-layer')`)
check('track motion editor has a stage with the track layer', stageThere)

// move — grab away from the center (the orbit handle lives there)
const layer = await rect('.motion-layer')
await drag(layer.cx + layer.w * 0.22, layer.cy + layer.h * 0.2,
  layer.cx + layer.w * 0.22 + 40, layer.cy + layer.h * 0.2 + 25)
const mv = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const m = st.project.tracks.find(t => t.name === 'V1').motion
  return { x: Math.round(ed.evalAnim(m.x, st.playhead)), y: Math.round(ed.evalAnim(m.y, st.playhead)) }
})()`)
check('stage drag moves the whole track', mv.x > 100 && mv.y > 60, JSON.stringify(mv))

// scale via corner
const corner = await rect('.motion-layer .scale-handle')
const s0 = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  return ed.evalAnim(st.project.tracks.find(t => t.name === 'V1').motion.scale, st.playhead)
})()`)
await drag(corner.cx, corner.cy, corner.cx - 30, corner.cy - 20)
const s1 = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  return ed.evalAnim(st.project.tracks.find(t => t.name === 'V1').motion.scale, st.playhead)
})()`)
check('corner drag scales the track', Math.abs(s1 - s0) > 0.05, `${s0.toFixed(2)} -> ${s1.toFixed(2)}`)

// 3D orbit on track (delta-based: +60px → +24°)
const ry0 = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  return ed.evalAnim(st.project.tracks.find(t => t.name === 'V1').motion.rotY, st.playhead)
})()`)
const morbit = await rect('.motion-layer .orbit-handle')
await drag(morbit.cx, morbit.cy, morbit.cx + 60, morbit.cy)
const mrot = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const m = st.project.tracks.find(t => t.name === 'V1').motion
  return +ed.evalAnim(m.rotY, st.playhead).toFixed(1)
})()`)
check('track orbit drag adds rotY≈+24', Math.abs(mrot - ry0 - 24) < 5, `rotY ${ry0} -> ${mrot}`)

// GPU sanity: zero the rotations, keep the x offset — lit area shifts right
const pix = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  const m = v1.motion
  st().updateTrack(v1.id, { motion: { ...m, rotX: { value: 0 }, rotY: { value: 0 }, rotation: { value: 0 }, scale: { value: 1 } } })
  await new Promise(r => setTimeout(r, 1200))
  const canvas = document.querySelector('.preview canvas')
  const off = document.createElement('canvas')
  off.width = canvas.width; off.height = canvas.height
  const ctx = off.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  const d = ctx.getImageData(0, 0, off.width, off.height).data
  let left = 0, right = 0
  const W = off.width, H = off.height
  for (let y = Math.floor(H*0.4); y < H*0.6; y += 5) {
    for (let x = 0; x < W; x += 7) {
      const i = (y * W + x) * 4
      const v = d[i] + d[i+1] + d[i+2]
      if (v > 25) { if (x < W/2) left++; else right++ }
    }
  }
  return { left, right }
})()`)
check('preview shows the track shifted right (more lit on the right half)', pix.right > pix.left,
  JSON.stringify(pix))

ws.close()
console.log('e2e11 finished')
