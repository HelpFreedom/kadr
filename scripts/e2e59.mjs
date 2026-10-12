// Test: an effect written as a file in the project library works without a
// rebuild — the way an agent adds one mid-session.
//   1. a saved project gets kadr-lib/effects; an unsaved one has none;
//   2. a .glsl dropped there shows up as lib:<name> and renders;
//   3. editing the file re-renders with the new shader;
//   4. a shader that does not compile is skipped, and its error is shown;
//      fixed, it works again;
//   5. a file with a bad header is listed with its reason, never as an effect.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e59 and deletes it.
import WebSocket from 'ws'
import { rmSync, mkdirSync, writeFileSync, existsSync } from 'fs'
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
  console.log(`SKIP  e2e59 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e59'
const FX = `${DIR}/kadr-lib/effects`
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=1:r=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${DIR}/src.mp4`])
const E = 'window.kadrEditor'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const effectFile = (body, params = '{}') => `/* kadr-effect\n{ "name": { "ru": "Тест", "en": "Test" }, "group": "color", "params": ${params} }\n*/\n${body}\n`
const frames = () => evalJs(`(async () => {
  const ed = ${E}
  globalThis.KADR_FRAME_HASH = []
  await ed.startExport(ed.useEditor.getState().project, ed.PRESETS.find((q) => q.id === 'source'),
    '${DIR}/f.mp4', () => {}, { start: 0.3, end: 0.44 }, {}).done
  const h = globalThis.KADR_FRAME_HASH.join(); globalThis.KADR_FRAME_HASH = null
  return h
})()`)
// poll the registry until `pred` holds (the watcher debounces 150 ms)
const until = async (pred, what) => {
  for (let i = 0; i < 40; i++) {
    const r = await evalJs(`(async () => ({ list: ${E}.effects.list(), lib: ${E}.effects.library() }))()`)
    if (pred(r)) return r
    await sleep(150)
  }
  throw new Error(`timed out waiting for ${what}`)
}

try {
  const unsaved = await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e59', width: 320, height: 180, fps: 30, background: '#000000',
      assets: [], texts: [], tracks: [{ id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 }] }, null)
    await ed.refreshEffectsLibrary()
    return ed.effects.library().dir
  })()`)
  check('an unsaved project has no effect folder', unsaved === null, String(unsaved))

  await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    const { asset } = await window.kadr.probeMedia('${DIR}/src.mp4')
    const id = ed.uid(); st().addAsset({ id, ...asset }); st().insertClipFromAsset(id, 'v1', 0)
    await window.kadr.writeProject('${DIR}/p.kadr', st().project)
    await ed.openProject('${DIR}/p.kadr')
    return 1
  })()`)
  const saved = await until((r) => !!r.lib.dir, 'the effect folder')
  check('a saved project gets kadr-lib/effects', saved.lib.dir === FX && existsSync(FX), saved.lib.dir)

  const plain = await frames()
  writeFileSync(`${FX}/invert.glsl`, effectFile('vec4 effect(vec4 c, vec2 uv) { return vec4(1.0 - c.rgb, c.a); }'))
  const listed = await until((r) => r.list.some((d) => d.id === 'lib:invert'), 'lib:invert')
  const def = listed.list.find((d) => d.id === 'lib:invert')
  check('a dropped file becomes lib:<name>', def.source === 'library' && def.file === 'invert.glsl', JSON.stringify(def.name))
  await evalJs(`(async () => { const c = ${S}.project.tracks[0].clips[0]; ${E}.effects.add(c.id, 'lib:invert'); return 1 })()`)
  const inverted = await frames()
  check('it renders', inverted !== plain)

  writeFileSync(`${FX}/invert.glsl`, effectFile('vec4 effect(vec4 c, vec2 uv) { return vec4(c.bgr, c.a); }'))
  await until((r) => true, 'reload')
  await sleep(600)
  const swapped = await frames()
  check('an edited file re-renders with the new shader', swapped !== inverted && swapped !== plain)

  writeFileSync(`${FX}/invert.glsl`, effectFile('vec4 effect(vec4 c, vec2 uv) { return c.rgbx; }'))
  await sleep(600)
  const broken = await frames()
  const err = (await until((r) => !!r.list.find((d) => d.id === 'lib:invert')?.error, 'the compile error')).list.find((d) => d.id === 'lib:invert').error
  check('a shader that does not compile is skipped', broken === plain)
  check('its error is reported in the effect\'s own lines', /shader/.test(err) && /line 1:/.test(err), err.split('\n')[0])

  writeFileSync(`${FX}/invert.glsl`, effectFile('vec4 effect(vec4 c, vec2 uv) { return vec4(1.0 - c.rgb, c.a); }'))
  await until((r) => !r.list.find((d) => d.id === 'lib:invert')?.error, 'the error to clear')
  await sleep(300)
  check('fixed, it works again', (await frames()) === inverted)

  writeFileSync(`${FX}/bad.glsl`, '/* kadr-effect { nope */\nvec4 effect(vec4 c, vec2 uv) { return c; }\n')
  const issues = await until((r) => r.lib.issues.some((f) => f.file === 'bad.glsl'), 'the bad file')
  check('a bad header is listed with its reason', /JSON/.test(issues.lib.issues.find((f) => f.file === 'bad.glsl').error))
  check('…and is not an effect', !issues.list.some((d) => d.id === 'lib:bad'))
} finally {
  await evalJs(`(async () => { ${E}.useEditor.getState().setProject({ name: 'empty', width: 1920, height: 1080, fps: 30, background: '#000000', assets: [], texts: [], tracks: [] }, null); await ${E}.refreshEffectsLibrary(); return 1 })()`).catch(() => {})
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
