// Test: per-clip effects come from one registry (src/gl/effects/*.fx.ts) and
// reach people and agents the same way.
//   1. the catalogue: glow and blur are registered with their params;
//   2. the agent API (kadrEditor.effects): add / set / move / remove, one undo
//      step each;
//   3. the Inspector: «Добавить эффект» lists the effects by group, a pick adds
//      one, a block is generated per effect and can be moved up;
//   4. rendering: an effect changes the frame, switching it off restores it, and
//      an effect type this build does not know is kept and skipped.
// Glow and blur were moved onto the registry without changing a pixel: a
// glow + blur + motion-blur export gave the same 35 frame hashes as before.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e57 and deletes it.
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
  console.log(`SKIP  e2e57 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e57'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=1:r=30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${DIR}/src.mp4`])
const E = 'window.kadrEditor'
// hashes of a few exported frames around 0.5 s (the last frame of a range is not
// hashed): the same drawFrame as preview and export
const frameHash = () => evalJs(`(async () => {
  const ed = ${E}
  globalThis.KADR_FRAME_HASH = []
  await ed.startExport(ed.useEditor.getState().project, ed.PRESETS.find((q) => q.id === 'source'),
    '${DIR}/f.mp4', () => {}, { start: 0.5, end: 0.64 }, {}).done
  const h = globalThis.KADR_FRAME_HASH.join(','); globalThis.KADR_FRAME_HASH = null
  return h
})()`)

try {
  const clipId = await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e57', width: 320, height: 180, fps: 30, background: '#000000',
      assets: [], texts: [], tracks: [{ id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 }] }, null)
    const { asset } = await window.kadr.probeMedia('${DIR}/src.mp4')
    const id = ed.uid(); st().addAsset({ id, ...asset }); st().insertClipFromAsset(id, 'v1', 0)
    return st().project.tracks[0].clips[0].id
  })()`)

  // 1. the catalogue
  const list = await evalJs(`${E}.effects.list()`)
  const byId = Object.fromEntries(list.map((d) => [d.id, d]))
  check('glow and blur are in the catalogue', !!byId.glow && !!byId.blur, list.map((d) => d.id).join(','))
  check('params come with kind, range and default',
    byId.blur?.params.size?.kind === 'number' && byId.blur.params.size.max === 300 && byId.glow?.params.color?.default === '#7fc4ff')

  // 2. the agent API
  const plain = await frameHash()
  const api = await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState(), fx = ed.effects
    const h0 = st().past.length
    const b = fx.add('${clipId}', 'blur', { size: 6 })
    const g = fx.add('${clipId}', 'glow')
    fx.set('${clipId}', b, { params: { size: 9 } })
    fx.move('${clipId}', g, 0)
    const clip = () => st().project.tracks[0].clips[0]
    const order = clip().effects.map((e) => e.type)
    const size = clip().effects.find((e) => e.id === b).params.size
    const glowDefaults = clip().effects.find((e) => e.id === g).params.smoke
    let unknown = ''
    try { fx.add('${clipId}', 'nope') } catch (e) { unknown = String(e.message) }
    fx.remove('${clipId}', g)
    return { steps: st().past.length - h0, order, size, glowDefaults, unknown, left: clip().effects.map((e) => e.type) }
  })()`)
  check('add / set / move / remove work', api.order.join() === 'glow,blur' && api.size === 9 && api.left.join() === 'blur',
    JSON.stringify(api))
  check('an added effect gets its declared defaults', api.glowDefaults === 0.65)
  check('each API call is one undo step', api.steps === 5, `${api.steps}`)
  check('an unknown type is refused with the list of known ones', /nope/.test(api.unknown) && /blur/.test(api.unknown), api.unknown)

  // 4. rendering
  const blurred = await frameHash()
  check('an effect changes the frame', blurred && blurred !== plain, `${plain} → ${blurred}`)
  await evalJs(`(async () => { const fx = ${E}.effects, st = () => ${E}.useEditor.getState()
    const e = st().project.tracks[0].clips[0].effects[0]; fx.set('${clipId}', e.id, { enabled: false }); return 1 })()`)
  check('switching it off restores the frame', (await frameHash()) === plain)
  await evalJs(`(async () => { const st = () => ${E}.useEditor.getState(), c = st().project.tracks[0].clips[0]
    st().updateClip(c.id, { effects: [{ id: 'x', type: 'from-a-newer-kadr', enabled: true, params: { a: 1 } }] }); return 1 })()`)
  check('an unknown effect type is kept and skipped', (await frameHash()) === plain)

  // 3. the Inspector
  const ui = await evalJs(`(async () => {
    const st = () => ${E}.useEditor.getState(), c = () => st().project.tracks[0].clips[0]
    const tick = () => new Promise((r) => setTimeout(r, 250))
    st().select([c().id]); await tick()
    const unknownShown = !!document.querySelector('[data-fx="from-a-newer-kadr"]')
    st().updateClip(c().id, { effects: [] }); await tick()
    document.querySelector('[data-act="fx-add"]').click(); await tick()
    const groups = [...document.querySelectorAll('.fx-add-menu [role="group"]')].map((g) => g.getAttribute('aria-label'))
    document.querySelector('[data-act="add-blur"]').click(); await tick()
    document.querySelector('[data-act="fx-add"]').click(); await tick()
    document.querySelector('[data-act="add-glow"]').click(); await tick()
    const blocks = () => [...document.querySelectorAll('.fx-block')].map((b) => b.getAttribute('data-fx'))
    const before = blocks()
    const sliders = document.querySelectorAll('[data-fx="glow"] input[type="range"]').length
    document.querySelector('[data-fx="glow"] [data-act="fx-up"]').click(); await tick()
    return { unknownShown, groups, before, after: blocks(), model: c().effects.map((e) => e.type), sliders }
  })()`)
  check('an unknown effect still shows its block', ui.unknownShown)
  check('the Add menu groups effects', ui.groups.length >= 2, ui.groups.join(' | '))
  check('picking from the menu adds the effect, one block each', ui.before.join() === 'blur,glow', ui.before.join())
  check('blocks are generated from the params', ui.sliders === 6, `${ui.sliders} sliders for glow`)
  check('moving a block up reorders the chain', ui.after.join() === 'glow,blur' && ui.model.join() === 'glow,blur', ui.model.join())
} finally {
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
