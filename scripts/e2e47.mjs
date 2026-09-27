// Test: a project's shared library, fonts and the fragment render entry —
// what a 3D project had to work around by copying its film module and models
// into eight fragments with a shell script:
//
//   1. '@lib/…' in a fragment of a saved project resolves to <project>/kadr-lib,
//      in the preview (vite) and in the render (webpack);
//   2. fonts in kadr-lib/fonts are registered by Kadr — the preview page and
//      the render entry — not by a component that can unmount;
//   3. an edit of kadr-lib reloads the pages of that project's fragments;
//   4. the render cache follows kadr-lib: an edit there is a new render;
//   5. kadr_typecheck reports the fragment's own type errors, with @lib.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e47 and deletes it, with the
// fragments and the renders it made.
import WebSocket from 'ws'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { homedir } from 'os'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e47'
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
  console.log(`SKIP  e2e47 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}
const FONT_SRC = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'

const FRAG = (extra = '') => `import React from 'react'
import { AbsoluteFill } from 'remotion'
import { WORD } from '@lib/shared'
import meta from './meta.json'
${extra}
const F: React.FC = () => (
  <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
    <div id="w" style={{ fontFamily: 'KadrTestFace', fontSize: 140, color: 'white' }}>{WORD}</div>
  </AbsoluteFill>
)
export const fragment = { component: F, meta }
`

rmSync(DIR, { recursive: true, force: true })
mkdirSync(`${DIR}/kadr-lib/fonts`, { recursive: true })
writeFileSync(`${DIR}/kadr-lib/shared.ts`, "export const WORD = 'LIB-ONE'\n")
if (existsSync(FONT_SRC)) writeFileSync(`${DIR}/kadr-lib/fonts/KadrTestFace.ttf`, readFileSync(FONT_SRC))
let made = []
const renders = []
try {
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e47', width: 640, height: 360, fps: 30, background: '#000000',
      tracks: [mk('A', 'video'), mk('B', 'video')], assets: [], markers: [], texts: [] }, null)
    await window.kadr.writeProject('${DIR}/e2e47.kadr', st().project)
    st().setProjectPath('${DIR}/e2e47.kadr')
    const a = await E.createFragment({ name: 'e2e47-a', start: 0, end: 1, transparent: false })
    const b = await E.createFragment({ name: 'e2e47-b', start: 0, end: 1, transparent: false })
    const c = await E.createFragment({ name: 'e2e47-c', start: 2, end: 3, transparent: false })
    const T = (n) => st().project.tracks.find((t) => t.name === n)
    st().pushHistory('hMove')
    st().moveClip(a.clipId, T('A').id, 0)
    st().moveClip(b.clipId, T('B').id, 0)
    st().setPlayhead(0.5)
    return { a: a.id, b: b.id, c: c.id, aEntry: a.entry, bEntry: b.entry, cEntry: c.entry }
  })()`)
  made = [setup.a, setup.b, setup.c]
  writeFileSync(setup.aEntry, FRAG())
  writeFileSync(setup.bEntry, FRAG())
  // a type error that only exists through @lib: WORD is a string
  writeFileSync(setup.cEntry, FRAG('const wrong: number = WORD\nvoid wrong'))
  await sleep(2000)

  // ---- 1 + 2: @lib and the project font in the preview ----------------------
  const A = await pageOf(setup.a)
  const pa = A && await until(() => A.ev(`(() => {
    const w = document.querySelector('#w'); if (!w) return null
    const face = [...document.fonts].find((f) => f.family.replace(/"/g, '') === 'KadrTestFace')
    return { text: w.textContent, font: face ? face.status : 'none', used: getComputedStyle(w).fontFamily }
  })()`), 20000)
  check('@lib resolves in the preview', pa?.text === 'LIB-ONE', JSON.stringify(pa))
  if (existsSync(FONT_SRC)) check('a font in kadr-lib/fonts is registered by Kadr (loaded)', pa?.font === 'loaded', JSON.stringify(pa))

  // ---- 4 (before the edit): the render goes through @lib and the new entry --
  const r1 = await evalJs(`window.kadr.fragmentRender('${setup.a}')`, 600000)
  renders.push(r1.path)
  check('a fragment using @lib renders', !!r1.path && existsSync(r1.path) && !r1.cached, JSON.stringify(r1))
  const entry = readFileSync(`${WS_DIR}/src/_entries/current.tsx`, 'utf8')
  check('the render entry holds ONE composition and registers the project font',
    entry.includes(`'../fragments/${setup.a}'`) && (!existsSync(FONT_SRC) || entry.includes('KadrTestFace.ttf')) &&
      !entry.includes(setup.b), entry.split('\n').slice(0, 8).join(' | '))
  const r1b = await evalJs(`window.kadr.fragmentRender('${setup.a}')`, 600000)
  check('unchanged: the second render is a cache hit', r1b.cached === true && r1b.path === r1.path)

  // ---- 3: an edit of kadr-lib reloads that project's pages ------------------
  const B = await pageOf(setup.b)
  const oa = await A.ev('performance.timeOrigin'), ob = await B.ev('performance.timeOrigin')
  writeFileSync(`${DIR}/kadr-lib/shared.ts`, "export const WORD = 'LIB-TWO'\n")
  const after = await until(async () => {
    const pa2 = await pageOf(setup.a, 'iframe', 2000), pb2 = await pageOf(setup.b, 'iframe', 2000)
    const r = pa2 && pb2 && {
      a: await pa2.ev(`[performance.timeOrigin, document.querySelector('#w')?.textContent]`).catch(() => null),
      b: await pb2.ev(`[performance.timeOrigin, document.querySelector('#w')?.textContent]`).catch(() => null)
    }
    pa2?.close(); pb2?.close()
    return r && r.a?.[1] === 'LIB-TWO' && r.b?.[1] === 'LIB-TWO' ? r : null
  }, 20000, 500)
  check('an edit of kadr-lib reaches every fragment of the project', !!after, JSON.stringify(after))
  check('…by reloading their pages', after && after.a[0] !== oa && after.b[0] !== ob)

  // ---- 4: the render cache follows kadr-lib ---------------------------------
  const r2 = await evalJs(`window.kadr.fragmentRender('${setup.a}')`, 600000)
  renders.push(r2.path)
  check('after the kadr-lib edit the fragment renders again (new cache entry)', r2.cached === false && r2.path !== r1.path, `${r1.path} → ${r2.path}`)

  // ---- 5: typecheck ---------------------------------------------------------
  const tA = await evalJs(`window.kadr.fragmentTypecheck('${setup.a}')`, 180000)
  check('typecheck: a correct fragment using @lib has no errors', tA.ok === true, JSON.stringify(tA.errors.slice(0, 3)))
  const tC = await evalJs(`window.kadr.fragmentTypecheck('${setup.c}')`, 180000)
  check('typecheck: the fragment\'s own error, found through @lib', !tC.ok && tC.errors.some((e) => e.code === 'TS2322' && e.file.includes(setup.c)),
    JSON.stringify(tC.errors.slice(0, 3)))
  A.close(); B.close()
} finally {
  for (const f of made) await ed.ev(`window.kadr.fragmentDelete('${f}').then(() => 1, () => 0)`).catch(() => {})
  for (const r of renders) rmSync(r, { force: true })
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
