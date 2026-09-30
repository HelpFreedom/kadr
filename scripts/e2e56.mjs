// Test: the insert actions return the ids of the clips they made, so a script
// no longer diffs the clip ids before and after to find its new clip.
//   1. insertClipFromAsset on a video with sound → [video clip, audio twin],
//      linked to each other;
//   2. insertClipsFromAssets with two files → four ids in placement order;
//   3. insertTextClip → the text clip's id; null without an unlocked video track.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e56 and deletes it.
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
if (clipsOpen && process.env.KADR_E2E_FORCE !== '1') {
  console.log(`SKIP  an open project has ${clipsOpen} clips; this suite replaces it (KADR_E2E_FORCE=1 to run anyway)`)
  ed.close()
  process.exit(0)
}

const DIR = '/tmp/kadr-e2e56'
rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
for (const n of ['a', 'b']) {
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=s=320x180:d=1:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest', `${DIR}/${n}.mp4`])
}

try {
  const r = await evalJs(`(async () => {
    const ed = window.kadrEditor, st = () => ed.useEditor.getState()
    st().setProject({ name: 'e2e56', width: 320, height: 180, fps: 30, background: '#000000',
      assets: [], texts: [], tracks: [
        { id: 'v1', name: 'V1', kind: 'video', clips: [], gain: 1 },
        { id: 'a1', name: 'A1', kind: 'audio', clips: [], gain: 1 }] }, null)
    const add = async (n) => { const { asset } = await window.kadr.probeMedia('${DIR}/' + n + '.mp4'); const id = ed.uid(); st().addAsset({ id, ...asset }); return id }
    const a = await add('a'), b = await add('b')
    const one = st().insertClipFromAsset(a, 'v1', 0)
    const two = st().insertClipsFromAssets([a, b], 'v1', 5)
    const text = st().insertTextClip(10)
    const clip = (id) => st().project.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, track: t.kind }))).find((c) => c.id === id)
    const p = st().project
    st().setProject({ ...p, tracks: p.tracks.map((t) => ({ ...t, locked: true })) }, null)
    const none = st().insertTextClip(12)
    return {
      one: one.map((id) => clip(id) && [clip(id).track, clip(id).linkId, clip(id).start]),
      two: two.map((id) => clip(id) && [clip(id).track, clip(id).start]),
      text: clip(text)?.kind, none
    }
  })()`)
  check('insertClipFromAsset returns the video clip and its audio twin',
    r.one.length === 2 && r.one[0][0] === 'video' && r.one[1][0] === 'audio' && r.one[0][1] && r.one[0][1] === r.one[1][1], JSON.stringify(r.one))
  check('insertClipsFromAssets returns every new clip in placement order',
    r.two.length === 4 && r.two[0][1] === 5 && r.two[2][1] === 6 && r.two[1][0] === 'audio', JSON.stringify(r.two))
  check('insertTextClip returns the text clip', r.text === 'text')
  check('insertTextClip returns null without an unlocked video track', r.none === null, String(r.none))
} finally {
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
