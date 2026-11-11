// Test: three timeline gestures on a SELECTION of clips (from HelpFreedom/kadr#24):
//
//   1. «Delete clip» in a clip's context menu deletes the whole selection the
//      menu was opened on — right-click keeps a selection that holds the clip,
//      and the Delete key removes all of it, but the menu item first narrowed
//      the selection to the clicked clip and removed only that one;
//   2. a group dragged past 0 stops there with its spacing intact — each clip
//      used to be clamped on its own, so the group piled up at 0;
//   3. a drag cancelled by the system (pointercancel — touch, pen, a gesture
//      taken over) ends — no pointerup ever comes, and the drag used to keep
//      following the pointer with no button held.
//
// Real mouse events over CDP on the real timeline. Launch the app with
// `npx electron-vite dev -- --remote-debugging-port=9777`. Replaces the open
// project, so it refuses over one with clips unless KADR_E2E_FORCE=1.
import { rmSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'
import WebSocket from 'ws'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e56'
const page = (await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!page) throw new Error('editor page not found')
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
let id = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const m = ++id
  const on = (raw) => { const x = JSON.parse(raw); if (x.id !== m) return; ws.off('message', on); x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result) }
  ws.on('message', on)
  ws.send(JSON.stringify({ id: m, method, params }))
})
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mouse = (type, x, y, button = 'none', buttons = 0) =>
  send('Input.dispatchMouseEvent', { type, x, y, button, buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const S = 'window.kadrEditor.useEditor.getState()'

const clipsOpen = await ev(`${S}.project.tracks.reduce((n, t) => n + t.clips.length, 0)`)
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e56 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=3', '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', `${DIR}/v.mp4`])

// three video clips: A at 1 s, B at 6 s, C at 11 s; the timeline scrolled to 0
const setup = () => ev(`(async () => {
  const E = window.kadrEditor, st = () => E.useEditor.getState()
  st().setProject({ version: 1, id: E.uid(), name: 'e2e56', width: 320, height: 180, fps: 30, background: '#000000',
    tracks: [{ id: E.uid(), kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [] }], assets: [], markers: [], texts: [] }, null)
  for (const at of [1, 6, 11]) await E.importFiles(['${DIR}/v.mp4'], { trackId: st().project.tracks[0].id, at })
  st().setZoom(40)
  const lanes = document.querySelector('.tl-scroll, .timeline-scroll, [class*=tl-body]')
  if (lanes) lanes.scrollLeft = 0
  await new Promise((r) => setTimeout(r, 400))
  return st().project.tracks[0].clips.map((c) => ({ id: c.id, start: c.start })).sort((a, b) => a.start - b.start)
})()`)
const rectOf = (clipId) => ev(`(() => { const r = document.querySelector('[data-clip="${clipId}"]').getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height } })()`)
const starts = () => ev(`Object.fromEntries(${S}.project.tracks.flatMap((t) => t.clips).map((c) => [c.id, Math.round(c.start * 1000) / 1000]))`)

try {
  // ---- 1. the context menu's Delete acts on the selection
  let [A, B, C] = await setup()
  await ev(`(${S}.select(['${A.id}', '${B.id}']), 0)`)
  const rb = await rectOf(B.id)
  await mouse('mousePressed', rb.x + rb.w / 2, rb.y + rb.h / 2, 'right', 2)
  await mouse('mouseReleased', rb.x + rb.w / 2, rb.y + rb.h / 2, 'right', 0)
  await sleep(300)
  check('right-click on a selected clip keeps the selection', JSON.stringify((await ev(`${S}.selection`)).sort()) === JSON.stringify([A.id, B.id].sort()))
  const clicked = await ev(`(() => { const b = [...document.querySelectorAll('.ctx-menu button.danger')].find((x) => /Удалить клип|Delete clip/.test(x.textContent)); if (!b) return false; b.click(); return true })()`)
  await sleep(300)
  const left = Object.keys(await starts())
  check('«Delete clip» in the menu deletes the whole selection', clicked && left.length === 1 && left[0] === C.id, `left: ${left.length} clip(s)`)
  await ev(`(${S}.undo(), 0)`)
  await sleep(200)
  check('… in one undo step', Object.keys(await starts()).length === 3)

  // ---- 2. a group dragged past 0 keeps its spacing
  ;[A, B, C] = await setup()
  await ev(`(${S}.select(['${A.id}', '${B.id}']), 0)`)
  const ra = await rectOf(A.id)
  const zoom = await ev(`${S}.zoom`)
  const x0 = ra.x + ra.w / 2, y0 = ra.y + ra.h / 2
  await mouse('mousePressed', x0, y0, 'left', 1)
  for (let k = 1; k <= 10; k++) { await mouse('mouseMoved', x0 - (k / 10) * 4 * zoom, y0, 'left', 1); await sleep(16) } // 4 s to the left
  await mouse('mouseReleased', x0 - 4 * zoom, y0, 'left', 0)
  await sleep(200)
  const s2 = await starts()
  check('a group dragged past 0 stops there: the first clip at 0', s2[A.id] === 0, JSON.stringify(s2))
  check('… with its spacing intact (B still 5 s after A)', Math.abs(s2[B.id] - s2[A.id] - 5) < 1e-6, `A ${s2[A.id]}, B ${s2[B.id]}`)
  check('… and the clip outside the group untouched', s2[C.id] === 11)

  // ---- 3. a cancelled drag ends
  await ev(`(${S}.setPlayhead(0), 0)`)
  const ruler = await ev(`(() => { const r = document.querySelector('.ruler').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2 } })()`)
  await mouse('mousePressed', ruler.x + 2 * zoom, ruler.y, 'left', 1)
  await mouse('mouseMoved', ruler.x + 3 * zoom, ruler.y, 'left', 1)
  await sleep(100)
  const during = await ev(`${S}.playhead`)
  // the system takes the gesture over: pointercancel, and never a pointerup
  await ev(`(window.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })), 0)`)
  await mouse('mouseMoved', ruler.x + 8 * zoom, ruler.y, 'none', 0) // the button is up now
  await sleep(150)
  const after = await ev(`${S}.playhead`)
  check('the playhead follows a ruler drag', Math.abs(during - 3) < 0.1, during.toFixed(2))
  check('… and stops following once the system cancels the gesture', Math.abs(after - during) < 1e-6, `${during.toFixed(2)} → ${after.toFixed(2)}`)
  await mouse('mouseReleased', ruler.x + 8 * zoom, ruler.y, 'left', 0)
} finally {
  rmSync(DIR, { recursive: true, force: true })
  await ev(`${S}.setProject({ version: 1, id: window.kadrEditor.uid(), name: 'Untitled', width: 1920, height: 1080, fps: 30, background: '#000000', tracks: [], assets: [], markers: [], texts: [] }, null)`).catch(() => {})
  ws.close()
}
