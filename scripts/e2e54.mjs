// Test: an export whose final ffmpeg pass (audio mix + mux) fails must FAIL —
// for the dialog, for a script's startExport().done and for kadr_export; and
// an export CANCELLED mid-flight stops quietly and leaves nothing behind.
//
// The video stream is rendered first and the mux runs after it, in main.
// When that mux failed, main sent an 'error' progress event and then resolved
// the IPC call anyway, so `done` resolved too: kadr_export told the agent the
// file had been written when there was no file at all (HelpFreedom/kadr#27).
// A mux is made to fail here by writing into a folder that does not exist —
// the frames render fine, ffmpeg cannot open the output.
//
// A cancel used to file three failures in the session log (ffmpeg's stdin
// EPIPE as an uncaught exception, and the two frames in flight as unhandled
// rejections) and left the partial video in the temp folder — on a tmpfs
// /tmp, RAM held until reboot (HelpFreedom/kadr#17).
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// Replaces the open project, so it refuses over one with clips unless
// KADR_E2E_FORCE=1.
import { rmSync, mkdirSync, existsSync, readdirSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import WebSocket from 'ws'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e54'
const NOWHERE = '/tmp/kadr-e2e54-no-such-folder'

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!page) throw new Error('editor page not found')
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false })
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
let id = 0
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const m = ++id
  const on = (raw) => { const x = JSON.parse(raw); if (x.id !== m) return; ws.off('message', on); x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result) }
  ws.on('message', on)
  ws.send(JSON.stringify({ id: m, method, params }))
})
const ev = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result.value
}
// park results in a global and poll (awaitPromise is flaky under GC)
const evalJs = async (expression, timeout = 300000) => {
  const key = `k${Date.now()}_${Math.random().toString(36).slice(2)}`
  await ev(`window.__e2e = window.__e2e || {}; (async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) } catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`)
  const t0 = Date.now()
  for (;;) {
    const raw = await ev(`window.__e2e.${key} ?? null`)
    if (raw !== null) { const r = JSON.parse(raw); if ('err' in r) throw new Error(r.err); return r.ok }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 250))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const S = 'window.kadrEditor.useEditor.getState()'

const clipsOpen = await ev(`${S}.project.tracks.reduce((n, t) => n + t.clips.length, 0)`)
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e54 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

rmSync(DIR, { recursive: true, force: true })
rmSync(NOWHERE, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=1.5', '-f', 'lavfi', '-i', 'sine=f=440:d=1.5',
  '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', `${DIR}/clip.mp4`])

// an export's intermediate videos: next to the output (shared/exportTemp.ts),
// in the temp folder when the output's folder cannot be written
const kept = () => {
  const out = []
  for (const d of [DIR, tmpdir()]) {
    try { for (const f of readdirSync(d)) if (/\.(mp4|h264|mkv)$/.test(f) && /kadr/.test(f)) out.push(join(d, f)) } catch { /* none */ }
  }
  return new Set(out)
}
const before = kept()

