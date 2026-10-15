// Test: the stylize effects (src/gl/effects/{hueShift,solarize,rgbSplit,
// posterize,vhs,grain}.fx.ts) on a STILL picture, so only the effect can move:
//   1. every one compiles and changes the frame;
//   2. the ones that move by themselves (a hue cycle, VHS, moving grain) give a
//      different frame each time, the others the same frame throughout.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e62 and deletes it.
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
  console.log(`SKIP  e2e62 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e62'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=0.04:r=25', '-frames:v', '1', `${DIR}/still.png`])
execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', `${DIR}/still.png`, '-t', '1', '-r', '30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${DIR}/src.mp4`])
const E = 'window.kadrEditor'
const frames = (type, params) => evalJs(`(async () => {
  const ed = ${E}, st = () => ed.useEditor.getState()
  const c = st().project.tracks[0].clips[0]
  st().updateClip(c.id, { effects: [] })
  if (${JSON.stringify(type)}) ed.effects.add(c.id, ${JSON.stringify(type)}, ${JSON.stringify(params ?? {})})
  globalThis.KADR_FRAME_HASH = []
  await ed.startExport(st().project, ed.PRESETS.find((q) => q.id === 'source'), '${DIR}/f.mp4', () => {}, { start: 0.2, end: 0.5 }, {}).done
  const h = globalThis.KADR_FRAME_HASH; globalThis.KADR_FRAME_HASH = null
  return { h, error: ${JSON.stringify(type)} ? ed.useEffects.getState().errors[${JSON.stringify(type)}] : undefined }
})()`)

try {
  await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e62', width: 320, height: 180, fps: 30, background: '#000000', assets: [], texts: [],
      tracks: [{ id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 }] }, null)
    const { asset } = await window.kadr.probeMedia('${DIR}/src.mp4')
    const id = ed.uid(); st().addAsset({ id, ...asset }); st().insertClipFromAsset(id, 'v1', 0)
    return 1
  })()`)
  const plain = (await frames(null)).h
  check('the still source gives one frame throughout', new Set(plain).size === 1)
  const cases = [
    ['hueShift', { degrees: 90 }, false],
    ['hueShift', { degrees: 0, speed: 180 }, true],
    ['solarize', {}, false],
    ['rgbSplit', {}, false],
    ['posterize', { levels: 3 }, false],
    ['vhs', {}, true],
    ['grain', {}, true],
    ['grain', { animated: 0 }, false]
  ]
  for (const [type, params, moves] of cases) {
    const { h, error } = await frames(type, params)
    const label = `${type} ${JSON.stringify(params)}`
    check(`${label} compiles and changes the frame`, !error && h.some((x) => x !== plain[0]), error)
    check(`${label} ${moves ? 'moves by itself' : 'holds still'}`,
      moves ? new Set(h).size > h.length / 2 : new Set(h).size === 1, `${new Set(h).size} distinct of ${h.length}`)
  }
} finally {
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
