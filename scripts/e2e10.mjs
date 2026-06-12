// Test: snap chooser fix (other-track video + playhead), click-parks vs
// drag-keeps playhead, linked extend/speed sync, 3D transform on GPU,
// track motion editor and rendering.
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

// setup: linked pair at 2s (V1) and at 9s (V2)
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  const v2 = st().project.tracks.find(t => t.name === 'V2')
  st().insertClipFromAsset(idA, v1.id, 2)
  st().insertClipFromAsset(idA, v2.id, 9)
  st().select([])
  st().setZoom(50)
  st().setPlayhead(0)
  return true
})()`)

// 1. snap to other-track video clip edge (V1 ends at 8.024)
const v2r = await evalJs(`(() => {
  const el = [...document.querySelectorAll('.lane.video .clip')].find(c => c.getBoundingClientRect().x > 500)
  const r = el.getBoundingClientRect()
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
})()`)
await drag(v2r.cx, v2r.cy, v2r.cx - 42, v2r.cy)
const snapA = await evalJs(`window.kadrEditor.useEditor.getState().project.tracks.find(t=>t.name==='V2').clips[0].start`)
check('video↔video other-track snap (start lands exactly on 8.024)', Math.abs(snapA - 8.024) < 1e-6, 'start=' + snapA)

// 2. snap to the red playhead cursor + click-vs-drag parking
await evalJs(`(() => { window.kadrEditor.useEditor.getState().setPlayhead(12); return 1 })()`)
const v2r2 = await evalJs(`(() => {
  const el = [...document.querySelectorAll('.lane.video .clip')].find(c => c.getBoundingClientRect().x > 350)
  const r = el.getBoundingClientRect()
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
})()`)
// drag right so the start approaches 12: from 8.024 need +3.976s = ~199px; do 195px → 11.92 (within 0.2 tol)
await drag(v2r2.cx, v2r2.cy, v2r2.cx + 195, v2r2.cy)
const snapPh = await evalJs(`(() => {
  const st = window.kadrEditor.useEditor.getState()
  return { start: st.project.tracks.find(t=>t.name==='V2').clips[0].start, ph: st.playhead }
})()`)
check('clip start snaps to the red playhead at 12, cursor stayed put',
  Math.abs(snapPh.start - 12) < 1e-6 && Math.abs(snapPh.ph - 12) < 1e-6, JSON.stringify(snapPh))

// plain click parks the playhead
const v2r3 = await evalJs(`(() => {
  const el = [...document.querySelectorAll('.lane.video .clip')].find(c => c.getBoundingClientRect().x > 350)
  const r = el.getBoundingClientRect()
  return { x: r.x, cx: r.x + 25, cy: r.y + r.height / 2 }
})()`)
await mouse('mousePressed', v2r3.cx, v2r3.cy)
await mouse('mouseReleased', v2r3.cx, v2r3.cy)
const parked = await evalJs(`window.kadrEditor.useEditor.getState().playhead`)
check('plain click parks the playhead inside the clip (~12.5s)', Math.abs(parked - 12.5) < 0.15, 'ph=' + parked)

// 3. linked extend + speed sync (store level, what the handles call)
const linkSync = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const v = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().setClipDuration(v.id, 4)
  const afterDur = (() => {
    const p = st().project
    return {
      v: +p.tracks.find(t => t.name === 'V1').clips[0].duration.toFixed(2),
      a: +p.tracks.find(t => t.kind === 'audio').clips.find(c => c.linkId === v.linkId).duration.toFixed(2)
    }
  })()
  st().setClipSpeed(v.id, 2, 4 * 6.024 / 6.024 / 2)
  const p2 = st().project
  const afterSpeed = {
    v: p2.tracks.find(t => t.name === 'V1').clips[0].speed,
    a: p2.tracks.find(t => t.kind === 'audio').clips.find(c => c.linkId === v.linkId).speed
  }
  return { afterDur, afterSpeed }
})()`)
check('extend syncs linked audio (both 4s)', linkSync.afterDur.v === 4 && linkSync.afterDur.a === 4,
  JSON.stringify(linkSync.afterDur))
