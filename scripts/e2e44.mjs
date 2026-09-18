// Test: multi-selection on the timeline — the rubber band on empty lane
// space, the ruler keeping the playhead, Ctrl/Shift click habits from the
// file manager, and group operations on what comes out of them.
//
// Uses TEXT clips only, so the suite needs no media and no ffmpeg.
// Run: node scripts/e2e44.mjs   (app started with --remote-debugging-port=9777)
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
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' +
      (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
  return r.result.value
}
async function evalJs(expression, { timeout = 60000 } = {}) {
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
    await new Promise((r) => setTimeout(r, 200))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

const CTRL = 2
const SHIFT = 8
async function mouse(type, x, y, modifiers = 0) {
  await send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button: 'left', clickCount: 1,
    buttons: type === 'mouseReleased' ? 0 : 1,
    modifiers
  })
}
async function drag(p0, p1, modifiers = 0) {
  await mouse('mousePressed', p0.x, p0.y, modifiers)
  for (let i = 1; i <= 8; i++) {
    await mouse('mouseMoved', p0.x + ((p1.x - p0.x) * i) / 8, p0.y + ((p1.y - p0.y) * i) / 8, modifiers)
    await new Promise((r) => setTimeout(r, 25))
  }
  await mouse('mouseReleased', p1.x, p1.y, modifiers)
  await new Promise((r) => setTimeout(r, 120))
}
async function click(p, modifiers = 0) {
  await mouse('mousePressed', p.x, p.y, modifiers)
  await mouse('mouseReleased', p.x, p.y, modifiers)
  await new Promise((r) => setTimeout(r, 120))
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

// helpers inside the page: a point at (track, time), and the selection
await evalJs(`(() => {
  const ed = window.kadrEditor
  window.__st = () => ed.useEditor.getState()
  window.__at = (name, time) => {
    const s = window.__st()
    const tr = s.project.tracks.find(t => t.name === name)
    const lane = document.querySelector('[data-lane="' + tr.id + '"]')
    const r = lane.getBoundingClientRect()
    // below the level (gain/opacity) line, which owns the top of every clip
    return { x: r.left + time * s.zoom, y: r.top + r.height * 0.75, top: r.top, h: r.height }
  }
  window.__sel = () => [...window.__st().selection].sort().join(',')
  return true
})()`)

// A and B on V2 (0–4 and 6–10), C and D on V1 (0–4 and 6–10)
const ids = await evalJs(`(() => {
  const st = window.__st
  st().setZoom(50)
  // short lanes: the suite drives real screen coordinates, and the second
  // video lane hangs below the window at the default track height. It is a
  // SAVED user setting, so the run puts it back at the end.
  window.__trackH0 = window.kadrEditor.useSettings.getState().trackH
  window.kadrEditor.useSettings.getState().setTrackH(32)
  st().insertTextClip(0); const a = st().selection[0]
  st().insertTextClip(6); const b = st().selection[0]
  st().insertTextClip(0); const c = st().selection[0]
  st().insertTextClip(6); const d = st().selection[0]
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().moveClip(c, v1.id, 0)
  st().moveClip(d, v1.id, 6)
  st().select([])
  st().setPlayhead(1)
  return { a, b, c, d }
})()`)
const key = (...k) => k.map((n) => ids[n]).sort().join(',')

const geom = await evalJs(`(() => {
  const a = window.__at('V2', 5)
  const b = window.__at('V1', 5)
  return { v2: a.top, v1: b.top, h: a.h, winH: window.innerHeight }
})()`)
check('both video lanes are on screen (the suite drives real coordinates)',
  geom.h > 10 && geom.v2 > 0 && geom.v1 + geom.h < geom.winH,
  JSON.stringify(geom))

const at = (track, time) => evalJs(`window.__at('${track}', ${time})`)

// 1. band over empty space selects, and leaves the playhead alone ------------
await drag(await at('V2', 4.4), await at('V2', 7))
check('a band on empty space selects what it covers', await evalJs('window.__sel()') === key('b'),
  await evalJs('window.__sel()'))
check('…and the playhead stays where it was',
  Math.abs(await evalJs('window.__st().playhead') - 1) < 1e-6,
  String(await evalJs('window.__st().playhead')))

// 2. the ruler is what moves the playhead ------------------------------------
const ruler = await evalJs(`(() => {
  const r = document.querySelector('.ruler').getBoundingClientRect()
  return { x: r.left, y: r.top + r.height / 2 }
})()`)
const z = await evalJs('window.__st().zoom')
await drag({ x: ruler.x + 100, y: ruler.y }, { x: ruler.x + 300, y: ruler.y })
check('dragging the ruler moves the playhead',
  Math.abs(await evalJs('window.__st().playhead') - 300 / z) < 0.1,
  String(await evalJs('window.__st().playhead')))

// 3. a band reaching both lanes catches both --------------------------------
await evalJs(`(() => { window.__st().select([]); return true })()`)
await drag(await at('V2', 4.4), await at('V1', 7))
check('a band across two lanes catches clips on both',
  await evalJs('window.__sel()') === key('b', 'd'), await evalJs('window.__sel()'))

// 4. Ctrl+band adds ----------------------------------------------------------
await evalJs(`(() => { window.__st().select([window.__st().project.tracks
  .find(t => t.name === 'V2').clips.find(c => c.start === 0).id]); return true })()`)
await drag(await at('V2', 4.4), await at('V2', 7), CTRL)
check('Ctrl+band adds to the selection instead of replacing it',
  await evalJs('window.__sel()') === key('a', 'b'), await evalJs('window.__sel()'))

// 5. Ctrl+click toggles one clip out -----------------------------------------
await click(await at('V2', 2), CTRL)
check('Ctrl+click removes a clip from the selection',
  await evalJs('window.__sel()') === key('b'), await evalJs('window.__sel()'))

// 6. Shift+click spans from the first selected clip ---------------------------
await click(await at('V2', 2))
check('a plain click selects just that clip', await evalJs('window.__sel()') === key('a'),
  await evalJs('window.__sel()'))
await click(await at('V1', 8), SHIFT)
check('Shift+click selects the whole rectangle to the clicked clip',
  await evalJs('window.__sel()') === key('a', 'b', 'c', 'd'), await evalJs('window.__sel()'))

// 7. the group moves as one ---------------------------------------------------
const before = await evalJs(`(() => window.__st().project.tracks
  .flatMap(t => t.clips).map(c => c.start).sort((x, y) => x - y))()`)
await drag(await at('V2', 2), await at('V2', 4))
const after = await evalJs(`(() => window.__st().project.tracks
  .flatMap(t => t.clips).map(c => c.start).sort((x, y) => x - y))()`)
check('dragging one clip of a selection moves all of them by the same delta',
  before.length === after.length &&
  before.every((s, i) => Math.abs(after[i] - s - 2) < 0.05),
  JSON.stringify(before) + ' -> ' + JSON.stringify(after))

// 8. a plain click narrows the group back to one ------------------------------
await click(await at('V2', 4))
check('a plain click on a group member keeps only that clip',
  await evalJs('window.__sel()') === key('a'), await evalJs('window.__sel()'))

// 9. Ctrl+CLICK on empty space still closes the gap ---------------------------
const gapBefore = await evalJs(`(() => window.__st().project.tracks
  .find(t => t.name === 'V2').clips.map(c => c.start).sort((a, b) => a - b))()`)
await click(await at('V2', 6.5), CTRL)
const gapAfter = await evalJs(`(() => window.__st().project.tracks
  .find(t => t.name === 'V2').clips.map(c => c.start).sort((a, b) => a - b))()`)
check('Ctrl+click on empty lane still closes the gap',
  gapAfter[1] < gapBefore[1] - 0.5,
  JSON.stringify(gapBefore) + ' -> ' + JSON.stringify(gapAfter))

// 10. scrolling mid-drag must not move the band's anchor ----------------------
// the wheel both scrolls and zooms the timeline, so a band anchored in screen
// pixels would jump to another moment the instant the content moved under it
await evalJs(`(() => {
  const st = window.__st
  const p = st().project
  const at0 = (name, i) => p.tracks.find(t => t.name === name).clips
    .sort((a, b) => a.start - b.start)[i].id
  st().setClipStarts([
    { id: at0('V2', 0), start: 0 }, { id: at0('V2', 1), start: 6 },
    { id: at0('V1', 0), start: 0 }, { id: at0('V1', 1), start: 6 }
  ])
  st().select([])
  document.querySelector('.tl-scroll').scrollLeft = 0
  return true
})()`)
const anchor = await at('V2', 5)
await mouse('mousePressed', anchor.x, anchor.y)
await mouse('mouseMoved', anchor.x + 20, anchor.y)
await evalJs(`(() => { document.querySelector('.tl-scroll').scrollLeft = 100; return true })()`)
const backTo = await at('V2', 2.5)
await mouse('mouseMoved', backTo.x, backTo.y)
await new Promise((r) => setTimeout(r, 60))
await mouse('mouseReleased', backTo.x, backTo.y)
await new Promise((r) => setTimeout(r, 120))
check('the band keeps its anchor when the timeline scrolls mid-drag',
  await evalJs('window.__sel()') === key('a'), await evalJs('window.__sel()'))

// trackH is a saved user setting — put it back the way it was
await evalJs(`(() => {
  window.kadrEditor.useSettings.getState().setTrackH(window.__trackH0)
  return window.kadrEditor.useSettings.getState().trackH
})()`)

ws.close()
console.log(process.exitCode ? '\nFAILED' : '\nall good')
