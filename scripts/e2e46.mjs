// Test: the fragment PREVIEW under load — what made a heavy 3D project
// (8 three.js fragments back to back) unwatchable, each point measured there:
//
//   1. every iframe imported the whole workspace registry (208 fragments,
//      380 MB of heap, 3.4 s to boot) — now only its own fragment, and a
//      broken fragment no longer takes the others down;
//   2. all iframes shared ONE renderer process (one site, 127.0.0.1), so the
//      page booting for the next cut froze the one on screen — each iframe is
//      now its own site (f<N>.localhost), i.e. its own process;
//   3. three.js drew ~100 full-size frames a second in every iframe, paused or
//      parked — now on demand, at the displayed size;
//   4. clips that continue one another in the same fragment share one iframe;
//   5. an edit reloads only the page that shows the edited fragment;
//   6. a reload of the editor page left its capture windows running.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e46 and deletes it, with the
// fragments it made. The three.js checks need three/@remotion/three/
// @react-three/fiber in the fragment workspace and SKIP without them.
import WebSocket from 'ws'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { homedir } from 'os'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e46'
const WS_DIR = process.env.KADR_FRAGMENTS_DIR || `${homedir()}/kadr-fragments`

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!page) throw new Error('editor page not found')

function connect(url) {
  const sock = new WebSocket(url, { perMessageDeflate: false })
  const ready = new Promise((r, j) => { sock.on('open', r); sock.on('error', j) })
  ready.catch(() => { /* closed before it opened: the send() that needs it reports */ })
  let id = 0
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
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return { send, ev, close: () => { try { sock.close() } catch { /* not open yet */ } } }
}
let ed = connect(page.webSocketDebuggerUrl)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = 'window.kadrEditor.useEditor.getState()'
/** a CDP connection to the fragment page (iframe or capture window) of an id */
async function pageOf(fragId, type = 'iframe', timeout = 20000) {
  const t0 = Date.now()
  for (;;) {
    const t = (await targets()).find((x) => x.type === type && x.url.includes(`comp=${fragId}`))
    if (t) return { ...connect(t.webSocketDebuggerUrl), url: t.url }
    if (Date.now() - t0 > timeout) return null
    await sleep(250)
  }
}
/** until fn() is truthy (or the time is up) */
async function until(fn, timeout = 15000, step = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > timeout) return null
    await sleep(step)
  }
}

const clipsOpen = await ed.ev(`${S}.project.tracks.reduce((n, t) => n + t.clips.length, 0)`)
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e46 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}
const has3d = ['three', '@remotion/three', '@react-three/fiber'].every((p) => existsSync(`${WS_DIR}/node_modules/${p}/package.json`))

