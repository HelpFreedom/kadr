// Test: Remotion fragments in the PREVIEW — two bugs found while building the
// Kadr demo video, both invisible in the export (which composites on the GPU):
//
//   1. stacking: iframe fragments were added to the DOM top track first, so a
//      full-frame background fragment on a lower track covered the title
//      fragment above it. Now the DOM order is bottom → top.
//   2. a fragment UNDER ordinary clips: an iframe sits over the GL canvas, so an
//      opaque background fragment hid every screencast card on the tracks
//      above it. Such a fragment now goes through pixel capture (into the GL
//      stack at its own depth); with nothing GL-drawn above it, it stays an
//      iframe.
//   3. hot reload of a PROJECT-OWNED fragment created after the fragment dev
//      server started: chokidar does not follow a symlinked folder that appears
//      later, so edits were never seen — the preview served the first version
//      of the file forever. The generated vite config now follows those folders.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Creates its project under /tmp/kadr-e2e45 and
// deletes it, with the fragments it made.
import WebSocket from 'ws'
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e45'

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
if (!page) throw new Error('editor page not found')
const sock = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { sock.on('open', r); sock.on('error', j) })
let id = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const m = ++id
  const on = (raw) => { const x = JSON.parse(raw); if (x.id !== m) return; sock.off('message', on); x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result) }
  sock.on('message', on)
  sock.send(JSON.stringify({ id: m, method, params }))
})
const rawEval = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
const evalJs = async (expression, timeout = 180000) => {
  const key = `k${Date.now()}_${++id}`
  await rawEval(`window.__e2e = window.__e2e || {}; (async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) } catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`)
  const t0 = Date.now()
  for (;;) {
    const raw = await rawEval(`window.__e2e.${key} ?? null`)
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

const clipsOpen = await rawEval(`window.kadrEditor.useEditor.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0)`)
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e45 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
let made = []
try {
  // a saved project, so fragments are project-owned (symlinked into the workspace)
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e45', width: 1280, height: 720, fps: 30, background: '#000000',
      tracks: [mk('TOP', 'video'), mk('MID', 'video'), mk('BOT', 'video')], assets: [], markers: [], texts: [] }, null)
    await window.kadr.writeProject('${DIR}/e2e45.kadr', st().project)
    st().setProjectPath('${DIR}/e2e45.kadr')
    const T = (n) => st().project.tracks.find((t) => t.name === n)
    const top = await E.createFragment({ name: 'e2e45-top', start: 0, end: 4, transparent: true })
    const bot = await E.createFragment({ name: 'e2e45-bot', start: 0, end: 4, transparent: false })
    st().pushHistory('hMove')
    st().moveClip(top.clipId, T('TOP').id, 0)
    st().moveClip(bot.clipId, T('BOT').id, 0)
    st().setPlayhead(1)
    return { top: top.id, bot: bot.id, topEntry: top.entry, botEntry: bot.entry, topClip: top.clipId, botClip: bot.clipId }
  })()`)
  made = [setup.top, setup.bot]
  await sleep(2500)

  // ---- 1 + 2: stacking and the capture decision ------------------------------
  const noGl = await evalJs(`(async () => {
    const E = window.kadrEditor, p = E.useEditor.getState().project
    const T = (n) => p.tracks.find((t) => t.name === n)
    const c = (n) => T(n).clips[0]
    for (let i = 0; i < 40 && document.querySelectorAll('.frag-clipbox iframe').length < 2; i++) await new Promise((r) => setTimeout(r, 200))
    const order = [...document.querySelectorAll('.frag-clipbox iframe')].map((f) => new URL(f.src).searchParams.get('comp'))
    return { order, top: E.fragmentNeedsCapture(T('TOP'), c('TOP'), p), bot: E.fragmentNeedsCapture(T('BOT'), c('BOT'), p) }
  })()`)
  check('two iframe fragments: DOM order is bottom track first', JSON.stringify(noGl.order) === JSON.stringify([setup.bot, setup.top]),
    JSON.stringify(noGl.order))
  check('with nothing GL-drawn above, neither needs capture', noGl.top === false && noGl.bot === false)

  const withGl = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mid = st().project.tracks.find((t) => t.name === 'MID')
    st().pushHistory('hInsert')
    E.useEditor.setState((s) => ({ project: { ...s.project, tracks: s.project.tracks.map((t) => t.id === mid.id
      ? { ...t, clips: [{ id: E.uid(), kind: 'text', text: 'card', start: 0.5, duration: 2, inPoint: 0, label: 'card',
          textStyle: { fontFamily: 'sans-serif', fontSize: 80, color: '#ffffff', bold: true, italic: false, align: 'center',
            outlineColor: '#000000', outlineWidth: 0, background: '' }, ...E.newClipDefaults() }] } : t) } }))
    const p = st().project
    const T = (n) => p.tracks.find((t) => t.name === n)
    const late = { ...T('BOT').clips[0] }
    const lateTrack = { ...T('BOT'), clips: [{ ...late, start: 3, duration: 1 }] }
    const lateProject = { ...p, tracks: p.tracks.map((t) => t.name === 'BOT' ? lateTrack : t) }
    await new Promise((r) => setTimeout(r, 600))
    const order = [...document.querySelectorAll('.frag-clipbox iframe')].map((f) => new URL(f.src).searchParams.get('comp'))
    return {
      bot: E.fragmentNeedsCapture(T('BOT'), T('BOT').clips[0], p),
      top: E.fragmentNeedsCapture(T('TOP'), T('TOP').clips[0], p),
      noOverlap: E.fragmentNeedsCapture(lateTrack, lateTrack.clips[0], lateProject),
      iframes: order
    }
  })()`)
  check('a fragment UNDER a GL-drawn clip goes through capture', withGl.bot === true)
  check('the fragment above it stays an iframe', withGl.top === false)
  check('…and only while they overlap in time', withGl.noOverlap === false)
  check('the captured fragment leaves the iframe overlay', !withGl.iframes.includes(setup.bot) && withGl.iframes.includes(setup.top),
    JSON.stringify(withGl.iframes))

  // ---- 3: hot reload of a fragment created after the server started ----------
  const url = await evalJs(`window.kadrEditor.ensureFragmentServer()`)
  const serve = () => fetch(`${url}/src/fragments/${setup.top}/index.tsx`).then((r) => r.text())
  await serve() // the first transform, cached from here on
  const src = readFileSync(setup.topEntry, 'utf8')
  let seen = []
  for (const n of [1, 2]) {
    writeFileSync(setup.topEntry, src + `\nexport const __e2e45 = 'edit-${n}'\n`)
    let got = false
    for (let i = 0; i < 30 && !got; i++) { await sleep(200); got = (await serve()).includes(`edit-${n}`) }
    seen.push(got)
  }
  writeFileSync(setup.topEntry, src)
  check('an edit to a project-owned fragment made after start reaches the dev server', seen[0], JSON.stringify(seen))
  check('…and so does the next one', seen[1])
} catch (err) {
  check('suite ran to the end', false, String(err?.message || err))
} finally {
  try {
    await evalJs(`(async () => {
      const E = window.kadrEditor
      for (const f of ${JSON.stringify(made)}) await E.deleteFragment(f)
      const st = E.useEditor.getState()
      st.setProject({ ...st.project, name: 'Untitled', tracks: [], assets: [], markers: [], texts: [] }, null)
      return 1
    })()`)
  } catch (e) { console.log('WARN  cleanup:', e.message) }
  rmSync(DIR, { recursive: true, force: true })
  sock.close()
}
