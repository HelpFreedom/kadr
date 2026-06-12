// Test: Vegas-style transitions on clip overlap — default crossfade blends,
// wipeRight reveals halves, the timeline shows zones, the badge menu picks
// the effect, 'none' falls back to a hard cut.
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

// setup: a.mp4 (testsrc2, 6s) at 0 and b.mp4 (smptebars, 4s) at 4 on V1 —
// the overlap 4..6 becomes the transition
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
  st().insertClipFromAsset(idB, v1.id, 4)
  st().select([])
  st().setPlayhead(5)
  return true
})()`)

// pixel sampling helper parked on window
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

const XS_L = [0.06, 0.16, 0.26, 0.36, 0.46]
const XS_R = [0.56, 0.66, 0.76, 0.86, 0.94]
const XS = JSON.stringify([...XS_L, ...XS_R])
const diff = (a, b) =>
  a.reduce((s, p, i) => s + Math.abs(p[0] - b[i][0]) + Math.abs(p[1] - b[i][1]) + Math.abs(p[2] - b[i][2]), 0) /
  (a.length * 3)

const setTrans = (type) => evalJs(`(() => {
  const st = window.kadrEditor.useEditor.getState()
  const v1 = st.project.tracks.find(t => t.name === 'V1')
  const b = [...v1.clips].sort((x, y) => x.start - y.start)[1]
  st.setTransition(b.id, ${JSON.stringify(type)})
  return st.project.tracks.find(t => t.name === 'V1').clips
    .map(c => c.transitionIn?.type ?? null)
})()`)
const grab = () => evalJs(`(async () => {
  await new Promise(r => setTimeout(r, 1600))
  return window.__samp(${XS}, 0.3)
})()`)

// 1. timeline shows the overlap zones (video + linked audio), one badge
const zones = await evalJs(`(() => {
  const zs = [...document.querySelectorAll('.transition-zone')]
  const zoom = window.kadrEditor.useEditor.getState().zoom
  return {
    count: zs.length,
    badges: document.querySelectorAll('.transition-badge').length,
    left: zs.map(z => Math.round(parseFloat(z.style.left) / zoom * 100) / 100),
    width: zs.map(z => Math.round(parseFloat(z.style.width) / zoom * 100) / 100)
  }
})()`)
check('overlap zones on video and linked audio tracks',
  zones.count === 2 && zones.badges === 1 &&
  zones.left.every(l => Math.abs(l - 4) < 0.05) &&
  zones.width.every(w => Math.abs(w - 2) < 0.05),
  JSON.stringify(zones))

// 2. hard cut: 'none' draws the later clip on top (pure smptebars)
await setTrans('none')
const pureB = await grab()
// smptebars row at 30% height starts with the 75% white bar
check('hard cut shows pure B (white bar ~191)',
  Math.abs(pureB[0][0] - 191) < 25 && Math.abs(pureB[0][1] - 191) < 25,
  JSON.stringify(pureB[0]))

// 3. crossfade at p=0.5 differs from pure B, and approaches it near p=1
await setTrans('crossfade')
const mix = await grab()
const dMix = diff(mix, pureB)
check('crossfade at 50% blends A into B', dMix > 12, `avg diff ${dMix.toFixed(1)}`)
await evalJs(`(() => { window.kadrEditor.useEditor.getState().setPlayhead(5.95); return 1 })()`)
const nearEnd = await grab()
const dEnd = diff(nearEnd, pureB)
check('crossfade at ~100% equals pure B', dEnd < 12, `avg diff ${dEnd.toFixed(1)}`)

// 4. wipeRight at p=0.5: left half = B, right half = A
await evalJs(`(() => { window.kadrEditor.useEditor.getState().setPlayhead(5); return 1 })()`)
const types = await setTrans('wipeRight')
const wipe = await grab()
const dLeft = diff(wipe.slice(0, 5), pureB.slice(0, 5))
const dRight = diff(wipe.slice(5), pureB.slice(5))
check('wipeRight: left half is B, right half is A',
  dLeft < 10 && dRight > 25,
  `left ${dLeft.toFixed(1)} right ${dRight.toFixed(1)} types ${JSON.stringify(types)}`)

// 5. badge menu opens and picks a transition; undo label recorded
const badge = await evalJs(`(() => {
  const b = document.querySelector('.transition-badge')
  const r = b.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: Math.round(badge.x), y: Math.round(badge.y), button: 'left', clickCount: 1, buttons: 1 })
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Math.round(badge.x), y: Math.round(badge.y), button: 'left', clickCount: 1, buttons: 0 })
await new Promise((r) => setTimeout(r, 400))
const menu = await evalJs(`(() => {
  const m = document.querySelector('.ctx-menu.trans-menu')
  if (!m) return { open: false }
  const btns = [...m.querySelectorAll('button')]
  const target = btns.find(b => /Растворение|Dissolve/.test(b.textContent))
  const checked = btns.find(b => b.textContent.includes('✓'))?.textContent ?? ''
  target.click()
  return { open: true, buttons: btns.length, checked }
})()`)
await new Promise((r) => setTimeout(r, 300))
const after = await evalJs(`(() => {
  const st = window.kadrEditor.useEditor.getState()
  const v1 = st.project.tracks.find(t => t.name === 'V1')
  const b = [...v1.clips].sort((x, y) => x.start - y.start)[1]
  return {
    type: b.transitionIn?.type,
    lastUndo: st.past[st.past.length - 1]?.label,
    menuGone: !document.querySelector('.ctx-menu.trans-menu')
  }
})()`)
check('badge menu picks dissolve (15 options, wipeRight was checked)',
  menu.open && menu.buttons === 15 && /Шторка вправо|Wipe right/.test(menu.checked) &&
  after.type === 'dissolve' && after.lastUndo === 'hTransition' && after.menuGone,
  JSON.stringify({ menu, after }))

ws.close()
console.log('e2e13 finished')
