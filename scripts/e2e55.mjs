// Test: the hidden fragment-capture windows — a failed one does not block a
// retry (HelpFreedom/kadr#14), and none of them keeps the app alive once the
// editor window is closed (HelpFreedom/kadr#42).
//
// A fragment's pixel-capture window is a hidden BrowserWindow, and so are the
// pages that read a fragment's inspect data or play it for collisions. While
// any of them was open, closing the editor did not fire window-all-closed, so
// app.quit never ran — and before-quit is what stops the captures: a windowless
// process stayed alive (reported on Windows; the same logic holds on Linux).
//
// THIS SUITE CLOSES THE APP. Start an instance for it alone:
//   npx electron-vite dev -- --remote-debugging-port=9777
// It opens a capture window on about:blank (the page does not matter, the
// window does), closes the editor window as a user would, and expects the
// process — and with it the debugging endpoint — to be gone within 10 s
// (window-all-closed quits; its own failsafe exits after 2.5 s).
// Refuses over a project with clips unless KADR_E2E_FORCE=1.
import WebSocket from 'ws'
import net from 'net'

const PORT = process.env.KADR_CDP_PORT || 9777
const list = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = (await list()).find((t) => t.type === 'page' && t.title === 'Kadr')
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
const ev = async (expression, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

const clipsOpen = await ev('window.kadrEditor.useEditor.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0)')
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e55 closes the app, and the open project has ${clipsOpen} clip(s) — save it first (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

// ---- kadr#14: a capture whose page failed to load must not block a retry.
// The window was registered before its load was awaited, so a failed load
// left it in the map on Chromium's error page, and every later start for that
// id returned at once — the renderer retries on its next pass, believed it,
// and the fragment never painted.
// a port that was just free: the load fails the way a dev server that is down fails
const deadPort = await new Promise((r) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)) }) })
const DEAD = `http://127.0.0.1:${deadPort}/?comp=e2e55`
const failed = await ev(`window.kadr.fragmentCaptureStart('e2e55-retry', ${JSON.stringify(DEAD)}, 320, 180, 30).then(() => 'resolved', (e) => 'rejected: ' + String(e && e.message || e).slice(0, 120))`, true)
check('a capture whose page cannot load rejects', failed.startsWith('rejected'), failed)
const afterFail = await list()
check('… and leaves no window behind', !afterFail.some((t) => t.type === 'page' && t.url !== page.url && t.title !== 'Kadr'),
  afterFail.map((t) => t.type + ':' + t.url).join(', '))
await ev(`window.kadr.fragmentCaptureStart('e2e55-retry', 'about:blank#retry', 320, 180, 30)`, true)
const retried = await list()
check('a retry of the same id really loads its page', retried.some((t) => t.type === 'page' && t.url === 'about:blank#retry'),
  retried.map((t) => t.type + ':' + t.url).join(', '))
await ev(`window.kadr.fragmentCaptureStop('e2e55-retry')`, true)

// ---- kadr#42
await ev(`window.kadr.fragmentCaptureStart('e2e55', 'about:blank', 320, 180, 30)`, true)
const before = await list()
check('a hidden capture window is open', before.some((t) => t.type === 'page' && t.url === 'about:blank'),
  before.map((t) => t.type + ':' + (t.title || t.url)).join(', '))

// close the editor window the way the window manager's close button does
ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression: 'window.close()' } }))
const t0 = Date.now()
let gone = false
while (Date.now() - t0 < 10000) {
  await new Promise((r) => setTimeout(r, 500))
  try { await list() } catch { gone = true; break }
}
check('closing the editor ends the app (no windowless process left)', gone,
  gone ? `${((Date.now() - t0) / 1000).toFixed(1)} s` : 'still answering after 10 s')
try { ws.close() } catch { /* gone with the app */ }
