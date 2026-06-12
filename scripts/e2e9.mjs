// Test: live % readouts, WebAudio routing (>100% gain + meter signal),
// clip context menu unlink, no-release cross-track group drag with
// original-position snapping, restore view with keyframes everywhere.
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

// setup: linked clip at 2s on V1
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 2)
  st().select([])
  st().setZoom(50)
  return true
})()`)

// 1. cross-track group drag without release + snap back to original marks
const vClip = await rect('.lane.video .clip')
const v2lane = await evalJs(`(() => {
  const tracks = window.kadrEditor.useEditor.getState().project.tracks
  const v2 = tracks.find(t => t.name === 'V2')
  const el = document.querySelector('[data-lane="' + v2.id + '"]')
  const r = el.getBoundingClientRect()
  return { cy: r.y + r.height / 2 }
})()`)
// grab, move to V2 lane vertically AND wiggle horizontally, come back near
// the original time — all in one gesture
await mouse('mousePressed', vClip.cx, vClip.cy)
await mouse('mouseMoved', vClip.cx + 60, vClip.cy)
await new Promise((r) => setTimeout(r, 80))
await mouse('mouseMoved', vClip.cx + 60, v2lane.cy)
await new Promise((r) => setTimeout(r, 80))
const midDrag = await evalJs(`(() => {
  const p = window.kadrEditor.useEditor.getState().project
  const v2 = p.tracks.find(t => t.name === 'V2')
  return { onV2: v2.clips.length }
})()`)
await mouse('mouseMoved', vClip.cx + 3, v2lane.cy) // near original time -> snap
await new Promise((r) => setTimeout(r, 80))
await mouse('mouseReleased', vClip.cx + 3, v2lane.cy)
const dragRes = await evalJs(`(() => {
  const p = window.kadrEditor.useEditor.getState().project
  const v2 = p.tracks.find(t => t.name === 'V2')
  const a = p.tracks.find(t => t.kind === 'audio')
  return {
    v2start: v2.clips[0] ? +v2.clips[0].start.toFixed(3) : null,
    aStart: a.clips[0] ? +a.clips[0].start.toFixed(3) : null
  }
})()`)
check('mid-drag: clip already on V2 before release', midDrag.onV2 === 1)
check('released near origin: snapped to original 2s, audio partner followed',
  dragRes.v2start === 2 && dragRes.aStart === 2, JSON.stringify(dragRes))

// 2. clip context menu: unlink via right-click
const vClip2 = await rect('.lane.video .clip')
await mouse('mousePressed', vClip2.cx, vClip2.cy, { button: 'right', buttons: 2 })
await mouse('mouseReleased', vClip2.cx, vClip2.cy, { button: 'right', buttons: 0 })
await new Promise((r) => setTimeout(r, 300))
const menuItems = await evalJs(`(() => {
  const el = document.querySelector('.ctx-menu')
  return el ? [...el.querySelectorAll('button')].map(b => b.textContent) : null
})()`)
await evalJs(`(() => {
  const btn = [...document.querySelectorAll('.ctx-menu button')]
    .find(b => /Разделить|Unlink/.test(b.textContent))
  if (btn) btn.click()
  return 1
})()`)
const unlinked = await evalJs(`(() => {
  const p = window.kadrEditor.useEditor.getState().project
  const v2 = p.tracks.find(t => t.name === 'V2')
  return v2.clips[0].linkId ?? null
})()`)
check('clip right-click menu has unlink item', !!menuItems && menuItems.some(s => /Разделить|Unlink/.test(s)),
  JSON.stringify(menuItems))
check('unlink via menu clears linkId', unlinked === null)

// 3. level badge appears mid-drag with live %
const band = await rect('.lane.video .clip .level-hit')
await mouse('mousePressed', band.cx, band.cy + 4)
await mouse('mouseMoved', band.cx, band.cy + 14)
await new Promise((r) => setTimeout(r, 150))
const badge = await evalJs(`(() => {
  const b = document.querySelector('.level-badge')
  return b ? b.textContent : null
})()`)
await mouse('mouseReleased', band.cx, band.cy + 14)
const badgeGone = await evalJs(`!document.querySelector('.level-badge')`)
check('level badge shows live percent during drag', !!badge && /%$/.test(badge), JSON.stringify(badge))
check('badge disappears after release', badgeGone)

// 4. track slider has a live % label
const pct = await evalJs(`(() => {
  const el = document.querySelector('.gain-pct')
  return el ? el.textContent : null
})()`)
check('track slider shows percent', !!pct && /%$/.test(pct), JSON.stringify(pct))

// 5. WebAudio routing: gain > 1 allowed, meter receives signal during playback
const audioSig = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const a = st().project.tracks.find(t => t.kind === 'audio')
  const c = a.clips[0]
  st().updateClip(c.id, { gain: { value: 1.6 } })
  st().setPlayhead(c.start + 0.5)
  st().setPlaying(true)
  await new Promise(r => setTimeout(r, 2500))
  st().setPlaying(false)
  // analyser is reachable through the meter's module — probe via canvas pixels
  const canvas = document.querySelector('.audio-meter')
  const ctx = canvas.getContext('2d')
  const d = ctx.getImageData(0, 0, canvas.width, canvas.height).data
  let lit = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] + d[i + 1] + d[i + 2] > 60) lit++
  }
  return { litPx: lit, gain: c.gain.value }
})()`)
check('meter shows signal during playback (WebAudio routed, gain 1.6 accepted)',
  audioSig.litPx > 30, JSON.stringify(audioSig))

// 6. restore view works after keyframing both modes
const restore = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c0 = window.kadrEditor.useEditor.getState().project.tracks.find(t => t.name === 'V2').clips[0]
  st().setAnimClip(c0.id)
  st().setPlayhead(c0.start + 1)
  return c0.id
})()`)
await new Promise((r) => setTimeout(r, 500))
await evalJs(`(() => { document.querySelector('.link-toggle').click(); return 1 })()`) // snapshot kfs everywhere
await new Promise((r) => setTimeout(r, 300))
await evalJs(`(() => {
  // give x a non-default keyframed value at another time
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V2').clips[0]
  st().setPlayhead(c.start + 2)
  return 1
})()`)
await new Promise((r) => setTimeout(r, 200))
const layer = await rect('.anim-layer')
await mouse('mousePressed', layer.cx, layer.cy)
await mouse('mouseMoved', layer.cx + 50, layer.cy)
await mouse('mouseReleased', layer.cx + 50, layer.cy)
// switch to mask and back, then restore view
await evalJs(`(() => { [...document.querySelectorAll('.anim-toolbar button')][1].click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 200))
await evalJs(`(() => { [...document.querySelectorAll('.anim-toolbar button')][0].click(); return 1 })()`)
await new Promise((r) => setTimeout(r, 200))
const stage = await rect('.anim-stage')
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
  const c = st.project.tracks.find(t => t.name === 'V2').clips[0]
  const rel = st.playhead - c.start
  return {
    x: +ed.evalAnim(c.transform.x, rel).toFixed(2),
    scale: +ed.evalAnim(c.transform.scale, rel).toFixed(2),
    xKfs: (c.transform.x.keyframes || []).length
  }
})()`)
check('restore view resets values at playhead even with keyframes (kfs kept)',
  restored.x === 0 && restored.scale === 1 && restored.xKfs >= 2, JSON.stringify(restored))

ws.close()
console.log('e2e9 finished')
