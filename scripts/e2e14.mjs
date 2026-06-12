// Test: AE-style edge (tip) transitions — junction badge on butt joints,
// clip tip corners, viewport-clamped menus, GPU effect actually changes
// the frame on both sides of the cut.
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

// setup: a.mp4 trimmed to 0..3 and b.mp4 at 3 on V1 — a butt joint at t=3
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const a = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const b = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idA = ed.uid(), idB = ed.uid()
  st().addAsset({ id: idA, ...a.asset })
  st().addAsset({ id: idB, ...b.asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  const clipA = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().trimClip(clipA.id, 'out', 3)
  st().insertClipFromAsset(idB, v1.id, 3)
  st().select([])
  st().setPlayhead(2.9)
  return true
})()`)

await evalJs(`(() => {
  window.__samp = (xs, y) => {
    const canvas = document.querySelector('.preview canvas')
    const off = document.createElement('canvas')
    off.width = canvas.width; off.height = canvas.height
    const ctx = off.getContext('2d')
    ctx.drawImage(canvas, 0, 0)
    const img = ctx.getImageData(0, 0, off.width, off.height).data
    return xs.map((fx) => {
      const x = Math.round(fx * off.width)
      const yy = Math.round(y * off.height)
      const i = (yy * off.width + x) * 4
      return [img[i], img[i + 1], img[i + 2]]
    })
  }
  return 1
})()`)
const XS = JSON.stringify([0.08, 0.2, 0.32, 0.44, 0.56, 0.68, 0.8, 0.92])
const diff = (a, b) =>
  a.reduce((s, p, i) => s + Math.abs(p[0] - b[i][0]) + Math.abs(p[1] - b[i][1]) + Math.abs(p[2] - b[i][2]), 0) /
  (a.length * 3)
const grabAt = (tt) => evalJs(`(async () => {
  window.kadrEditor.useEditor.getState().setPlayhead(${tt})
  await new Promise(r => setTimeout(r, 1600))
  return window.__samp(${XS}, 0.35)
})()`)

// 1. junction badge sits at the cut; clip tips are on both clips
const dom = await evalJs(`(() => {
  const zoom = window.kadrEditor.useEditor.getState().zoom
  const j = document.querySelector('.junction-badge')
  return {
    joint: j ? Math.round(parseFloat(j.style.left) / zoom * 100) / 100 : null,
    tips: document.querySelectorAll('.clip-tip').length
  }
})()`)
check('junction badge at t=3, four clip tips', dom.joint === 3 && dom.tips === 4, JSON.stringify(dom))

// 2. junction menu opens fully inside the viewport, picks blur zoom in
const pick = await evalJs(`(async () => {
  document.querySelector('.junction-badge').click()
  await new Promise(r => setTimeout(r, 200))
  const m = document.querySelector('.ctx-menu.trans-menu')
  if (!m) return { open: false }
  const r = m.getBoundingClientRect()
  const fits = r.top >= 0 && r.bottom <= window.innerHeight + 0.5
  const btn = [...m.querySelectorAll('button')].find(b => /наезд|Blur zoom · in/.test(b.textContent))
  btn.click()
  await new Promise(r => setTimeout(r, 200))
  return { open: true, fits, vh: window.innerHeight, bottom: Math.round(r.bottom) }
})()`)
const stored = await evalJs(`(() => {
  const st = window.kadrEditor.useEditor.getState()
  const v1 = st.project.tracks.find(t => t.name === 'V1')
  const cs = [...v1.clips].sort((x, y) => x.start - y.start)
  return {
    aOut: cs[0].transitionOut, bIn: cs[1].transitionIn,
    undo: st.past[st.past.length - 1]?.label
  }
})()`)
check('junction menu fits viewport and sets both tips',
  pick.open && pick.fits &&
  stored.aOut?.type === 'blurZoomIn' && stored.aOut?.duration === 0.5 &&
  stored.bIn?.type === 'blurZoomIn' && stored.undo === 'hTransition',
  JSON.stringify({ pick, stored }))

// 3. the effect really alters frames on both sides of the cut
const fOut = await grabAt(2.9)   // tail of A, phase 0.4
const fIn = await grabAt(3.1)    // head of B, phase 0.6
await evalJs(`(() => {
  const st = window.kadrEditor.useEditor.getState()
  const v1 = st.project.tracks.find(t => t.name === 'V1')
  const cs = [...v1.clips].sort((x, y) => x.start - y.start)
  st.setEdgeTransitions([
    { clipId: cs[0].id, edge: 'out', type: null },
    { clipId: cs[1].id, edge: 'in', type: null }
  ])
  return 1
})()`)
const gOut = await grabAt(2.9)
const gIn = await grabAt(3.1)
const dOut = diff(fOut, gOut)
const dIn = diff(fIn, gIn)
check('blur zoom changes the A tail and the B head',
  dOut > 12 && dIn > 12, `out ${dOut.toFixed(1)} in ${dIn.toFixed(1)}`)

// 4. clip tip corner opens the per-clip menu; flash lands on the out tip
const tipRes = await evalJs(`(async () => {
  const clips = [...document.querySelectorAll('.clip')]
  const bEl = clips.find(c => c.textContent.includes('b.mp4'))
  bEl.querySelector('.clip-tip.right').click()
  await new Promise(r => setTimeout(r, 200))
  const m = document.querySelector('.ctx-menu.trans-menu')
  if (!m) return { open: false }
  const r = m.getBoundingClientRect()
  const fits = r.top >= 0 && r.bottom <= window.innerHeight + 0.5
  const title = m.querySelector('.ctx-title')?.textContent
  const btn = [...m.querySelectorAll('button')].find(b => /Засветка|Flash/.test(b.textContent))
  btn.click()
  await new Promise(r => setTimeout(r, 200))
  return { open: true, fits, title }
})()`)
const tipStored = await evalJs(`(() => {
  const st = window.kadrEditor.useEditor.getState()
  const v1 = st.project.tracks.find(t => t.name === 'V1')
  const cs = [...v1.clips].sort((x, y) => x.start - y.start)
  return { type: cs[1].transitionOut?.type, dur: cs[1].transitionOut?.duration }
})()`)
check('clip tip menu sets a flash out-transition',
  tipRes.open && tipRes.fits && tipStored.type === 'flash' && tipStored.dur === 0.5,
  JSON.stringify({ tipRes, tipStored }))

// 5. duration row re-times the existing tip
await evalJs(`(async () => {
  const clips = [...document.querySelectorAll('.clip')]
  const bEl = clips.find(c => c.textContent.includes('b.mp4'))
  bEl.querySelector('.clip-tip.right').click()
  await new Promise(r => setTimeout(r, 200))
  const m = document.querySelector('.ctx-menu.trans-menu')
  const btn = [...m.querySelectorAll('.ctx-dur-row button')].find(b => b.textContent === '1s')
  btn.click()
  await new Promise(r => setTimeout(r, 200))
  return 1
})()`)
const retimed = await evalJs(`(() => {
  const st = window.kadrEditor.useEditor.getState()
  const v1 = st.project.tracks.find(t => t.name === 'V1')
  const cs = [...v1.clips].sort((x, y) => x.start - y.start)
  const strip = document.querySelectorAll('.tip-strip').length
  return { type: cs[1].transitionOut?.type, dur: cs[1].transitionOut?.duration, strips: strip }
})()`)
check('duration row sets 1s, tip strip drawn',
  retimed.type === 'flash' && retimed.dur === 1 && retimed.strips >= 1,
  JSON.stringify(retimed))

// 6. real mouse click near the screen bottom — the menu must clamp upward
const badge = await evalJs(`(() => {
  const b = document.querySelector('.junction-badge')
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, vh: window.innerHeight }
})()`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(badge.x), y: Math.round(badge.y), button: 'left', clickCount: 1, buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(badge.x), y: Math.round(badge.y), button: 'left', clickCount: 1, buttons: 0 })
await new Promise((r) => setTimeout(r, 400))
const clamp = await evalJs(`(() => {
  const m = document.querySelector('.ctx-menu.trans-menu')
  if (!m) return { open: false }
  const r = m.getBoundingClientRect()
  return { open: true, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height) }
})()`)
check('menu opened at the bottom edge is clamped into the viewport',
  clamp.open && badge.y > badge.vh - 300 && clamp.top >= 0 && clamp.bottom <= badge.vh &&
  badge.y + clamp.h > badge.vh,
  JSON.stringify({ badge: { y: Math.round(badge.y), vh: badge.vh }, clamp }))

ws.close()
console.log('e2e14 finished')
