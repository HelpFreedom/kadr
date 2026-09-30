// Test: an export with audio muxes on the installed ffmpeg, whatever its major
// version. ffmpeg 8 removed -filter_complex_script and every export with sound
// failed at the mux ("Unrecognized option"); ffmpeg 7+ takes the graph file
// through -/filter_complex, older builds through the old flag.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e52 and deletes it.
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
if (clipsOpen && process.env.KADR_E2E_FORCE !== '1') {
  console.log(`SKIP  an open project has ${clipsOpen} clips; this suite replaces it (KADR_E2E_FORCE=1 to run anyway)`)
  ed.close()
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e52'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=640x360:d=2:r=30',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
  '-c:a', 'aac', '-shortest', `${DIR}/src.mp4`])
const major = Number((execFileSync('ffmpeg', ['-hide_banner', '-version']).toString().match(/version n?(\d+)\./) || [])[1]) || 'git'

try {
  await evalJs(`(async () => {
    const ed = window.kadrEditor, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e52', width: 640, height: 360, fps: 30, background: '#000000',
      assets: [], texts: [], tracks: [
        { id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 },
        { id: 'a1', name: 'A1', kind: 'audio', clips: [], gain: 1 }] }, null)
    const { asset } = await window.kadr.probeMedia('${DIR}/src.mp4')
    const id = ed.uid()
    st().addAsset({ id, ...asset })
    st().insertClipFromAsset(id, 'v1', 0)
    return true
  })()`)
  const log = await evalJs(`(async () => {
    const ed = window.kadrEditor, p = ed.useEditor.getState().project
    const log = []
    const off = window.kadr.onExportProgress((x) => log.push(x.phase + (x.message ? ': ' + x.message : '')))
    const preset = ed.PRESETS.find((q) => q.id === 'source')
    await ed.startExport(p, preset, '${DIR}/out.mp4', () => {}, null, {}).done
    for (let i = 0; i < 100 && !log.some((s) => /^(done|error|cancelled)/.test(s)); i++) await new Promise((r) => setTimeout(r, 100))
    off()
    return log.at(-1) || ''
  })()`)
  check(`the mux finishes on ffmpeg ${major}`, log.startsWith('done'), log.slice(0, 200))
  const streams = existsSync(`${DIR}/out.mp4`)
    ? execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', `${DIR}/out.mp4`]).toString().trim().split('\n')
    : []
  check('the file carries video and audio', streams.includes('video') && streams.includes('audio'), streams.join(','))
} finally {
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
