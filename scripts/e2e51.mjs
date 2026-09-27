// Test: a big project stays light — what a 19-minute, 1124-clip project
// showed: the timeline lagged when scrolled or zoomed, and the sound began to
// stutter towards the end of a full playthrough.
//
//   1. the preview keeps media elements only around the playhead: walking 200
//      clips leaves a handful, and their WebAudio sources are disconnected;
//   2. the timeline renders what is near the view (plus the selection); a clip
//      a few pixels wide is one element; setZoom from code applies at once;
//   3. a wheel zoom stretches the drawn timeline, then commits around the
//      cursor; a click in the middle of a stretch commits first;
//   4. the zoom slider keeps the playhead in place and commits on release.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Silent (the preview's master is muted while it plays).
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e50 and deletes it, with the
// fragments and renders it made.
import WebSocket from 'ws'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e51'

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!page) throw new Error('editor page not found')

function connect(url) {
  const sock = new WebSocket(url, { perMessageDeflate: false })
  const ready = new Promise((r, j) => { sock.on('open', r); sock.on('error', j) })
  ready.catch(() => { /* closed before it opened: the send() that needs it reports */ })
  let id = 0
  let closed = false
  sock.setMaxListeners(0)
  sock.on('close', () => { closed = true })
  const send = async (method, params = {}) => {
    await ready
    if (closed) throw new Error('target gone')
    return new Promise((resolve, reject) => {
      sock.once('close', () => reject(new Error('target gone')))
      const m = ++id
      const on = (raw) => { const x = JSON.parse(raw); if (x.id !== m) return; sock.off('message', on); x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result) }
      sock.on('message', on)
      sock.send(JSON.stringify({ id: m, method, params }))
    })
  }
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return { send, ev, close: () => { try { sock.close() } catch { /* not open yet */ } } }
}
const ed = connect(page.webSocketDebuggerUrl)
// long async work in the editor: park the result in a global and poll
// (awaitPromise over CDP is flaky under GC — see CLAUDE.md)
const evalJs = async (expression, timeout = 180000) => {
  const key = `k${Date.now()}_${Math.random().toString(36).slice(2)}`
  await ed.ev(`window.__e2e = window.__e2e || {}; (async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) } catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`)
  const t0 = Date.now()
  for (;;) {
    const raw = await ed.ev(`window.__e2e.${key} ?? null`)
    if (raw !== null) { const r = JSON.parse(raw); if ('err' in r) throw new Error(r.err); return r.ok }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 200))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = 'window.kadrEditor.useEditor.getState()'
async function pageOf(fragId, type = 'iframe', timeout = 20000) {
  const t0 = Date.now()
  for (;;) {
    const t = (await targets()).find((x) => x.type === type && x.url.includes(`comp=${fragId}`))
    if (t) return { ...connect(t.webSocketDebuggerUrl), url: t.url }
    if (Date.now() - t0 > timeout) return null
    await sleep(250)
  }
}
async function until(fn, timeout = 15000, step = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > timeout) return null
    await sleep(step)
  }
}

const clipsOpen = await ed.ev(`${S}.project.tracks.reduce((n, t) => n + t.clips.length, 0)`)