const THREE_FRAG = (color) => `import React from 'react'
import { ThreeCanvas } from '@remotion/three'
import { useCurrentFrame } from 'remotion'
import meta from './meta.json'

const Box: React.FC = () => {
  const f = useCurrentFrame()
  return (
    <mesh rotation={[f * 0.05, f * 0.03, 0]}>
      <boxGeometry args={[1.6, 1.6, 1.6]} />
      <meshStandardMaterial color="${color}" />
    </mesh>
  )
}
const Scene: React.FC = () => (
  <ThreeCanvas width={meta.width} height={meta.height} style={{ background: '#123' }}>
    <ambientLight intensity={0.7} />
    <pointLight position={[3, 3, 3]} intensity={30} />
    <Box />
  </ThreeCanvas>
)
export const fragment = { component: Scene, meta }
`

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
let made = []
try {
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e46', width: 1280, height: 720, fps: 30, background: '#000000',
      tracks: [mk('A', 'video'), mk('B', 'video')], assets: [], markers: [], texts: [] }, null)
    await window.kadr.writeProject('${DIR}/e2e46.kadr', st().project)
    st().setProjectPath('${DIR}/e2e46.kadr')
    const a = await E.createFragment({ name: 'e2e46-a', start: 0, end: 4, transparent: false })
    const b = await E.createFragment({ name: 'e2e46-b', start: 4, end: 8, transparent: true })
    const bad = await E.createFragment({ name: 'e2e46-bad', start: 10, end: 12, transparent: true })
    const T = (n) => st().project.tracks.find((t) => t.name === n)
    st().pushHistory('hMove')
    st().moveClip(a.clipId, T('A').id, 0)
    st().moveClip(b.clipId, T('A').id, 4)
    st().moveClip(bad.clipId, T('B').id, 10)
    st().setPlayhead(1)
    return { a: a.id, b: b.id, bad: bad.id, aEntry: a.entry, badEntry: bad.entry, aClip: a.clipId, bClip: b.clipId }
  })()`)
  made = [setup.a, setup.b, setup.bad]
  if (has3d) writeFileSync(setup.aEntry, THREE_FRAG('orange'))
  writeFileSync(setup.badEntry, 'export const fragment = {{ this is not code')
  await sleep(1500)

  // ---- 1: an iframe loads its own fragment only; a broken one hurts nobody --
  const A = await pageOf(setup.a)
  check('fragment A has an iframe', !!A)
  const aState = await until(() => A.ev(`(() => {
    const names = performance.getEntriesByType('resource').map((r) => r.name)
    const ready = ${has3d ? "document.querySelector('canvas')" : "document.querySelector('#root > *')"}
    return ready ? { others: names.filter((n) => n.includes('${setup.b}') || n.includes('${setup.bad}')).length, err: !!document.querySelector('pre') } : null
  })()`))
  check('A loads none of the other fragments (not even the broken one)', aState && aState.others === 0 && !aState.err, JSON.stringify(aState))

  await ed.ev(`${S}.setPlayhead(10.5), 0`)
  const BAD = await pageOf(setup.bad)
  const badText = BAD && await until(() => BAD.ev(`document.querySelector('pre')?.innerText || null`))
  check('a broken fragment shows its own (syntax) error', !!badText && !/unknown composition/.test(badText), (badText || '').slice(0, 80))
  BAD?.close()

  // ---- 2: the next cut's page is parked in a process of its own -------------
  await ed.ev(`${S}.setPlayhead(3.2), 0`)
  const B = await pageOf(setup.b)
  await sleep(1500)
  const frames = await ed.ev(`[...document.querySelectorAll('.frag-frame')].map((f) => ({ comp: new URL(f.src).searchParams.get('comp'), host: new URL(f.src).hostname, op: Number(getComputedStyle(f).opacity) }))`)
  const fa = frames.find((f) => f.comp === setup.a), fb = frames.find((f) => f.comp === setup.b)
  check('A on screen and B parked for its cut', fa?.op === 1 && fb && fb.op <= 0.001 && fb.op > 0, JSON.stringify(frames))
  check('each iframe on a site of its own (*.localhost)', fa && fb && fa.host !== fb.host && /^f\d+\.localhost$/.test(fa.host) && /^f\d+\.localhost$/.test(fb.host), `${fa?.host} / ${fb?.host}`)
  const A2 = await pageOf(setup.a)
  const gapP = A2.ev(`new Promise((res) => { let w = 0, l = performance.now(); const t0 = l; const f = () => { const t = performance.now(); w = Math.max(w, t - l); l = t; if (t - t0 < 2200) requestAnimationFrame(f); else res(w) }; requestAnimationFrame(f) })`)
  await sleep(300)
  await B.ev(`(() => { const t = performance.now(); while (performance.now() - t < 1200) {} return 0 })()`)
  const gap = await gapP
  check('a busy page does not freeze the one on screen (separate processes)', gap < 150, `worst frame of A while B was blocked 1.2 s: ${Math.round(gap)} ms`)

  // ---- 3: 3D draws on demand, at the displayed size -------------------------
  if (has3d) {
    const DRAWS = `(ms) => new Promise((res) => { const C = WebGL2RenderingContext.prototype; const o = C.drawElements; let n = 0; C.drawElements = function (...a) { n++; return o.apply(this, a) }; setTimeout(() => { C.drawElements = o; res(n) }, ms) })`
    const paused = await A2.ev(`(${DRAWS})(1500)`)
    check('paused: the 3D fragment draws nothing', paused === 0, `${paused} draw calls in 1.5 s`)
    const movedP = A2.ev(`(${DRAWS})(1500)`)
    await sleep(200)
    await ed.ev(`${S}.setPlayhead(1.5), 0`)
    const moved = await movedP
    check('a new frame is drawn when the playhead moves', moved > 0, `${moved} draw calls`)
    const size = await A2.ev(`(() => { const c = document.querySelector('canvas'); return { w: c.width, dpr: devicePixelRatio, css: innerWidth } })()`)
    check('3D renders at the displayed size, not the composition size', Math.abs(size.w - size.css * size.dpr) <= 2 && size.w < 1280, JSON.stringify(size))
  } else {
    console.log('SKIP  three.js checks (three / @remotion/three / @react-three/fiber not installed in the workspace)')
  }

  // ---- 4: clips that continue one another share one iframe ------------------
  await ed.ev(`${S}.setPlayhead(1.9), 0`)
  await sleep(500)
  await ed.ev(`(() => { const st = ${S}; st.select(['${setup.aClip}']); st.splitAtPlayhead(); return 0 })()`)
  const split = await ed.ev(`${S}.project.tracks[0].clips.filter((c) => c.fragmentId === '${setup.a}').map((c) => [c.start, c.duration, c.inPoint])`)
  check('the clip was split into two continuing clips', split.length === 2, JSON.stringify(split))
  await sleep(500)
  await ed.ev(`(() => { const f = [...document.querySelectorAll('.frag-frame')].find((f) => f.src.includes('${setup.a}')); f.__e2eMark = 1; return 0 })()`)
  await ed.ev(`${S}.setPlayhead(2.2), 0`)
  await sleep(800)
  const same = await ed.ev(`(() => { const fs = [...document.querySelectorAll('.frag-frame')].filter((f) => f.src.includes('${setup.a}')); return { n: fs.length, marked: fs.some((f) => f.__e2eMark === 1) } })()`)
  check('across that cut the SAME iframe keeps playing', same.n === 1 && same.marked, JSON.stringify(same))

  // ---- 4b: a snapshot of a 3D fragment holds the 3D, and a contact sheet ----
  if (has3d) {
    const shot = await evalJs(`(async () => {
      const E = window.kadrEditor
      const n0 = E.useLog.getState().entries.length
      const t0 = performance.now()
      const r = await E.snapshotFrame({ t: 1.0, dir: '${DIR}', importToBin: false })
      const ms = performance.now() - t0
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = window.kadr.fileUrl(r.path)
      await img.decode()
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
      const g = c.getContext('2d'); g.drawImage(img, 0, 0)
      const px = [...g.getImageData(img.width / 2, img.height / 2, 1, 1).data]
      const warned = E.useLog.getState().entries.slice(n0).some((e) => /не успели/.test(e.msg))
      return { ms: Math.round(ms), px, warned }
    })()`)
    // the box is orange (r high, b low) at the centre; the background is #123
    check('a snapshot of a 3D fragment contains the 3D scene', shot.px[0] > 120 && shot.px[0] > shot.px[2] + 60 && !shot.warned, JSON.stringify(shot))
    const sheet = await evalJs(`window.kadrEditor.contactSheet({ times: [0.5, 1.5], dir: '${DIR}' }).then((r) => ({ n: r.frames.length, w: r.width, labels: r.frames.map((f) => f.label) }))`)
    check('a contact sheet lays out the requested frames with their times', sheet.n === 2 && sheet.labels[0].startsWith('0:00.50'), JSON.stringify(sheet))
  }

  // ---- 5: an edit reloads only the edited fragment's page -------------------
  if (has3d) {
    await ed.ev(`${S}.setPlayhead(3.2), 0`)
    await sleep(1500)
    const pa = await pageOf(setup.a), pb = await pageOf(setup.b)
    const oa = await pa.ev('performance.timeOrigin'), ob = await pb.ev('performance.timeOrigin')
    writeFileSync(setup.aEntry, THREE_FRAG('red'))
    const reloaded = await until(async () => {
      const p = await pageOf(setup.a, 'iframe', 2000)
      const o = p && await p.ev('performance.timeOrigin').catch(() => null)
      p?.close()
      return o && o !== oa ? o : null
    }, 15000, 500)
    const pb2 = await pageOf(setup.b)
    const ob2 = await pb2.ev('performance.timeOrigin').catch(() => null)
    check('the edited fragment reloads', !!reloaded)
    check('the other fragment does NOT reload', ob2 === ob, `${ob} → ${ob2}`)
    pa.close(); pb.close(); pb2.close()
  }
  A?.close(); A2?.close(); B?.close()

  // ---- 6: a reload of the editor page does not leave capture windows --------
  await evalJs(`(async () => {
    const st = ${S}
    st.pushHistory('hFx')
    st.updateClip('${setup.bClip}', { effects: [{ id: 'e2e46fx', type: 'blur', enabled: true, params: { size: 2 } }] })
    st.setPlayhead(5)
    return 0
  })()`)
  const cap = await pageOf(setup.b, 'page', 20000)
  check('an effect on the clip puts it into a capture window', !!cap)
  cap?.close()
  await window_reload()
  const left = await until(async () => !(await targets()).some((t) => t.type === 'page' && t.url.includes(`comp=${setup.b}`)), 10000, 500)
  check('after the editor page reloads, its capture window is gone', !!left)
} finally {
  // the project may be gone (page reloaded) — clean up by id
  // the project may be gone (the page reloaded): delete by id, through main
  for (const f of made) await ed.ev(`window.kadr.fragmentDelete('${f}').then(() => 1, () => 0)`).catch(() => {})
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}

async function window_reload() {
  await ed.ev('location.reload(), 0').catch(() => {})
  ed.close()
  await sleep(3000)
  const p = await until(async () => (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr'), 20000, 500)
  ed = connect(p.webSocketDebuggerUrl)
  await until(() => ed.ev('!!window.kadrEditor'), 20000, 500)
}
