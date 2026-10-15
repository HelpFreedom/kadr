// Test: the colour grade effect (src/gl/effects/grade.fx.ts) on flat colours,
// read back from exported frames (x264 costs a few levels, hence the slack):
//   1. added with its defaults it changes nothing;
//   2. each control moves the colour the way its name says.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e60 and deletes it.
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
  console.log(`SKIP  e2e60 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e60'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
const E = 'window.kadrEditor'
// a flat colour clip, graded with `params`; returns the RGB at the frame centre
async function graded(hex, params) {
  const src = `${DIR}/${hex}.mp4`
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x${hex}:s=160x90:d=0.5:r=30`,
    '-c:v', 'libx264', '-qp', '0', '-pix_fmt', 'yuv444p', src])
  await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e60', width: 160, height: 90, fps: 30, background: '#000000',
      assets: [], texts: [], tracks: [{ id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 }] }, null)
    const { asset } = await window.kadr.probeMedia('${src}')
    const id = ed.uid(); st().addAsset({ id, ...asset })
    st().insertClipFromAsset(id, 'v1', 0)
    const clip = st().project.tracks[0].clips[0].id
    if (${JSON.stringify(params)}) ed.effects.add(clip, 'grade', ${JSON.stringify(params ?? {})})
    await ed.startExport(st().project, ed.PRESETS.find((q) => q.id === 'source'), '${DIR}/out.mp4', () => {},
      { start: 0.1, end: 0.3 }, {}).done
    return 1
  })()`)
  const px = execFileSync('ffmpeg', ['-v', 'error', '-i', `${DIR}/out.mp4`, '-frames:v', '1',
    '-vf', 'crop=2:2:79:44,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'])
  return [...px]
}
const near = (a, b, tol = 6) => a.every((v, i) => Math.abs(v - b[i]) <= tol)

try {
  const plain = await graded('808080', null)
  check('the source reads as mid grey', near(plain, [128, 128, 128]), plain.join())
  const neutral = await graded('808080', {})
  check('with its defaults the grade changes nothing', near(neutral, plain, 2), neutral.join())
  const brighter = await graded('404040', { exposure: 1 })
  check('exposure +1 doubles the light', near(brighter, [128, 128, 128]), brighter.join())
  const warm = await graded('808080', { temperature: 1 })
  check('temperature +1 warms: more red, less blue', warm[0] > plain[0] + 20 && warm[2] < plain[2] - 20, warm.join())
  const magenta = await graded('808080', { tint: 1 })
  check('tint +1 takes green out', magenta[1] < plain[1] - 20 && near([magenta[0], magenta[2]], [plain[0], plain[2]], 4), magenta.join())
  const grey = await graded('c04020', { saturation: 0 })
  check('saturation 0 gives grey', Math.max(...grey) - Math.min(...grey) <= 4, grey.join())
  const hard = await graded('606060', { contrast: 2 })
  check('contrast 2 pushes a dark grey darker', hard[0] < 96 - 20, hard.join())
  const lifted = await graded('000000', { lift: 0.2 })
  check('black level 0.2 lifts black', near(lifted, [51, 51, 51]), lifted.join())
  const mids = await graded('404040', { gamma: 2 })
  check('gamma 2 brightens the mids', mids[0] > 110, mids.join())
} finally {
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
