// Test: a media clip that starts past the end of its source is pointed out.
// Its loop period collapses to 50 ms past the last frame, so it shows a frozen
// or broken frame and plays silence, and nothing on screen said why.
//   1. the checks report it (kind 'sourceEnd'), and only it: a clip that
//      simply runs longer than its source and loops is fine;
//   2. the timeline marks that clip with a warning sign, not the loop icon.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e55 and deletes it.
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
  console.log(`SKIP  e2e55 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e55'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:d=2:r=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${DIR}/src.mp4`])

try {
  const ids = await evalJs(`(async () => {
    const ed = window.kadrEditor, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e55', width: 640, height: 360, fps: 30, background: '#000000',
      assets: [], texts: [], tracks: [{ id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 }] }, null)
    const { asset } = await window.kadr.probeMedia('${DIR}/src.mp4')
    const id = ed.uid(); st().addAsset({ id, ...asset })
    const p = st().project
    const mk = (start, inPoint, duration) => ({ ...ed.newClipDefaults(), id: ed.uid(), assetId: id, kind: 'media',
      label: 'src.mp4', start, inPoint, duration, speed: 1 })
    const looping = mk(0, 0, 5), past = mk(6, 2.5, 1)
    st().setProject({ ...p, tracks: [{ ...p.tracks[0], clips: [looping, past] }] }, null)
    return { looping: looping.id, past: past.id }
  })()`)
  const r = await evalJs(`window.kadrEditor.runChecks({}).then((r) => r.issues.filter((i) => i.kind === 'sourceEnd').map((i) => i.clipId))`)
  check('the checks report the clip that starts past its source', r.length === 1 && r[0] === ids.past, JSON.stringify(r))
  const marks = await evalJs(`(async () => {
    await new Promise((r) => setTimeout(r, 300))
    const el = (id) => document.querySelector('[data-clip="' + id + '"]')
    return { past: !!el('${ids.past}')?.querySelector('.past-end'), looping: !!el('${ids.looping}')?.querySelector('.past-end'),
      found: !!el('${ids.past}') }
  })()`)
  check('the timeline marks that clip', marks.found && marks.past, JSON.stringify(marks))
  check('a clip that only loops is not marked', !marks.looping)
} finally {
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
