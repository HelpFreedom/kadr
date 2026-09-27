// Test: «Проверка» (src/engine/checks.ts, kadr_check) — every rule fires on a
// fragment built to break it, and stays quiet where the fragment keeps it:
//   events against the bars (off the beat, a big one off the "one", one in a
//   pause), captions (too short to read, moving, two at once, overlapping,
//   low contrast on the real pixels), the camera (a dead start, a jump, shaking
//   — and NOT a smooth fast move), and the seam between two windows of one film.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e48 and deletes it, with the
// fragments it made.
import WebSocket from 'ws'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { homedir } from 'os'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e48'
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
  console.log(`SKIP  e2e48 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

// the bars used below: 120 BPM from 0 → a beat every 0.5 s, a "one" every 2 s
const A_TSX = `import React from 'react'
import { AbsoluteFill } from 'remotion'
import meta from './meta.json'

const F: React.FC = () => (
  <AbsoluteFill style={{ background: '#ffffff' }}>
    <div style={{ position: 'absolute', left: 100, top: 100, width: 600, height: 120, color: '#dddddd', fontSize: 90, fontWeight: 900 }}>ПАЛЕ</div>
    <div style={{ position: 'absolute', left: 100, top: 400, width: 600, height: 120, color: '#000000', fontSize: 90, fontWeight: 900 }}>ЧЁТКО</div>
  </AbsoluteFill>
)
// three camera stretches: 0–1 s a smooth ease (fine), 1–2 s a dead start,
// 2.5 s a jump, 3–4 s shaking
const ease = (x: number) => x * x * (3 - 2 * x)
const camera = (t: number) => {
  let x = 0
  if (t < 1) x = ease(t)
  else if (t < 2) x = 1 + (t - 1) * 3
  else x = 4
  if (t >= 2.5) x += 10
  const shake = t >= 3 && t < 4 ? 0.05 * Math.sin(t * 2 * Math.PI * 12) : 0
  return { pos: [x, shake, 10] as [number, number, number], target: [x, 0, 0] as [number, number, number], fov: 40 }
}
export const fragment = {
  component: F, meta,
  inspect: {
    events: [
      { t: 2.0, kind: 'big' as const, label: 'на раз' },
      { t: 2.5, kind: 'big' as const, label: 'крупное на второй доле' },
      { t: 3.2, kind: 'small' as const, label: 'мимо доли' },
      { t: 1.0, kind: 'small' as const, label: 'в паузе' },
      { t: 3.0, kind: 'small' as const, label: 'в порядке' }
    ],
    texts: [
      { from: 0.2, to: 0.5, text: 'слишком быстро исчезает эта фраза', role: 'title' as const },
      { from: 1.0, to: 3.5, text: 'ПАЛЕ', role: 'title' as const, box: [100, 100, 600, 120] as [number, number, number, number], color: '#dddddd' },
      { from: 3.0, to: 3.9, text: 'ЧЁТКО', role: 'title' as const, box: [100, 150, 600, 120] as [number, number, number, number], color: '#000000' },
      { from: 0.6, to: 3.0, text: 'плывёт', role: 'note' as const, at: (t: number) => [200 + t * 100, 700] as [number, number] }
    ],
    camera,
    continuous: true
  }
}
`
const B_TSX = `import React from 'react'
import { AbsoluteFill } from 'remotion'
import meta from './meta.json'
const F: React.FC = () => <AbsoluteFill style={{ background: '#2040ff' }} />
export const fragment = { component: F, meta, inspect: { continuous: true } }
`

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
let made = []
try {
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e48', width: 1920, height: 1080, fps: 30, background: '#000000',
      tracks: [mk('V', 'video')], assets: [], markers: [], texts: [] }, null)
    await window.kadr.writeProject('${DIR}/e2e48.kadr', st().project)
    st().setProjectPath('${DIR}/e2e48.kadr')
    const a = await E.createFragment({ name: 'e2e48-a', start: 0, end: 4, transparent: false })
    const b = await E.createFragment({ name: 'e2e48-b', start: 4, end: 6, transparent: false })
    const T = st().project.tracks.find((t) => t.name === 'V')
    st().pushHistory('hMove')
    st().moveClip(a.clipId, T.id, 0)
    st().moveClip(b.clipId, T.id, 4)
    // the music map: 120 BPM from 0, bars of 4, a pause 0.9–1.2 s
    const beats = []
    for (let i = 0; i < 12; i++) beats.push({ time: i * 0.5, strength: 0.5, strong: i % 4 === 0, bar: Math.floor(i / 4) + 1, beatInBar: (i % 4) + 1 })
    st().setBeatMarkers(beats, { start: 0, end: 6 }, { pauses: [{ start: 0.9, end: 1.2 }], sections: [{ start: 0, end: 6, label: 'verse', energy: 0.5 }] })
    return { a: a.id, b: b.id, aEntry: a.entry, bEntry: b.entry, aClip: a.clipId }
  })()`)
  made = [setup.a, setup.b]
  writeFileSync(setup.aEntry, A_TSX)
  writeFileSync(setup.bEntry, B_TSX)
  await sleep(2500)

  const r = await evalJs(`window.kadrEditor.runChecks({ pixels: true }).then((r) => ({
    checked: r.checked, events: r.events.length,
    issues: r.issues.map((i) => ({ kind: i.kind, level: i.level, t: +i.t.toFixed(3), m: i.message }))
  }))`, 300000)
  const has = (kind, pred = () => true) => r.issues.filter((i) => i.kind === kind && pred(i))
  const show = (kind) => JSON.stringify(has(kind).map((i) => [i.t, i.m.slice(0, 70)]))
  check('the fragment\'s declarations were read', r.checked.events === 5 && r.checked.texts === 4 && r.checked.cameras === 1,
    JSON.stringify(r.checked))
  check('off the beat: the event at 3.2 s, and only it', has('offBeat').length === 1 && has('offBeat')[0].t === 3.2, show('offBeat'))
  check('a big event on beat 2, not on the "one"', has('bigOffDownbeat').length === 1 && has('bigOffDownbeat')[0].t === 2.5, show('bigOffDownbeat'))
  check('an event inside a pause of the music', has('eventInPause').length === 1 && has('eventInPause')[0].t === 1, show('eventInPause'))
  check('a caption shown shorter than its reading time', has('textShort').length === 1 && has('textShort')[0].t === 0.2, show('textShort'))
  check('a caption that moves while readable', has('textMoving').length === 1, show('textMoving'))
  check('two main captions at once, overlapping', has('textConcurrent').length === 1 && has('textOverlap').length === 1,
    show('textConcurrent') + show('textOverlap'))
  check('low contrast on the real pixels (light grey on white), and only there',
    has('contrast').length === 1 && /ПАЛЕ/.test(has('contrast')[0].m), show('contrast'))
  const cam = has('cameraJerk')
  check('each camera defect reported once, not as a string of steps', cam.length <= 4, `${cam.length} reports`)
  check('the camera: a dead start (1 s), a jump (2.5 s), shaking (3–4 s)',
    cam.some((i) => Math.abs(i.t - 1) < 0.1) && cam.some((i) => Math.abs(i.t - 2.5) < 0.1 && /скачком/.test(i.m)) &&
      cam.some((i) => i.t >= 2.9 && i.t < 4 && /дрожит/.test(i.m)), show('cameraJerk'))
  check('…and not the smooth eased move of the first second', !cam.some((i) => i.t > 0.05 && i.t < 0.95), show('cameraJerk'))
  check('the seam between two windows of one film shows (white → blue)',
    has('seam', (i) => i.level === 'warn').length === 1, show('seam'))
  const lane = await ed.ev(`({ ev: document.querySelectorAll('.tl-event').length, big: document.querySelectorAll('.tl-event.big').length, warn: document.querySelectorAll('.tl-event-warn').length })`)
  check('the events are drawn along the clip, with the problems marked', lane.ev === 5 && lane.big === 2 && lane.warn >= 5, JSON.stringify(lane))
} finally {
  for (const f of made) await ed.ev(`window.kadr.fragmentDelete('${f}').then(() => 1, () => 0)`).catch(() => {})
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