try {
  await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e54', width: 320, height: 180, fps: 30, background: '#000000',
      tracks: [mk('V', 'video'), mk('A', 'audio')], assets: [], markers: [], texts: [] }, null)
    await E.importFiles(['${DIR}/clip.mp4'], { trackId: st().project.tracks[0].id, at: 0 })
    return st().project.tracks.reduce((n, t) => n + t.clips.length, 0)
  })()`)

  const run = (presetId, out) => evalJs(`(async () => {
    const E = window.kadrEditor
    const preset = E.PRESETS.find((p) => p.id === ${JSON.stringify(presetId)})
    const events = []
    const h = E.startExport(E.useEditor.getState().project, preset, ${JSON.stringify(out)}, () => {}, null,
      { motionBlur: false, frameBlending: false })
    const off = window.kadr.onExportProgress((p) => events.push(p.phase))
    try { await h.done; return { resolved: true, events } }
    catch (e) { return { resolved: false, message: String(e && e.message || e), events } }
    finally { off() }
  })()`, 600000)

  // ---- 1. a video export whose mux cannot write its file
  const bad = await run('hd720', `${NOWHERE}/out.mp4`)
  check('a failed mux rejects done (it used to resolve)', bad.resolved === false, JSON.stringify(bad).slice(0, 220))
  check('… with ffmpeg\'s reason in the message', /No such file|Error opening|Could not|exited/i.test(bad.message || ''), bad.message?.slice(0, 160))
  check('… and the rendered video is kept, the message says where', /video kept at /.test(bad.message || ''))
  const keptAt = /video kept at (\S+?)\)?$/.exec(bad.message || '')?.[1]
  check('… and it really is there (only a stream main never got is deleted)', !!keptAt && existsSync(keptAt) && statSync(keptAt).size > 1000, keptAt)
  check('… in the temp folder, since the output\'s folder does not exist', !!keptAt && keptAt.startsWith(tmpdir() + '/'), keptAt)
  check('no file appeared', !existsSync(`${NOWHERE}/out.mp4`))

  // ---- 2. an audio-only export the same way
  const badAudio = await run('mp3', `${NOWHERE}/out.mp3`)
  check('a failed audio-only export rejects done too', badAudio.resolved === false, (badAudio.message || '').slice(0, 160))

  // ---- 3. and a good export still resolves with a real file
  const good = await run('hd720', `${DIR}/out.mp4`)
  const size = existsSync(`${DIR}/out.mp4`) ? statSync(`${DIR}/out.mp4`).size : 0
  check('a good export still resolves', good.resolved === true, good.message || '')
  check('… and writes a real file', size > 1000, `${size} bytes`)
  const beside = readdirSync(DIR).filter((f) => /^kadr-export/.test(f))
  check('… and leaves no intermediate beside it', beside.length === 0, beside.join(', '))
  check('only ONE export at a time still holds after a failure (the busy flag came down)', good.resolved === true)

  // ---- 4. a cancel in the middle of a long export
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=20', '-f', 'lavfi', '-i', 'sine=f=440:d=20',
    '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', `${DIR}/long.mp4`])
  const keptBefore = kept()
  await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e54-cancel', width: 1920, height: 1080, fps: 30, background: '#000000',
      tracks: [mk('V', 'video'), mk('A', 'audio')], assets: [], markers: [], texts: [] }, null)
    await E.importFiles(['${DIR}/long.mp4'], { trackId: st().project.tracks[0].id, at: 0 })
    E.clearLog()
    const preset = E.PRESETS.find((p) => p.container === 'mp4' && p.width === 1920) || E.PRESETS.find((p) => p.container === 'mp4')
    const run = window.__e2e54run = { at: 0, outcome: null }
    run.h = E.startExport(st().project, preset, '${DIR}/cancelled.mp4', (p) => { if (p.phase === 'video') run.at = p.progress }, null,
      { motionBlur: false, frameBlending: false })
    run.h.done.then(() => { run.outcome = 'resolved' }, (e) => { run.outcome = String(e && e.message || e) })
    return 0
  })()`)
  const t0 = Date.now()
  while ((await evalJs('window.__e2e54run.at')) < 0.15 && Date.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 100))
  // while it runs, the intermediate is next to the output — not in a tmpfs /tmp
  const running = readdirSync(DIR).filter((f) => /^kadr-export-raw-\d+\.mp4$/.test(f))
  check('the running export writes its intermediate next to the output', running.length === 1, running.join(', ') || readdirSync(DIR).join(', '))
  const cancel = await evalJs(`(async () => {
    const E = window.kadrEditor, run = window.__e2e54run
    run.h.cancel(); await window.kadr.exportCancel()
    while (run.outcome === null) await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 2500)) // late rejections and uncaught errors land by now
    return { at: run.at, outcome: run.outcome, failures: E.useLog.getState().entries.filter((e) => e.level !== 'info').map((e) => e.msg) }
  })()`, 600000)
  check('a cancel mid-export rejects done with «cancelled»', cancel.outcome === 'cancelled' && cancel.at > 0 && cancel.at < 1,
    `at ${(cancel.at * 100).toFixed(0)} %: ${cancel.outcome}`)
  check('… and files no failure in the session log (it used to file three)', cancel.failures.length === 0, cancel.failures.join(' | '))
  const leftover = [...kept()].filter((f) => !keptBefore.has(f))
  check('… and leaves no partial video in the temp folder', leftover.length === 0, leftover.join(', '))
  check('… nor an output file', !existsSync(`${DIR}/cancelled.mp4`))
} finally {
  for (const f of kept()) if (!before.has(f)) rmSync(f, { force: true })
  rmSync(DIR, { recursive: true, force: true })
  rmSync(NOWHERE, { recursive: true, force: true })
  await ev(`${S}.setProject({ version: 1, id: window.kadrEditor.uid(), name: 'Untitled', width: 1920, height: 1080, fps: 30, background: '#000000', tracks: [], assets: [], markers: [], texts: [] }, null)`).catch(() => {})
  ws.close()
}
