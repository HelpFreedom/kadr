// e2e52 — an export renders ONLY the frames of a fragment that the edit uses
// (2026-10-08: a 26-minute film cut as 33 windows of one continuous film
// rendered each window from frame 0 — 1.6 million frames for 93 thousand used,
// ~35 hours). Proves, by pixels, that the clip still shows exactly the frame
// it showed before:
//   * a fragment whose every frame says its own number (left half grey =
//     frame % 30, right half = frame / 30, steps of 8 — survives two encodes);
//   * four clips of it: a plain window, one far away (→ its own file), one
//     that loops past the end of the composition, one at speed ×2;
//   * export → every output frame is the expected composition frame, the
//     renders are partial files (-r<f0>-<f1>) and far fewer frames than 900;
//   * then a FULL render is put on disk and the export repeated: the full
//     render is taken first (old caches stay valid) and the pixels are the same.
// Same refuse-over-an-open-project rule as e2e44 (KADR_E2E_FORCE=1).
import { rmSync, mkdirSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import WebSocket from 'ws'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e52'

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!page) throw new Error('editor page not found')

function connect(url) {
  const sock = new WebSocket(url, { perMessageDeflate: false })
  const ready = new Promise((r, j) => { sock.on('open', r); sock.on('error', j) })
  ready.catch(() => {})
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
  return { send, ev, close: () => { try { sock.close() } catch { /* not open */ } } }
}
const ed = connect(page.webSocketDebuggerUrl)
// park results in a global and poll (awaitPromise is flaky under GC)
const evalJs = async (expression, timeout = 300000) => {
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
  console.log(`SKIP  e2e52 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const FPS = 60
const FRAG = `import React from 'react'
import { AbsoluteFill, useCurrentFrame } from 'remotion'
import meta from './meta.json'
const g = (v: number) => { const x = v * 8 + 4; return \`rgb(\${x},\${x},\${x})\` }
const F: React.FC = () => {
  const f = useCurrentFrame()
  return (
    <AbsoluteFill style={{ flexDirection: 'row' }}>
      <div style={{ flex: 1, background: g(f % 30) }} />
      <div style={{ flex: 1, background: g(Math.floor(f / 30)) }} />
    </AbsoluteFill>
  )
}
export const fragment = { component: F, meta }
`
// timeline clips of the one fragment: [start, duration, inPoint, speed]; the
// in-points sit a quarter frame off so that every output frame samples a
// quarter into a source frame — never on a frame boundary, where either
// neighbour would be a fair answer
const Q = 0.25 / FPS
const CLIPS = [
  [0.0, 0.5, 1.0 - Q, 1],   // frames 60..89
  [0.5, 0.5, 13.5 - Q, 1],  // 810..839 — more than 10 s away: a file of its own
  [1.0, 1.0, 14.5 - Q / 2, 1], // 870..899, then loops back to 870 (an eighth off: a
                            // wrap moves the phase by the in-point's own fraction)
  [2.0, 0.5, 0.5 + Q, 2]    // 30, 32, … at ×2 — joins the first window
]
const TOTAL = 2.5

/** expected composition frame of output frame k (sampled at (k + 0.5) / fps) */
function expected(k) {
  const t = (k + 0.5) / FPS
  const [start, dur, inPoint, speed] = CLIPS.find(([s, d]) => t >= s && t < s + d)
  let rel = (t - start) * speed
  const span = 15 - inPoint // the loop wraps at the end of the PICTURE
  if (rel >= span) rel %= span
  return Math.floor((inPoint + rel) * FPS)
}

/** the frame number every output frame shows, read from its two halves */
function decode(file) {
  // the Y plane itself (a 4×1 yuv420p frame = 4 Y + 2 U + 2 V bytes): a
  // conversion to gray expands the range differently for tagged and untagged
  // files, and read 84/220 as 78/238 on a correct export. Only the OUTER
  // quarters are read: averaged over a whole half, the codec's blur of a
  // bright neighbour across the seam lifted a dark half by half a step.
  const raw = execFileSync('ffmpeg', ['-v', 'error', '-i', file, '-vsync', 'passthrough', '-vf', 'scale=4:1:flags=area', '-pix_fmt', 'yuv420p', '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 })
  const level = (y) => Math.round(((y - 16) * 255 / 219 - 4) / 8)
  const out = []
  for (let i = 0; i + 7 < raw.length; i += 8) out.push(level(raw[i + 3]) * 30 + level(raw[i]))
  return out
}

function compare(label, file) {
  const got = decode(file)
  const n = Math.round(TOTAL * FPS)
  let bad = 0, first = ''
  for (let k = 0; k < n; k++) {
    if (got[k] !== expected(k)) { bad++; first ||= `frame ${k}: shows ${got[k]}, expected ${expected(k)}` }
    if (process.env.KADR_E2E_VERBOSE) console.log(k, got[k], expected(k), got[k] === expected(k) ? '' : '<<')
  }
  check(`${label}: every output frame is the right composition frame`, got.length === n && bad === 0,
    `${got.length}/${n} frames, ${bad} wrong${first ? '; first: ' + first : ''}`)
}

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
let fragId = null
const renders = new Set()
try {
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e52', width: 320, height: 180, fps: ${FPS}, background: '#000000',
      tracks: [mk('V', 'video')], assets: [], markers: [], texts: [] }, null)
    await window.kadr.writeProject('${DIR}/e2e52.kadr', st().project)
    st().setProjectPath('${DIR}/e2e52.kadr')
    const f = await E.createFragment({ name: 'e2e52-frames', start: 0, end: 15, transparent: false })
    return { id: f.id, entry: f.entry, clipId: f.clipId }
  })()`)
  fragId = setup.id
  writeFileSync(setup.entry, FRAG)
  // lay the four clips of the fragment by hand (copies of the created one)
  await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const p = JSON.parse(JSON.stringify(st().project))
    const tr = p.tracks.find((t) => t.clips.some((c) => c.id === '${setup.clipId}'))
    const proto = tr.clips.find((c) => c.id === '${setup.clipId}')
    tr.clips = ${JSON.stringify(CLIPS)}.map(([start, duration, inPoint, speed]) =>
      ({ ...JSON.parse(JSON.stringify(proto)), id: E.uid(), start, duration, inPoint, speed }))
    for (const t of p.tracks) if (t !== tr) t.clips = []
    E.useEditor.setState({ project: p })
    return true
  })()`)

  const jobs = await evalJs(`(async () => {
    const m = await import('/src/engine/exporter.ts')
    return m.fragmentRenderJobs(${S}.project.tracks.flatMap((t) => t.clips)).map((j) => ({ range: j.range, n: j.clips.length }))
  })()`)
  check('the clips make two render jobs (near windows merged, a far one apart)',
    jobs.length === 2 && jobs[0].n === 2 && jobs[1].n === 2, JSON.stringify(jobs))

  const runExport = (out) => evalJs(`(async () => {
    const ed = window.kadrEditor
    const preset = ed.PRESETS.find((p) => p.container === 'mp4')
    const h = ed.startExport(ed.useEditor.getState().project, preset, '${out}', () => {}, null,
      { motionBlur: false, frameBlending: false })
    await h.done
    return true
  })()`, 900000)

  // ---- 1. partial renders
  const t0 = Date.now()
  await runExport(`${DIR}/partial.mp4`)
  const listRenders = () => execFileSync('bash', ['-c', `ls ${process.env.HOME}/.config/kadr/fragment-renders/ | grep '^${fragId}-' || true`]).toString().split('\n').filter(Boolean)
  const parts = listRenders()
  for (const r of parts) renders.add(r)
  const frameCount = (name) => Number(execFileSync('ffprobe', ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', `${process.env.HOME}/.config/kadr/fragment-renders/${name}`]).toString().trim())
  const counts = parts.map((n) => [n, frameCount(n)])
  check('the export rendered two partial files', parts.length === 2 && parts.every((n) => /-r\d+-\d+\.mp4$/.test(n)), parts.join(', '))
  const sum = counts.reduce((s, [, c]) => s + c, 0)
  check('far fewer frames than the whole composition', sum > 0 && sum < 900 * 0.6, `${sum} of 900 (${counts.map(([n, c]) => n.replace(/^.*-r/, 'r') + ':' + c).join(', ')}), ${((Date.now() - t0) / 1000).toFixed(0)} s`)
  const far = counts.find(([n]) => /-r\d+-899\.mp4$/.test(n))
  const farFrom = far ? Number(far[0].match(/-r(\d+)-899/)[1]) : NaN
  check('the window that loops runs to the end of the composition', !!far && far[1] === 900 - farFrom, far ? `${far[0]}: ${far[1]} frames` : parts.join(', '))
  compare('partial renders', `${DIR}/partial.mp4`)

  // the export decoder on that light file: mp4box used to carry the batch it
  // was collecting across a seek, and a fresh source handed out the frame at
  // 1.0 s for ANY time before it (one wrong frame at a clip's start)
  const farPath = `${process.env.HOME}/.config/kadr/fragment-renders/${far?.[0]}`
  const dec = await evalJs(`(async () => {
    const { Mp4FrameSource } = await import('/src/engine/demux.ts')
    const { asset } = await window.kadr.probeMedia('${farPath}')
    const out = []
    for (const seq of [[0.0083], [0.5083], [1.0083, 0.5083, 0.0083]]) {
      const s = await Mp4FrameSource.open(asset)
      for (const q of seq) { const f = await s.frameAt(q); out.push([q, f ? f.timestamp / 1e6 : null]) }
      s.close()
    }
    return out
  })()`)
  const decBad = dec.filter(([q, ts]) => ts === null || !(ts <= q + 1e-6 && q < ts + 1 / FPS))
  check('the export decoder hands out the frame covering the time asked (fresh source, backward jumps)',
    decBad.length === 0, dec.map(([q, ts]) => `${q}→${ts?.toFixed(4)}`).join(' '))

  // ---- 2. a full render on disk wins
  const full = await evalJs(`window.kadr.fragmentRender('${fragId}')`, 600000)
  renders.add(full.path.split('/').pop())
  check('a plain render is the full file, starting at 0', !/-r\d+-\d+\./.test(full.path) && full.start === 0, full.path.split('/').pop())
  const again = await evalJs(`window.kadr.fragmentRender('${fragId}', { range: [13, 16] })`)
  check('a range request takes the full render when it exists', again.path === full.path && again.start === 0 && again.cached, JSON.stringify({ start: again.start, cached: again.cached }))
  await runExport(`${DIR}/full.mp4`)
  compare('full render', `${DIR}/full.mp4`)
} finally {
  if (process.env.KADR_E2E_KEEP) { ed.close(); process.exit() }
  if (fragId) await ed.ev(`window.kadr.fragmentDelete('${fragId}').then(() => 1, () => 0)`).catch(() => {})
  for (const r of renders) rmSync(`${process.env.HOME}/.config/kadr/fragment-renders/${r}`, { force: true })
  rmSync(DIR, { recursive: true, force: true })
  await ed.ev(`${S}.setProject({ version: 1, id: window.kadrEditor.uid(), name: 'Untitled', width: 1920, height: 1080, fps: 30, background: '#000000', tracks: [], assets: [], markers: [], texts: [] }, null)`).catch(() => {})
  ed.close()
}
