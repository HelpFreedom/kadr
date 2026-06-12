// Test the Vegas-style side-panel animation editor:
// tab opening on double-click, absolute vs linked (keyframe) gestures,
// stage drag/scale, mask handle drag, mini-timeline diamonds.
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
async function click(x, y) {
  await mouse('mousePressed', x, y)
  await mouse('mouseReleased', x, y)
}
async function drag(x0, y0, x1, y1) {
  await mouse('mousePressed', x0, y0)
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps)
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

// setup one clip
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  st().select([])
  st().setZoom(60)
  st().setPlayhead(1)
  return true
})()`)

// 1. double-click opens the Animation tab in the side panel
const clipR = await rect('.lane.video .clip')
await click(clipR.cx, clipR.cy)
await mouse('mousePressed', clipR.cx, clipR.cy, { clickCount: 2 })
await mouse('mouseReleased', clipR.cx, clipR.cy, { clickCount: 2 })
await new Promise((r) => setTimeout(r, 400))
const tabOpen = await evalJs(`(() => ({
  anim: !!document.querySelector('.anim-editor'),
  clip: window.kadrEditor.useEditor.getState().animClipId
}))()`)
check('double-click opens animation tab in side panel', tabOpen.anim && !!tabOpen.clip, JSON.stringify(tabOpen))

// 2. absolute (unlinked) drag of the layer moves x/y without keyframes
const layer = await rect('.anim-layer')
await drag(layer.cx, layer.cy, layer.cx + 30, layer.cy + 18)
const abs = await evalJs(`(() => {
  const ed = window.kadrEditor
  const c = ed.useEditor.getState().project.tracks.find(t=>t.name==='V1').clips[0]
  return { x: c.transform.x.value, y: c.transform.y.value,
           kfs: (c.transform.x.keyframes||[]).length }
})()`)
check('unlinked drag: absolute x/y, no keyframes', abs.x > 50 && abs.y > 30 && abs.kfs === 0, JSON.stringify(abs))

// 3. corner handle scales
const corner = await rect('.scale-handle')
const s0 = await evalJs(`window.kadrEditor.useEditor.getState().project.tracks.find(t=>t.name==='V1').clips[0].transform.scale.value`)
await drag(corner.cx, corner.cy, corner.cx - 25, corner.cy - 25)
const s1 = await evalJs(`window.kadrEditor.useEditor.getState().project.tracks.find(t=>t.name==='V1').clips[0].transform.scale.value`)
check('corner drag changes scale', Math.abs(s1 - s0) > 0.05, `${s0.toFixed(2)} -> ${s1.toFixed(2)}`)

// 4. linked mode: two gestures at different times -> keyframe chain
const link = await rect('.link-toggle')
await click(link.cx, link.cy)
await evalJs(`(() => { window.kadrEditor.useEditor.getState().setPlayhead(0.5); return 1 })()`)
await new Promise((r) => setTimeout(r, 200))
let l1 = await rect('.anim-layer')
await drag(l1.cx, l1.cy, l1.cx - 40, l1.cy)
await evalJs(`(() => { window.kadrEditor.useEditor.getState().setPlayhead(4.0); return 1 })()`)
await new Promise((r) => setTimeout(r, 200))
l1 = await rect('.anim-layer')
await drag(l1.cx, l1.cy, l1.cx + 80, l1.cy)
const chain = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t=>t.name==='V1').clips[0]
  const kfs = (c.transform.x.keyframes || []).map(k => [+k.time.toFixed(2), Math.round(k.value)])
  return kfs
})()`)
check('linked gestures chain into 2 keyframes (0.5s, 4s)',
  chain.length === 2 && Math.abs(chain[0][0] - 0.5) < 0.05 && Math.abs(chain[1][0] - 4) < 0.05,
  JSON.stringify(chain))

// 5. mini-timeline shows diamonds
const diamonds = await evalJs(`document.querySelectorAll('.mini-kf').length`)
check('mini-timeline shows keyframe diamonds', diamonds >= 2, 'diamonds=' + diamonds)

// 6. mask mode: drag left mask handle
await evalJs(`(() => {
  const btns = [...document.querySelectorAll('.anim-toolbar button')]
  btns[1].click() // Маска
  return 1
})()`)
await new Promise((r) => setTimeout(r, 250))
const mh = await rect('.mask-handle.h-left')
await drag(mh.cx, mh.cy, mh.cx + 30, mh.cy)
const mask = await evalJs(`(() => {
  const c = window.kadrEditor.useEditor.getState().project.tracks.find(t=>t.name==='V1').clips[0]
  return c.mask ? +(c.mask.left.keyframes ? -1 : c.mask.left.value).toFixed(3) : null
})()`)
check('mask-left handle drag sets static mask (link still per-gesture? linked=on -> kf ok too)',
  mask !== null, 'left=' + mask)

// 7. close tab returns to media
await evalJs(`(() => { document.querySelector('.tab-close').click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 250))
const closed = await evalJs(`(() => ({
  anim: !!document.querySelector('.anim-editor'),
  media: !!document.querySelector('.media-bin')
}))()`)
check('closing tab returns to media bin', !closed.anim && closed.media, JSON.stringify(closed))

ws.close()
console.log('e2e5 finished')
