// Test: the chroma key (src/gl/effects/chromaKey.fx.ts) and its eyedropper.
//   1. on a green card with a red square over a blue track, the green turns
//      into the blue beneath and the red stays;
//   2. the eyedropper: while it waits the key is bypassed, a click on the
//      preview takes the colour under it into the key colour (one undo step),
//      and Esc cancels.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e61 and deletes it.
import WebSocket from 'ws'
import { rmSync, mkdirSync } from 'fs'
import { execFileSync } from 'child_process'

const PORT = process.env.KADR_CDP_PORT || 9777

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!page) throw new Error('editor page not found')

function connect(url) {
  const sock = new WebSocket(url, { perMessageDeflate: false })
  const ready = new Promise((r, j) => { sock.on('open', r); sock.on('error', j) })
  ready.catch(() => { /* closed before it opened: the send() that needs it reports */ })
  let id = 0
  sock.setMaxListeners(0)
  const send = async (method, params = {}) => {
    await ready
    return new Promise((resolve, reject) => {
      const m = ++id
      const on = (raw) => { const x = JSON.parse(raw); if (x.id !== m) return; sock.off('message', on); x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result) }
      sock.on('message', on)
      sock.send(JSON.stringify({ id: m, method, params }))
    })
  }
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true })
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
const S = 'window.kadrEditor.useEditor.getState()'

const clipsOpen = await ed.ev(`${S}.project.tracks.reduce((n, t) => n + t.clips.length, 0)`)
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e61 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e61'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x10d020:s=320x180:d=1:r=30',
  '-vf', 'drawbox=x=120:y=60:w=80:h=60:color=0xd02020:t=fill', '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', `${DIR}/card.mp4`])
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x2040c0:s=320x180:d=1:r=30',
  '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', `${DIR}/blue.mp4`])
const E = 'window.kadrEditor'
const pixel = (x, y) => [...execFileSync('ffmpeg', ['-v', 'error', '-i', `${DIR}/out.mp4`, '-frames:v', '1',
  '-vf', `crop=2:2:${x}:${y},scale=1:1`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])]
const near = (a, b, tol = 8) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

try {
  const ids = await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e61', width: 320, height: 180, fps: 30, background: '#000000', assets: [], texts: [],
      tracks: [{ id: 'v2', name: 'V2', kind: 'video', clips: [], gain: 1 }, { id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 }] }, null)
    const add = async (f, track) => { const { asset } = await window.kadr.probeMedia('${DIR}/' + f); const id = ed.uid()
      st().addAsset({ id, ...asset }); st().insertClipFromAsset(id, track, 0)
      return st().project.tracks.find((t) => t.id === track).clips[0].id }
    const blue = await add('blue.mp4', 'v1'), card = await add('card.mp4', 'v2')
    await ed.startExport(st().project, ed.PRESETS.find((q) => q.id === 'source'), '${DIR}/out.mp4', () => {}, { start: 0.1, end: 0.3 }, {}).done
    return { card }
  })()`)
  // the same frame without the key, read back through the same encoder
  const ref = { fg: pixel(158, 88) }
  ids.key = await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    const key = ed.effects.add('${ids.card}', 'chromaKey', { color: '#10d020' })
    await ed.startExport(st().project, ed.PRESETS.find((q) => q.id === 'source'), '${DIR}/out.mp4', () => {}, { start: 0.1, end: 0.3 }, {}).done
    return key
  })()`)
  const bg = pixel(20, 20), fg = pixel(158, 88)
  check('the green turns into the track below', near(bg, [32, 64, 192]), bg.join())
  check('the subject stays as it was', near(fg, ref.fg, 3), `${fg.join()} vs ${ref.fg.join()}`)

  const pick = await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    const tick = () => new Promise((r) => setTimeout(r, 400))
    ed.effects.set('${ids.card}', '${ids.key}', { params: { color: '#ff00ff' } })
    st().select(['${ids.card}']); st().setPlayhead(0.5); await tick()
    const btn = () => document.querySelector('[data-fx="chromaKey"] [data-act="fx-pick"]')
    btn().click(); await tick()
    const waiting = btn().getAttribute('aria-pressed') === 'true' && document.body.classList.contains('fx-picking')
    const canvas = document.querySelector('.preview-canvas-wrap canvas')
    const r = canvas.getBoundingClientRect()
    const h0 = st().past.length
    canvas.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, clientX: r.left + r.width * 0.06, clientY: r.top + r.height * 0.1 }))
    await tick()
    const picked = st().project.tracks[0].clips[0].effects[0].params.color
    const steps = st().past.length - h0
    btn().click(); await tick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await tick()
    return { waiting, picked, steps, cancelled: btn().getAttribute('aria-pressed') === 'false' && !document.body.classList.contains('fx-picking'),
      still: st().project.tracks[0].clips[0].effects[0].params.color }
  })()`)
  check('while picking, the button is on and the preview waits for a click', pick.waiting)
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  check('a click takes the unkeyed colour under it', near(rgb(pick.picked), [16, 208, 32], 16), pick.picked)
  check('…as one undo step', pick.steps === 1, `${pick.steps}`)
  check('Esc cancels without changing the colour', pick.cancelled && pick.still === pick.picked, pick.still)
} finally {
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
