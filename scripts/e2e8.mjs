// Test: reversed parabola, auto-keyframe states, restore-view keeps kfs,
// frame-0 keyframes, snap/lockX/lockY toggles, clip level bands, track gain,
// end thumbnails.
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

// 1. reversed parabola: long acceleration, short brake
const easing = await evalJs(`(() => {
  const ev = window.kadrEditor.evalAnim
  const sm = { value: 0, smooth: true, keyframes: [
    { time: 0, value: 0, easing: 'linear' }, { time: 1, value: 100, easing: 'linear' }] }
  return { q1: +ev(sm, 0.25).toFixed(1), q3: +ev(sm, 0.75).toFixed(1) }
})()`)
check('parabola: long build-up (q1<10), short settle (q3<85)', easing.q1 < 10 && easing.q3 < 85 && easing.q3 > 60,
  JSON.stringify(easing))

// setup
const setup = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  st().setZoom(50)
  return { thumbEnd: !!asset.thumbnailEnd }
})()`)
check('probe produces an end thumbnail', setup.thumbEnd)

// 2. clip shows start and end thumbnails
await new Promise((r) => setTimeout(r, 500))
const thumbs = await evalJs(`document.querySelectorAll('.lane.video .clip .clip-thumb').length`)
check('clip has 2 thumbnails (start+end)', thumbs === 2, 'imgs=' + thumbs)

// 3. auto-keyframe: param with kfs gets a new state instead of shifting the chain
const auto = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, { transform: { ...c.transform, x: { value: 0, keyframes: [
    { time: 0, value: 0, easing: 'linear' }, { time: 4, value: 200, easing: 'linear' }
  ] } } })
  st().setAnimClip(c.id)
  st().setPlayhead(c.start + 2)
  return 1
})()`)
await new Promise((r) => setTimeout(r, 600))
const layer = await rect('.anim-layer')
await drag(layer.cx, layer.cy, layer.cx + 40, layer.cy)
const autoKf = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t => t.name === 'V1').clips[0]
  const kfs = c.transform.x.keyframes.map(k => [+k.time.toFixed(2), Math.round(k.value)])
  return kfs
})()`)
check('editing a keyframed param adds a state at the playhead (3 kfs, ends intact)',
  autoKf.length === 3 && autoKf[0][1] === 0 && autoKf[2][1] === 200 && autoKf[1][0] === 2,
  JSON.stringify(autoKf))

// 4. Restore view keeps keyframes (x stays animated, scale resets)
await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, { transform: { ...c.transform, scale: { value: 1.7 } } })
  return 1
})()`)
const stage = await rect('.anim-stage')
await mouse('mousePressed', stage.cx, stage.cy, { button: 'right', buttons: 2 })
await mouse('mouseReleased', stage.cx, stage.cy, { button: 'right', buttons: 0 })
await new Promise((r) => setTimeout(r, 250))
await evalJs(`(() => { [...document.querySelectorAll('.ctx-menu button')][0].click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 250))
const restored = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t => t.name === 'V1').clips[0]
  return { xKfs: (c.transform.x.keyframes || []).length, scale: c.transform.scale.value }
})()`)
check('Restore view: keyframed x kept (3 kfs), static scale reset to 1',
  restored.xKfs === 3 && restored.scale === 1, JSON.stringify(restored))

// 5. frame-0 keyframe via link toggle at clip start
const frame0 = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().setPlayhead(c.start)
  return 1
})()`)
await new Promise((r) => setTimeout(r, 300))
await evalJs(`(() => { document.querySelector('.link-toggle').click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 300))
const kf0 = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t => t.name === 'V1').clips[0]
  const rot = c.transform.rotation.keyframes
  return rot ? rot.map(k => k.time) : null
})()`)
check('link toggle at clip start snapshots keyframes at exactly t=0',
  !!kf0 && kf0.length === 1 && kf0[0] === 0, JSON.stringify(kf0))

// 6. lockX: drag moves only Y
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.anim-toolbar button')]
  const lockBtn = btns.find(b => b.textContent.trim() === 'X')
  lockBtn.click()
  return 1
})()`)
await new Promise((r) => setTimeout(r, 200))
const before = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const c = st.project.tracks.find(t => t.name === 'V1').clips[0]
  const rel = st.playhead - c.start
  return { x: ed.evalAnim(c.transform.x, rel), y: ed.evalAnim(c.transform.y, rel) }
})()`)
const layer2 = await rect('.anim-layer')
await drag(layer2.cx, layer2.cy, layer2.cx + 60, layer2.cy + 50)
const after = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const c = st.project.tracks.find(t => t.name === 'V1').clips[0]
  const rel = st.playhead - c.start
  return { x: ed.evalAnim(c.transform.x, rel), y: ed.evalAnim(c.transform.y, rel) }
})()`)
check('lock X: drag changes only Y', Math.abs(after.x - before.x) < 0.01 && Math.abs(after.y - before.y) > 20,
  JSON.stringify({ before, after }))

// 7. snap toggle off: tiny offset stays (no snap back to 0)
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.anim-toolbar button')]
  btns.find(b => b.textContent.includes('🔒X')).click() // unlock X
  btns.find(b => b.textContent.includes('🧲')).click()  // snap off
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  // reset x to static 0 for a clean check
  st().updateClip(c.id, { transform: { ...c.transform, x: { value: 0 }, y: { value: 0 } } })
  return 1
})()`)
await new Promise((r) => setTimeout(r, 300))
const layer3 = await rect('.anim-layer')
await drag(layer3.cx, layer3.cy, layer3.cx + 4, layer3.cy)
const noSnap = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const c = st.project.tracks.find(t => t.name === 'V1').clips[0]
  return ed.evalAnim(c.transform.x, st.playhead - c.start)
})()`)
check('snap off: small drag is not snapped back to 0', Math.abs(noSnap) > 5, 'x=' + noSnap)

// 8. clip level band drags opacity down (video)
await evalJs(`(() => { window.kadrEditor.useEditor.getState().setAnimClip(null); return 1 })()`)
await new Promise((r) => setTimeout(r, 300))
const band = await rect('.lane.video .clip .level-hit')
await drag(band.cx, band.cy + 4, band.cx, band.cy + 18)
const opacity = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t => t.name === 'V1').clips[0]
  return +c.transform.opacity.value.toFixed(2)
})()`)
check('video level band lowers opacity', opacity < 0.9 && opacity > 0, 'opacity=' + opacity)

// 9. audio clip band + track gain slider
const aband = await rect('.lane.audio .clip .level-hit')
await drag(aband.cx, aband.cy + 4, aband.cx, aband.cy + 12)
const gain = await evalJs(`(() => {
  const p = window.kadrEditor.useEditor.getState().project
  return +p.tracks.find(t => t.kind === 'audio').clips[0].gain.value.toFixed(2)
})()`)
check('audio level band lowers gain', gain < 1, 'gain=' + gain)

const trackSliders = await evalJs(`document.querySelectorAll('.track-gain').length`)
const trackGain = await evalJs(`(() => {
  const inp = document.querySelector('.track-gain')
  if (!inp) return null
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  nativeInputValueSetter.call(inp, '0.4')
  inp.dispatchEvent(new Event('input', { bubbles: true }))
  inp.dispatchEvent(new Event('change', { bubbles: true }))
  const p = window.kadrEditor.useEditor.getState().project
  return p.tracks[0].gain
})()`)
check('every track has a gain/opacity slider', trackSliders >= 3, 'sliders=' + trackSliders)
check('track slider writes track gain', trackGain === 0.4, 'gain=' + trackGain)

ws.close()
console.log('e2e8 finished')
