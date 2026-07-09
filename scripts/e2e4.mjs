// Test: ctrl multi-select, click→playhead, fade-handle drag (real mouse),
// group move, mask via GPU pixels, keyframed scale, frame counter.
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
async function evalJs(expression, { timeout = 300000 } = {}) {
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
async function drag(x0, y0, x1, y1, mods = 0) {
  await mouse('mousePressed', x0, y0, { modifiers: mods })
  const steps = 8
  for (let i = 1; i <= steps; i++) {
    await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, { modifiers: mods })
    await new Promise((r) => setTimeout(r, 30))
  }
  await mouse('mouseReleased', x1, y1, { modifiers: mods })
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

// setup: two clips on V1
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  st().insertClipFromAsset(idA, v1.id, 8)
  st().select([])
  st().setZoom(50)
  return true
})()`)

// geometry of the two clips
const geo = await evalJs(`(() => {
  const els = [...document.querySelectorAll('.lane.video .clip')]
  return els.map(el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height } })
})()`)

// 1. ctrl+click multi-select
await mouse('mousePressed', geo[0].x + 40, geo[0].y + geo[0].h / 2)
await mouse('mouseReleased', geo[0].x + 40, geo[0].y + geo[0].h / 2)
await mouse('mousePressed', geo[1].x + 40, geo[1].y + geo[1].h / 2, { modifiers: 2 }) // ctrl
await mouse('mouseReleased', geo[1].x + 40, geo[1].y + geo[1].h / 2, { modifiers: 2 })
const sel = await evalJs(`window.kadrEditor.useEditor.getState().selection.length`)
// a.mp4 carries audio, so each video clip selects together with its linked
// audio twin — 2 clicks → 4 selected (behavior since the AV-link feature)
check('Ctrl+click selects two clips (+ linked audio twins)', sel === 4, 'selected=' + sel)

// 2. click on clip parks the playhead there (clicked first clip at +40px, zoom 50 → 0.8s)
const ph = await evalJs(`window.kadrEditor.useEditor.getState().playhead`)
check('click on clip moved playhead to ~0.8s', Math.abs(ph - 0.8) < 0.15, 'playhead=' + ph.toFixed(3))

// 3. group move: drag first clip right by 100px (2s) — both selected clips shift
const starts0 = await evalJs(`window.kadrEditor.useEditor.getState().project.tracks.find(t=>t.name==='V1').clips.map(c=>c.start)`)
await drag(geo[0].x + 60, geo[0].y + geo[0].h / 2, geo[0].x + 60 + 100, geo[0].y + geo[0].h / 2)
const starts1 = await evalJs(`window.kadrEditor.useEditor.getState().project.tracks.find(t=>t.name==='V1').clips.map(c=>c.start)`)
const d0 = starts1[0] - starts0[0]
const d1 = starts1[1] - starts0[1]
check('group move shifts both clips equally ~2s', Math.abs(d0 - d1) < 0.01 && d0 > 1.5, JSON.stringify({ starts0, starts1 }))

// 4. fade handle drag with real mouse on the first clip
await evalJs(`(() => { const s = window.kadrEditor.useEditor.getState(); s.select([]); return true })()`)
const clipRect = await evalJs(`(() => {
  const el = document.querySelector('.lane.video .clip')
  const h = el.querySelector('.fade-handle.left').getBoundingClientRect()
  return { hx: h.x + h.width / 2, hy: h.y + h.height / 2 }
})()`)
await drag(clipRect.hx, clipRect.hy, clipRect.hx + 75, clipRect.hy) // 75px @ zoom 50 = 1.5s
const fadeIn = await evalJs(`window.kadrEditor.useEditor.getState().project.tracks.find(t=>t.name==='V1').clips[0].fadeIn`)
check('fade-in handle drag sets ~1.5s', Math.abs(fadeIn - 1.5) < 0.3, 'fadeIn=' + fadeIn)

// 5. mask via GPU: cut right half of the only visible layer, compare halves
const maskPix = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const clip = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(clip.id, { mask: { left: {value:0}, top: {value:0}, right: {value:0.5}, bottom: {value:0} },
                             fadeIn: 0 })
  st().setPlayhead(clip.start + 1)
  await new Promise(r => setTimeout(r, 2200))
  const canvas = document.querySelector('.preview canvas')
  const off = document.createElement('canvas')
  off.width = canvas.width; off.height = canvas.height
  const ctx = off.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  const d = ctx.getImageData(0, 0, off.width, off.height).data
  let left = 0, right = 0
  const W = off.width, H = off.height
  for (let y = Math.floor(H*0.3); y < H*0.7; y += 7) {
    for (let x = 0; x < W; x += 11) {
      const i = (y * W + x) * 4
      const v = d[i] + d[i+1] + d[i+2]
      if (x < W * 0.45) left += v; else if (x > W * 0.55) right += v
    }
  }
  return { left, right }
})()`)
check('mask right=0.5 blanks the right half on GPU', maskPix.left > 5000 && maskPix.right < maskPix.left * 0.05,
  JSON.stringify(maskPix))

// 6. keyframed scale animates over time
const kf = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const clip = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(clip.id, {
    mask: { left:{value:0}, top:{value:0}, right:{value:0}, bottom:{value:0} },
    transform: { ...clip.transform, scale: { value: 1, keyframes: [
      { time: 0, value: 0.2, easing: 'linear' },
      { time: 4, value: 1.0, easing: 'linear' }
    ] } }
  })
  return true
})()`)
const scalePix = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const clip = st().project.tracks.find(t => t.name === 'V1').clips[0]
  const probe = async (tt) => {
    st().setPlayhead(clip.start + tt)
    await new Promise(r => setTimeout(r, 1800))
    const canvas = document.querySelector('.preview canvas')
    const off = document.createElement('canvas')
    off.width = canvas.width; off.height = canvas.height
    const ctx = off.getContext('2d')
    ctx.drawImage(canvas, 0, 0)
    const d = ctx.getImageData(0, 0, off.width, off.height).data
    let lit = 0
    for (let i = 0; i < d.length; i += 4 * 997) {
      if (d[i] + d[i+1] + d[i+2] > 30) lit++
    }
    return lit
  }
  const small = await probe(0.2)
  const big = await probe(3.9)
  return { small, big }
})()`)
check('scale keyframes: frame coverage grows 0.2s → 3.9s', scalePix.big > scalePix.small * 2,
  JSON.stringify(scalePix))

// 7. frame counter is rendered
const fc = await evalJs(`(() => {
  const el = document.querySelector('.frame-counter')
  return el ? el.textContent : null
})()`)
check('frame counter visible in transport', !!fc && /\d+/.test(fc), JSON.stringify(fc))

ws.close()
console.log('e2e4 finished')
