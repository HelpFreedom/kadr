// Test: numeric effect params animate like the transform.
//   1. an old project with bare numbers loads as Anims (setProject sanitizes);
//   2. a keyed param changes the picture over time on a still source, a static
//      one does not;
//   3. the motion-blur shutter stays exact: collapsing it gives the same frames
//      as the full 8 samples while a param animates;
//   4. splitting the clip and changing its speed move the keys with it;
//   5. the Inspector: an edit on a keyed param sets a key at the playhead, and
//      the key button adds and removes one;
//   6. the animation editor has an «Эффекты» mode with a lane of its keys.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e58 and deletes it.
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
  console.log(`SKIP  e2e58 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e58'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
// a STILL picture as a 2 s video: only the effect can change between frames
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=0.04:r=25', '-frames:v', '1', `${DIR}/still.png`])
execFileSync('ffmpeg', ['-v', 'error', '-y', '-loop', '1', '-i', `${DIR}/still.png`, '-t', '2', '-r', '30',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', `${DIR}/src.mp4`])
const E = 'window.kadrEditor'
const hashes = (start, end, opts = '{}', full = false) => evalJs(`(async () => {
  const ed = ${E}
  globalThis.KADR_FRAME_HASH = []
  globalThis.KADR_FORCE_FULL_SHUTTER = ${full}
  await ed.startExport(ed.useEditor.getState().project, ed.PRESETS.find((q) => q.id === 'source'),
    '${DIR}/f.mp4', () => {}, { start: ${start}, end: ${end} }, ${opts}).done
  const h = globalThis.KADR_FRAME_HASH; globalThis.KADR_FRAME_HASH = null; globalThis.KADR_FORCE_FULL_SHUTTER = false
  return h
})()`)
const clip = () => evalJs(`${S}.project.tracks[0].clips[0]`)

try {
  // 1. an old project with bare numbers
  const loaded = await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    const { asset } = await window.kadr.probeMedia('${DIR}/src.mp4')
    const aid = ed.uid()
    const c = { ...ed.newClipDefaults(), id: 'c1', assetId: aid, kind: 'media', label: 's', start: 0, inPoint: 0, duration: 2, speed: 1,
      effects: [{ id: 'b', type: 'blur', enabled: true, params: { size: 0 } }] }
    st().setProject({ name: 'e2e58', width: 320, height: 180, fps: 30, background: '#000000',
      assets: [{ id: aid, ...asset }], texts: [], tracks: [{ id: 'v1', name: 'V1', kind: 'video', clips: [c], gain: 1 }] }, null)
    return st().project.tracks[0].clips[0].effects[0].params.size
  })()`)
  check('an old numeric param loads as an Anim', loaded && loaded.value === 0, JSON.stringify(loaded))

  // 2. keyed vs static
  const still = await hashes(0.2, 1.8)
  check('a static effect gives the same frame at every time', new Set(still).size === 1, `${new Set(still).size} distinct`)
  await evalJs(`(async () => { ${E}.effects.set('c1', 'b', { params: { size: { value: 0, keyframes: [
    { time: 0, value: 0, easing: 'linear' }, { time: 2, value: 40, easing: 'linear' }] } } }); return 1 })()`)
  const keyed = await hashes(0.2, 1.8)
  check('a keyed param changes the frame over time', new Set(keyed).size > keyed.length / 2, `${new Set(keyed).size} of ${keyed.length} distinct`)

  // 3. the shutter
  const collapsed = await hashes(0.4, 0.8, '{ motionBlur: true }')
  const full = await hashes(0.4, 0.8, '{ motionBlur: true }', true)
  check('motion blur: collapsed and full shutters agree while a param animates',
    collapsed.length > 0 && collapsed.join() === full.join(), `${collapsed.length} frames`)

  // 4. split and speed
  const moved = await evalJs(`(async () => {
    const st = () => ${E}.useEditor.getState()
    st().setPlayhead(1); st().select(['c1']); st().splitAtPlayhead()
    const clips = st().project.tracks[0].clips.slice().sort((a, b) => a.start - b.start)
    const right = clips[1]
    const rightKeys = right.effects[0].params.size.keyframes.map((k) => +k.time.toFixed(3))
    st().setClipSpeed(clips[0].id, 2, 0.5)
    const leftKeys = st().project.tracks[0].clips.find((c) => c.id === clips[0].id).effects[0].params.size.keyframes.map((k) => +k.time.toFixed(3))
    return { rightKeys, leftKeys }
  })()`)
  check('a split shifts the keys of the right half', moved.rightKeys.join() === '-1,1', JSON.stringify(moved.rightKeys))
  check('a speed change rescales the keys', moved.leftKeys.join() === '0,1', JSON.stringify(moved.leftKeys))

  // 5. the Inspector, on a fresh clip with a static blur
  const insp = await evalJs(`(async () => {
    const ed = ${E}, st = () => ed.useEditor.getState()
    const tick = () => new Promise((r) => setTimeout(r, 250))
    const p = st().project
    const base = p.tracks[0].clips[0]
    const c = { ...base, id: 'c2', start: 0, duration: 2, inPoint: 0, speed: 1,
      effects: [{ id: 'b2', type: 'blur', enabled: true, params: { size: { value: 5 } } }] }
    st().setProject({ ...p, tracks: [{ ...p.tracks[0], clips: [c] }] }, null)
    st().select(['c2']); st().setPlayhead(0.5); await tick()
    const kf = () => document.querySelector('[data-fx="blur"] [data-act="fx-kf"]')
    kf().click(); await tick()
    const size = () => st().project.tracks[0].clips[0].effects[0].params.size
    const afterAdd = (size().keyframes || []).map((k) => k.time)
    st().setPlayhead(1.5); await tick()
    const range = document.querySelector('[data-fx="blur"] input[type="range"]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(range, '30'); range.dispatchEvent(new Event('input', { bubbles: true })); await tick()
    const afterEdit = size().keyframes.map((k) => [k.time, k.value])
    const pressed = kf().getAttribute('aria-pressed')
    kf().click(); await tick()
    const afterRemove = (size().keyframes || []).map((k) => k.time)
    return { afterAdd, afterEdit, pressed, afterRemove }
  })()`)
  check('the key button adds a key at the playhead', insp.afterAdd.join() === '0.5', JSON.stringify(insp.afterAdd))
  check('an edit on a keyed param keys the playhead and keeps the curve',
    insp.afterEdit.length === 2 && insp.afterEdit[1][0] === 1.5 && insp.afterEdit[1][1] === 30, JSON.stringify(insp.afterEdit))
  check('the key button shows the key under the playhead', insp.pressed === 'true')
  check('pressing it again removes that key', insp.afterRemove.join() === '0.5', JSON.stringify(insp.afterRemove))

  // 6. the animation editor
  const anim = await evalJs(`(async () => {
    const st = () => ${E}.useEditor.getState()
    const tick = () => new Promise((r) => setTimeout(r, 300))
    st().setAnimClip('c2'); await tick()
    document.querySelector('[data-act="anim-effects"]').click(); await tick()
    const fields = [...document.querySelectorAll('.anim-values label span')].map((s) => s.textContent)
    const lanes = [...document.querySelectorAll('.mini-row')].map((r) => [r.querySelector('.mini-label').textContent, r.querySelectorAll('.mini-kf').length])
    st().setAnimClip(null)
    return { fields, lanes }
  })()`)
  check('the Effects mode lists the effect params', anim.fields.length === 1 && /·/.test(anim.fields[0]), JSON.stringify(anim.fields))
  check('its lane shows the keys', anim.lanes.some(([, n]) => n === 1) && anim.lanes.length === 3, JSON.stringify(anim.lanes))
} finally {
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
