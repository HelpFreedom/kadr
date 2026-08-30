// Hold a layout viewport on the editor page for as long as this runs.
//
//   node scripts/hold-viewport.mjs [width] [height]      (default 1890x1000)
//
// Why it exists: the coordinate-driven suites (e2e4/5/6/9/10/13/14) assume the
// usual window, and a TILING window manager pins the editor into a tile the
// moment a second window appears — the detached preview does exactly that, and
// the editor can be left at ~1029x1031 with drags landing nowhere. wmctrl and
// xdotool cannot resize a tiled window back, but Chromium will lay the page out
// at any size on request. The override lives only while a CDP client is
// attached, which is the whole point of this process: start it, run the suites,
// Ctrl-C (or kill) it.
import WebSocket from 'ws'
const PORT = process.env.KADR_CDP_PORT || 9777
const W = Number(process.argv[2] || 1890)
const H = Number(process.argv[3] || 1000)

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
if (!page) { console.error('no editor page on CDP', PORT); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r) => ws.once('open', r))
let id = 0
const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id
  const on = (raw) => { const d = JSON.parse(raw); if (d.id === myId) { ws.off('message', on); res(d.result) } }
  ws.on('message', on)
  ws.send(JSON.stringify({ id: myId, method, params }))
})
await send('Emulation.setDeviceMetricsOverride',
  { width: W, height: H, deviceScaleFactor: 0, mobile: false })
console.log(`viewport held at ${W}x${H} — the override is dropped when this exits`)
const release = async () => {
  await send('Emulation.clearDeviceMetricsOverride')
  ws.close()
  process.exit(0)
}
process.on('SIGTERM', release)
process.on('SIGINT', release)
setInterval(() => {}, 1 << 30)