check('speed syncs linked audio (both ×2)', linkSync.afterSpeed.v === 2 && linkSync.afterSpeed.a === 2,
  JSON.stringify(linkSync.afterSpeed))

// 4. 3D: rotY narrows the rendered layer on the GPU
const w3d = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  // isolate: keep only the V1 clip visible
  const v2 = st().project.tracks.find(t => t.name === 'V2')
  st().updateTrack(v2.id, { muted: true })
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().setPlayhead(c.start + 1)
  const measure = async () => {
    await new Promise(r => setTimeout(r, 1500))
    const canvas = document.querySelector('.preview canvas')
    const off = document.createElement('canvas')
    off.width = canvas.width; off.height = canvas.height
    const ctx = off.getContext('2d')
    ctx.drawImage(canvas, 0, 0)
    const d = ctx.getImageData(0, 0, off.width, off.height).data
    const y = Math.floor(off.height / 2)
    let minX = off.width, maxX = 0
    for (let x = 0; x < off.width; x++) {
      const i = (y * off.width + x) * 4
      if (d[i] + d[i+1] + d[i+2] > 25) { minX = Math.min(minX, x); maxX = Math.max(maxX, x) }
    }
    return maxX - minX
  }
  const flat = await measure()
  st().updateClip(c.id, { transform: { ...c.transform, rotX: {value:0}, rotY: {value:60}, z: {value:0} } })
  const tilted = await measure()
  return { flat, tilted }
})()`)
check('3D rotY=60° narrows the layer in GPU preview', w3d.tilted < w3d.flat * 0.75, JSON.stringify(w3d))

// 5. track motion: scale 0.5 shrinks; editor opens via ✥; keyframes work
const motion = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, { transform: { ...c.transform, rotY: {value:0} } })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  const A = v => ({ value: v })
  st().updateTrack(v1.id, { motion: {
    x: A(0), y: A(0), scale: { value: 1, keyframes: [
      { time: 0, value: 1, easing: 'linear' }, { time: 4, value: 0.4, easing: 'linear' }
    ] },
    rotation: A(0), rotX: A(0), rotY: A(0), z: A(0)
  } })
  const measure = async () => {
    await new Promise(r => setTimeout(r, 1200))
    const canvas = document.querySelector('.preview canvas')
    const off = document.createElement('canvas')
    off.width = canvas.width; off.height = canvas.height
    const ctx = off.getContext('2d')
    ctx.drawImage(canvas, 0, 0)
    const d = ctx.getImageData(0, 0, off.width, off.height).data
    let lit = 0
    for (let i = 0; i < d.length; i += 4 * 499) if (d[i] + d[i+1] + d[i+2] > 25) lit++
    return lit
  }
  st().setPlayhead(c.start + 0.1)
  const early = await measure()
  st().setPlayhead(c.start + 1.9)
  const late = await measure()
  return { early, late }
})()`)
check('track motion scale keyframes shrink the whole track over time',
  motion.late < motion.early * 0.7, JSON.stringify(motion))

// editor UI via the V1 row's ✥ button (V1 is the track with motion keyframes)
await evalJs(`(() => {
  const head = [...document.querySelectorAll('.track-head')]
    .find(h => h.querySelector('.track-name')?.textContent === 'V1')
  const btn = [...head.querySelectorAll('button')].find(b => b.textContent === '✥')
  btn.click()
  return 1
})()`)
await new Promise((r) => setTimeout(r, 400))
const motionUI = await evalJs(`(() => ({
  editor: !!document.querySelector('.motion-title'),
  diamonds: document.querySelectorAll('.anim-editor .mini-kf').length,
  values: document.querySelectorAll('.anim-editor .anim-values input').length
}))()`)
check('track motion editor opens with keyframes and 7 value fields',
  motionUI.editor && motionUI.diamonds >= 2 && motionUI.values === 7, JSON.stringify(motionUI))

ws.close()
console.log('e2e10 finished')
