// Test: a failed mux reaches whoever awaits the export. The failure used to
// arrive only as an export:progress event, so startExport().done resolved and
// kadr_export reported a written file that did not exist.
//   1. an export into a folder that does not exist: ffmpeg's mux fails, .done
//      rejects with its message, and the rendered video is kept where the
//      message says;
//   2. the same export into a real folder still resolves.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e54 and deletes it.
import WebSocket from 'ws'
import { rmSync, mkdirSync, existsSync } from 'fs'
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
  console.log(`SKIP  e2e54 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e54'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:d=1:r=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${DIR}/src.mp4`])

const exportTo = (out) => evalJs(`(async () => {
  const ed = window.kadrEditor
  const preset = ed.PRESETS.find((q) => q.id === 'source')
  try {
    await ed.startExport(ed.useEditor.getState().project, preset, '${out}', () => {}, null, {}).done
    return { ok: true }
  } catch (e) { return { ok: false, message: String(e && e.message || e) } }
})()`)

let kept = ''
try {
  await evalJs(`(async () => {
    const ed = window.kadrEditor, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e54', width: 640, height: 360, fps: 30, background: '#000000',
      assets: [], texts: [], tracks: [{ id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 }] }, null)
    const { asset } = await window.kadr.probeMedia('${DIR}/src.mp4')
    const id = ed.uid(); st().addAsset({ id, ...asset }); st().insertClipFromAsset(id, 'v1', 0)
    return true
  })()`)

  const bad = await exportTo(`${DIR}/no-such-folder/out.mp4`)
  kept = (bad.message?.match(/video kept at (\S+?)\)?$/) || [])[1] || ''
  check('a failed mux rejects the export', !bad.ok, bad.message?.slice(0, 160))
  check('the message says where the rendered video is kept', !!kept && existsSync(kept), kept)

  const good = await exportTo(`${DIR}/out.mp4`)
  check('a normal export still resolves', good.ok && existsSync(`${DIR}/out.mp4`), good.message)
} finally {
  if (kept) rmSync(kept, { force: true })
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
