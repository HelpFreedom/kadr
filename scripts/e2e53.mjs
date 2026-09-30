// Test: switching the interface language must not move the layout.
//   1. the timeline toolbar keeps one height in Russian and English at a small
//      and a wide window: its controls hint used to wrap into several lines
//      (more of them in Russian) and take the height from the tracks;
//   2. the clip animation editor and the track motion editor never scroll
//      sideways: the stage is sized from the measured content width, and the
//      value grid drops to one column when a label does not fit.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e53 and deletes it; restores
// the language and the window metrics it changed.
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
  console.log(`SKIP  e2e53 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e53'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=1280x720:d=4:r=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${DIR}/src.mp4`])
const lang0 = await ed.ev('window.kadrEditor.useSettings.getState().lang')

const setup = (editor) => evalJs(`(async () => {
  const ed = window.kadrEditor, st = () => ed.useEditor.getState()
  st().setProject({ name: 'e2e53', width: 1280, height: 720, fps: 30, background: '#000000',
    assets: [], texts: [], tracks: [{ id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 }] }, null)
  const { asset } = await window.kadr.probeMedia('${DIR}/src.mp4')
  const id = ed.uid(); st().addAsset({ id, ...asset }); st().insertClipFromAsset(id, 'v1', 0)
  if ('${editor}' === 'anim') st().setAnimClip(st().project.tracks[0].clips[0].id)
  else st().setMotionTrack('v1')
  return true
})()`)
const measure = () => evalJs(`(async () => {
  await new Promise((r) => setTimeout(r, 400))
  const e = document.querySelector('.anim-editor'), tb = document.querySelector('.tl-toolbar')
  const hint = tb.querySelector('.hint-inline')
  return { over: e.scrollWidth - e.clientWidth, tb: tb.offsetHeight,
    hintLines: hint.offsetWidth ? Math.round(hint.offsetHeight / parseFloat(getComputedStyle(hint).lineHeight || '16')) : 0 }
})()`)

try {
  for (const editor of ['anim', 'motion']) {
    await setup(editor)
    for (const width of [1000, 1600]) {
      await ed.send('Emulation.setDeviceMetricsOverride', { width, height: 720, deviceScaleFactor: 1, mobile: false })
      const m = {}
      for (const lang of ['ru', 'en']) {
        await ed.ev(`window.kadrEditor.useSettings.getState().setLang('${lang}')`)
        m[lang] = await measure()
      }
      check(`${editor} ${width}px: the timeline toolbar keeps its height across languages`,
        m.ru.tb === m.en.tb, `ru ${m.ru.tb} / en ${m.en.tb}`)
      check(`${editor} ${width}px: the controls hint stays on one line`,
        m.ru.hintLines <= 1 && m.en.hintLines <= 1, `ru ${m.ru.hintLines} / en ${m.en.hintLines}`)
      check(`${editor} ${width}px: the editor never scrolls sideways`,
        m.ru.over <= 0 && m.en.over <= 0, `ru ${m.ru.over}px / en ${m.en.over}px`)
    }
  }
} finally {
  await ed.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
  await ed.ev(`window.kadrEditor.useSettings.getState().setLang('${lang0}')`).catch(() => {})
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
