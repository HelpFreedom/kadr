// Test: fragment parameters (defineParams / useParams in @kadr/runtime) —
// what a 3D project had to tune by editing constants and waiting for a reload:
//
//   1. the Inspector of a selected fragment clip lists what the fragment
//      declares (number with a range, colour, switch);
//   2. a slider moves the preview LIVE: same page (no reload), new picture —
//      a demand-drawn 3D canvas included (it must be asked to redraw);
//   3. letting go writes params.json; the page takes the file without a reload;
//   4. an edit of params.json by hand reaches the page (the file wins);
//   5. a pixel-capture window gets the live values too;
//   6. the render reads params.json (the box is as wide as dialled in);
//   7. «reset» empties the file and the page is back at the defaults;
//   8. the onion skin: the footage under a fragment, over the preview, on the
//      clip's own source time, translucent or in difference mode, never
//      taking the mouse; selecting the fragment does not steal it; deleting
//      the footage takes it down.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e50 and deletes it, with the
// fragments and renders it made.
import WebSocket from 'ws'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e50'

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!page) throw new Error('editor page not found')

function connect(url) {
  const sock = new WebSocket(url, { perMessageDeflate: false })
  const ready = new Promise((r, j) => { sock.on('open', r); sock.on('error', j) })
  ready.catch(() => { /* closed before it opened: the send() that needs it reports */ })
  let id = 0
  let closed = false
  sock.setMaxListeners(0)
  sock.on('close', () => { closed = true })
  const send = async (method, params = {}) => {
    await ready
    if (closed) throw new Error('target gone')
    return new Promise((resolve, reject) => {
      sock.once('close', () => reject(new Error('target gone')))
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = 'window.kadrEditor.useEditor.getState()'
async function pageOf(fragId, type = 'iframe', timeout = 20000) {
  const t0 = Date.now()
  for (;;) {
    const t = (await targets()).find((x) => x.type === type && x.url.includes(`comp=${fragId}`))
    if (t) return { ...connect(t.webSocketDebuggerUrl), url: t.url }
    if (Date.now() - t0 > timeout) return null
    await sleep(250)
  }
}
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
  console.log(`SKIP  e2e50 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

// A box as wide as `size`, coloured `tint`, a word for `on`; and a demand-drawn
// 3D canvas that counts its own renders (useFrame runs once per drawn frame).
const FRAG = `import React from 'react'
import { AbsoluteFill } from 'remotion'
import { ThreeCanvas } from '@remotion/three'
import { useFrame } from '@react-three/fiber'
import { defineParams, useParams } from '@kadr/runtime'
import meta from './meta.json'

const P = defineParams({
  size: { value: 100, min: 10, max: 400, step: 1, label: 'Ширина' },
  tint: { value: '#ff0000', label: 'Цвет' },
  on: { value: true, label: 'Надпись' }
})

const Count: React.FC = () => { useFrame(() => { (window as any).__renders = ((window as any).__renders ?? 0) + 1 }); return null }

const F: React.FC = () => {
  const p = useParams(P)
  return (
    <AbsoluteFill style={{ background: '#000' }}>
      <div id="box" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: p.size, background: p.tint }} />
      <div id="word" style={{ position: 'absolute', right: 10, top: 10, color: '#fff', fontSize: 30 }}>{p.on ? 'ON' : 'OFF'}</div>
      <ThreeCanvas width={64} height={64} style={{ position: 'absolute', right: 0, bottom: 0 }}>
        <mesh scale={p.size / 100}><boxGeometry /><meshBasicMaterial color={p.tint} /></mesh>
        <Count />
      </ThreeCanvas>
    </AbsoluteFill>
  )
}
export const fragment = { component: F, meta }
`

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
let made = []
const renders = []
try {
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e50', width: 640, height: 360, fps: 30, background: '#000000',
      tracks: [mk('A', 'video'), mk('B', 'video')], assets: [], markers: [], texts: [] }, null)
    await window.kadr.writeProject('${DIR}/e2e50.kadr', st().project)
    st().setProjectPath('${DIR}/e2e50.kadr')
    const a = await E.createFragment({ name: 'e2e50-a', start: 0, end: 1, transparent: false })
    st().setPlayhead(0.5)
    return { a: a.id, clip: a.clipId, entry: a.entry }
  })()`)
  made = [setup.a]
  const PJ = setup.entry.replace(/index\.tsx$/, 'params.json')
  writeFileSync(setup.entry, FRAG)
  await sleep(1500)

  // ---- 1: the Inspector lists the declarations ------------------------------
  await ed.ev(`${S}.select(['${setup.clip}'])`)
  const listed = await until(() => ed.ev(`(() => {
    const els = [...document.querySelectorAll('[data-param]')]
    return els.length ? els.map((e) => [e.dataset.param, e.querySelector('input').type]) : null
  })()`), 30000)
  check('the Inspector shows the declared parameters', JSON.stringify(listed) === JSON.stringify([['size', 'range'], ['tint', 'color'], ['on', 'checkbox']]),
    JSON.stringify(listed))

  let A = await pageOf(setup.a)
  if (!A) {
    console.log('DEBUG', await ed.ev(`JSON.stringify({ frames: [...document.querySelectorAll('iframe')].map((f) => f.src), clips: ${S}.project.tracks.map((t) => t.clips.map((c) => [c.start, c.duration, c.fragmentId])), ph: ${S}.playhead })`),
      JSON.stringify((await targets()).map((t) => [t.type, t.url])))
    throw new Error('no fragment page')
  }
  const boxW = () => A.ev(`(() => { const b = document.querySelector('#box'); return b ? Math.round(parseFloat(b.style.width)) : null })()`)
  await until(boxW, 20000)
  const origin = await A.ev('performance.timeOrigin')
  const w0 = await boxW()
  check('defaults before anything is set', w0 === 100, `width ${w0}`)

  // ---- 2: a slider moves the preview live -----------------------------------
  await until(() => A.ev('window.__renders > 0'), 10000)
  const r0 = await A.ev('window.__renders')
  await sleep(700) // paused, on demand: nothing more should be drawing now
  const rIdle = await A.ev('window.__renders')
  // through the real control: React's onChange needs the native setter + 'input'
  await ed.ev(`(() => {
    const el = document.querySelector('[data-param="size"] input[type=range]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '250')
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  const w1 = await until(async () => ((await boxW()) === 250 ? 250 : null), 5000, 100)
  check('the slider moves the preview live', w1 === 250, `width ${await boxW()}`)
  check('…without reloading the page', (await A.ev('performance.timeOrigin')) === origin)
  const r1 = await until(async () => { const n = await A.ev('window.__renders'); return n > rIdle ? n : null }, 3000, 100)
  check('the demand-drawn 3D canvas redraws for a parameter (paused)', !!r1, `renders ${r0} → idle ${rIdle} → ${r1}`)
  check('…and was idle before it', rIdle - r0 <= 3, `${rIdle - r0} renders while idle`)
  await ed.ev(`window.kadrEditor.setParam('${setup.a}', 'on', false)`)
  const word = await until(async () => ((await A.ev(`document.querySelector('#word')?.textContent`)) === 'OFF' ? 'OFF' : null), 5000, 100)
  check('a switch parameter, through the API', word === 'OFF')

  // ---- 3: let go → params.json, the page keeps its values, no reload -------
  const saved = await until(async () => {
    if (!existsSync(PJ)) return null
    const j = JSON.parse(readFileSync(PJ, 'utf8'))
    return j.size === 250 && j.on === false ? j : null
  }, 5000, 100)
  check('the values are saved into params.json', !!saved, JSON.stringify(saved))
  await sleep(2600) // past the moment live values are handed over to the file
  check('after the save the page still shows them — from the file now',
    (await boxW()) === 250 && (await A.ev(`JSON.stringify(window.__kadrParams.saved.size)`)) === '250' &&
      (await ed.ev(`JSON.stringify(window.kadrEditor.useFragmentParams.getState().live['${setup.a}'] ?? {})`)) === '{}',
    `width ${await boxW()}, saved ${await A.ev(`JSON.stringify(window.__kadrParams.saved)`)}`)
  check('…and the page was never reloaded', (await A.ev('performance.timeOrigin')) === origin)

  // ---- 4: params.json edited by hand reaches the page ------------------------
  writeFileSync(PJ, JSON.stringify({ size: 60, tint: '#00ff00', on: true }))
  const w2 = await until(async () => ((await boxW()) === 60 ? 60 : null), 8000, 100)
  check('an edit of params.json by hand reaches the page', w2 === 60, `width ${await boxW()}`)
  check('…without a reload', (await A.ev('performance.timeOrigin')) === origin)

  // ---- 5: a capture window gets the live values -----------------------------
  await ed.ev(`${S}.updateClip('${setup.clip}', { effects: [{ id: 'fx1', type: 'blur', enabled: true, params: { size: 2 } }] })`)
  const C = await pageOf(setup.a, 'page', 20000)
  const capW = () => C.ev(`(() => { const b = document.querySelector('#box'); return b ? Math.round(parseFloat(b.style.width)) : null })()`)
  const c0 = C && await until(capW, 20000)
  check('a capture window starts with the file\'s values', c0 === 60, `width ${c0}`)
  await ed.ev(`window.kadrEditor.setParam('${setup.a}', 'size', 333)`)
  const c1 = C && await until(async () => ((await capW()) === 333 ? 333 : null), 5000, 100)
  check('a capture window follows a live value', c1 === 333, `width ${C && await capW()}`)
  C?.close()
  await ed.ev(`${S}.updateClip('${setup.clip}', { effects: [] })`)
  // the clip went through capture, so its iframe was taken down: a new one now
  A.close()
  await sleep(500)
  A = await pageOf(setup.a)
  await until(boxW, 20000)

  // ---- 6: the render reads params.json ---------------------------------------
  await evalJs('window.kadrEditor.flushParamSaves()')
  const j6 = JSON.parse(readFileSync(PJ, 'utf8'))
  check('flushParamSaves writes what was pending', j6.size === 333, JSON.stringify(j6))
  const r = await evalJs(`window.kadr.fragmentRender('${setup.a}')`, 600000)
  renders.push(r.path)
  const meta = JSON.parse(readFileSync(setup.entry.replace(/index\.tsx$/, 'meta.json'), 'utf8'))
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', r.path, '-vf', 'select=eq(n\\,5)', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'],
    { maxBuffer: 64 << 20 })
  // along the middle row (above the little 3D canvas): where the green box ends
  const y = Math.round(meta.height * 0.25)
  let edge = -1
  for (let x = 0; x < meta.width; x++) {
    const i = (y * meta.width + x) * 3
    if (raw[i + 1] < 128) { edge = x; break }
  }
  const want = 333 // composition pixels (the fragment is at project size)
  check('the render uses the saved values (box width and colour)', Math.abs(edge - want) <= 2 && raw[(y * meta.width + 10) * 3 + 1] > 200,
    `edge at ${edge}, want ${want}; ${meta.width}×${meta.height}`)

  // ---- 7: reset → defaults ---------------------------------------------------
  await evalJs(`window.kadrEditor.resetParams('${setup.a}')`)
  check('reset empties params.json', readFileSync(PJ, 'utf8').trim() === '{}')
  const w7 = await until(async () => ((await boxW()) === 100 ? 100 : null), 8000, 100)
  check('…and the page is back at the declared defaults', w7 === 100, `width ${await boxW()}`)

  // ---- inspect carries the declarations -------------------------------------
  const ins = await evalJs(`window.kadr.fragmentInspect('${setup.a}')`)
  check('fragment:inspect reports the declarations', ins.ok && ins.params?.size?.min === 10 && ins.params?.tint?.value === '#ff0000' &&
    ins.params?.on?.value === true, JSON.stringify(ins.params))

  // ---- 8: the onion skin ------------------------------------------------------
  // 3 s of numbered frames; the clip starts 0.5 s into the source (inPoint)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30:duration=3',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', `${DIR}/foot.mp4`])
  const foot = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    await E.importFiles(['${DIR}/foot.mp4'])
    const a = st().project.assets.find((x) => x.path.endsWith('foot.mp4'))
    const B = st().project.tracks.find((t) => t.name === 'B')
    st().insertClipsFromAssets([a.id], B.id, 0)
    const c = B && st().project.tracks.find((t) => t.name === 'B').clips[0]
    st().updateClip(c.id, { inPoint: 0.5, duration: 2 })
    st().select(['${setup.clip}'])
    st().setPlayhead(1)
    return { clip: c.id }
  })()`)
  // the user's own opacity/difference are a per-viewer preference: put them back after
  const onionPrefs = await ed.ev(`(() => { const o = window.kadrEditor.useOnion.getState(); return { opacity: o.opacity, diff: o.diff } })()`)
  await ed.ev(`document.querySelector('[data-act="onion"]').click()`)
  const onion = await until(() => ed.ev(`(() => {
    const v = document.querySelector('.onion-skin'); if (!v || v.readyState < 2 || v.seeking) return null
    const cs = getComputedStyle(v)
    return { id: v.dataset.onion, t: v.currentTime, op: cs.opacity, pe: cs.pointerEvents, blend: cs.mixBlendMode, z: Number(cs.zIndex) }
  })()`), 10000, 100)
  check('the onion shows the footage under the fragment', onion?.id === foot.clip, JSON.stringify(onion))
  check('…on the clip\'s own source time (inPoint 0.5 + 1 s)', onion && Math.abs(onion.t - 1.5) < 0.02, `t ${onion?.t}`)
  check('…never takes the mouse, sits above the fragments', onion?.pe === 'none' && onion.z > 5)
  await ed.ev(`${S}.setPlayhead(1.5)`)
  const t2 = await until(async () => { const v = await ed.ev(`(() => { const v = document.querySelector('.onion-skin'); return v && !v.seeking ? v.currentTime : null })()`); return v !== null && Math.abs(v - 2.0) < 0.02 ? v : null }, 5000, 100)
  check('…and follows the playhead', !!t2, `t ${t2}`)
  await ed.ev(`(() => {
    const el = document.querySelector('[data-act="onion-opacity"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, '0.8')
    el.dispatchEvent(new Event('input', { bubbles: true }))
    document.querySelector('[data-act="onion-diff"]').click()
  })()`)
  await sleep(200)
  const look = await ed.ev(`(() => { const cs = getComputedStyle(document.querySelector('.onion-skin')); return { op: cs.opacity, blend: cs.mixBlendMode } })()`)
  check('opacity and «difference» apply', look.op === '0.8' && look.blend === 'difference', JSON.stringify(look))
  await ed.ev(`${S}.select(['${setup.clip}'])`)
  await sleep(200)
  check('selecting the fragment (to tune it) keeps the onion on the footage',
    (await ed.ev(`document.querySelector('.onion-skin')?.dataset.onion`)) === foot.clip)
  await ed.ev(`(() => { const st = ${S}; st.pushHistory('hDelete'); st.select(['${foot.clip}']); st.deleteSelection() })()`)
  const gone = await until(async () => ((await ed.ev(`!document.querySelector('.onion-skin') && !window.kadrEditor.useOnion.getState().on`)) ? true : null), 3000, 100)
  check('deleting the footage takes the onion down', !!gone)
  await ed.ev(`window.kadrEditor.useOnion.setState(${JSON.stringify(onionPrefs)})`)
  A.close()
} finally {
  for (const f of made) await ed.ev(`window.kadr.fragmentDelete('${f}').then(() => 1, () => 0)`).catch(() => {})
  for (const r of renders) if (r) rmSync(r, { force: true })
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