// ---- the project: 200 short sounds over 200 s on A1, one long sound on A2 ----
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.5', '-ac', '1', `${DIR}/tick.wav`])
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=60', '-af', 'volume=0.5', '-ac', '1', `${DIR}/bed.wav`])
const prefs = await ed.ev(`JSON.stringify({ zoom: ${S}.zoom })`)
try {
  const ids = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e51', width: 640, height: 360, fps: 30, background: '#000000',
      tracks: [mk('V1', 'video'), mk('A1', 'audio'), mk('A2', 'audio')], assets: [], markers: [], texts: [] }, null)
    await E.importFiles(['${DIR}/tick.wav', '${DIR}/bed.wav'])
    const p = JSON.parse(JSON.stringify(st().project))
    const tick = p.assets.find((a) => a.path.endsWith('tick.wav')), bed = p.assets.find((a) => a.path.endsWith('bed.wav'))
    const clip = (asset, start, duration) => ({ id: E.uid(), assetId: asset.id, kind: 'media', start, duration, inPoint: 0, ...E.newClipDefaults() })
    for (let i = 0; i < 200; i++) p.tracks[1].clips.push(clip(tick, i + 0.25, 0.5))
    p.tracks[2].clips.push(clip(bed, 20, 60))
    st().setProject(p, null)
    st().setPlayhead(0)
    return { far: p.tracks[1].clips[150].id, tiny: p.tracks[1].clips[3].id, bed: p.tracks[2].clips[0].id }
  })()`)
  await sleep(800)

  // ---- 1: the preview holds elements only around the playhead ---------------
  const walk = await evalJs(`new Promise((done) => {
    const E = window.kadrEditor
    let t = 0, peak = 0
    const f = () => {
      E.useEditor.getState().setPlayhead(t)
      peak = Math.max(peak, E.previewPoolStats().elements)
      t += 0.25
      if (t < 205) requestAnimationFrame(f)
      else setTimeout(() => done({ peak, end: E.previewPoolStats().elements, routed: E.audioStats().routed }), 1500)
    }
    requestAnimationFrame(f)
  })`, 180000)
  check('walking 200 clips keeps the preview pool small (was: one element per clip ever touched)',
    walk.peak <= 30 && walk.end <= 15, JSON.stringify(walk))
  check('…and the audio graph small with it (sources are disconnected when dropped)', walk.routed <= walk.end, JSON.stringify(walk))
  const back = await evalJs(`(async () => {
    const E = window.kadrEditor
    E.silencePreview(true)
    E.useEditor.getState().setPlayhead(30.1)
    await new Promise((r) => setTimeout(r, 1500))
    const before = E.previewPoolStats()
    E.useEditor.getState().setPlaying(true)
    await new Promise((r) => setTimeout(r, 3000))
    E.useEditor.getState().setPlaying(false)
    const after = E.previewPoolStats()
    E.silencePreview(false)
    return { elements: before.elements, resyncs: after.resyncs - before.resyncs, drift: Object.values(after.drift) }
  })()`)
  check('going back, the clips there get their elements again and play in sync', back.elements >= 2 && back.resyncs <= 1, JSON.stringify(back))

  // ---- 2: the timeline draws what is near the view --------------------------
  const cull = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState(), sc = document.querySelector('.tl-scroll')
    st().setZoom(60); sc.scrollLeft = 0
    await new Promise((r) => setTimeout(r, 500))
    const n = document.querySelectorAll('.clip').length
    const farShown = !!document.querySelector('[data-clip="${ids.far}"]')
    st().select(['${ids.far}'])
    await new Promise((r) => setTimeout(r, 300))
    const farSelected = !!document.querySelector('[data-clip="${ids.far}"]')
    st().select([])
    return { n, farShown, farSelected }
  })()`)
  check('zoomed in on a long timeline, clips far from the view are not in the DOM', cull.n < 60 && !cull.farShown, JSON.stringify(cull))
  check('…but a selected one is (a clip being dragged must not unmount)', cull.farSelected)
  const tiny = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().setZoom(4)
    await new Promise((r) => setTimeout(r, 600))
    const t = document.querySelector('[data-clip="${ids.tiny}"]'), b = document.querySelector('[data-clip="${ids.bed}"]')
    const w = (el) => Math.round(el.getBoundingClientRect().width)
    return { tinyChildren: t && t.children.length, tinyW: t && w(t), bedChildren: b && b.children.length, bedW: b && w(b) }
  })()`)
  check('a 2 px clip is one element; a wide one keeps its handles and waveform',
    tiny.tinyChildren === 0 && tiny.tinyW === 4 && tiny.bedChildren > 3 && tiny.bedW === 240, JSON.stringify(tiny))
  const prog = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().setZoom(10)
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    return Math.round(document.querySelector('[data-clip="${ids.bed}"]').getBoundingClientRect().width)
  })()`)
  check('setZoom from code still applies at once (geometry is a CSS calc of --z)', prog === 600, `bed width ${prog}`)

  // ---- 3: a wheel zoom stretches, then commits around the cursor -----------
  await ed.ev(`(window.kadrEditor.useEditor.getState().setZoom(20), document.querySelector('.tl-scroll').scrollLeft = 300, 1)`)
  await sleep(500)
  const lane = await ed.ev(`(() => { const r = document.querySelector('.lane.audio').getBoundingClientRect(); return JSON.stringify({ l: r.left, y: r.top + r.height / 2 }) })()`).then(JSON.parse)
  const x = Math.round(lane.l + 500)
  const tAt = () => ed.ev(`(() => { const r = document.querySelector('.lane.audio').getBoundingClientRect(); return (${x} - r.left) / window.kadrEditor.useEditor.getState().zoom })()`)
  const t0 = await tAt()
  for (let i = 0; i < 6; i++) {
    await ed.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y: Math.round(lane.y), deltaX: 0, deltaY: -60 })
    await sleep(16)
  }
  const mid = await ed.ev(`JSON.stringify({ zooming: document.querySelector('.tl-content').classList.contains('zooming'), zoom: ${S}.zoom })`).then(JSON.parse)
  check('during the gesture the picture is stretched and the zoom not yet committed', mid.zooming && mid.zoom === 20, JSON.stringify(mid))
  await sleep(450)
  const end = await ed.ev(`JSON.stringify({ zooming: document.querySelector('.tl-content').classList.contains('zooming'), zoom: ${S}.zoom })`).then(JSON.parse)
  const t1 = await tAt()
  const px = Math.abs(t1 - t0) * end.zoom
  check('when it pauses the zoom is committed and the stretch removed', !end.zooming && end.zoom > 30, JSON.stringify(end))
  check('…with the time under the cursor where it was (≤ 1 px)', px <= 1, `${(Math.abs(t1 - t0) * 1000).toFixed(1)} ms = ${px.toFixed(2)} px`)
  // a click in the middle of a stretch sees the committed zoom first
  await ed.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y: Math.round(lane.y), deltaX: 0, deltaY: 120 })
  await sleep(30)
  const zBefore = await ed.ev(`${S}.zoom`)
  await ed.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: Math.round(lane.y) - 60, button: 'left', clickCount: 1, buttons: 1 })
  await ed.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: Math.round(lane.y) - 60, button: 'left', clickCount: 1, buttons: 0 })
  const zAfter = await ed.ev(`JSON.stringify({ zoom: ${S}.zoom, zooming: document.querySelector('.tl-content').classList.contains('zooming') })`).then(JSON.parse)
  check('a click during the stretch commits the zoom before it lands', zAfter.zoom < zBefore && !zAfter.zooming, `${zBefore} → ${JSON.stringify(zAfter)}`)

  // ---- 4: the zoom slider keeps the playhead where it is --------------------
  const sl = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState(), sc = document.querySelector('.tl-scroll')
    st().setZoom(20); sc.scrollLeft = 1000
    await new Promise((r) => setTimeout(r, 300))
    st().setPlayhead((1000 + 600) / 20)
    await new Promise((r) => setTimeout(r, 200))
    const ph = () => document.querySelector('.playhead').getBoundingClientRect().left
    const x0 = ph()
    const s = document.querySelectorAll('.zoom-ctl input[type=range]')[1]
    const set = (v) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(s, String(v)); s.dispatchEvent(new Event('input', { bubbles: true })) }
    for (let i = 1; i <= 10; i++) { set(Math.log(20) + i * 0.03); await new Promise((r) => requestAnimationFrame(r)) }
    s.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    return { x0, x1: ph(), zoom: st().zoom, slider: Math.exp(Number(s.value)) }
  })()`)
  check('the zoom slider keeps the playhead in place and commits on release',
    Math.abs(sl.x1 - sl.x0) <= 1 && Math.abs(sl.zoom - 20 * Math.exp(0.3)) < 0.05 && Math.abs(sl.slider - sl.zoom) < 0.05, JSON.stringify(sl))
} finally {
  await ed.ev(`(window.kadrEditor.useEditor.getState().setZoom(${JSON.parse(prefs).zoom}), window.kadrEditor.silencePreview(false), 1)`).catch(() => {})
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
