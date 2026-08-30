// Test: the neon-wave module — an audio-reactive Remotion fragment generated
// from a timeline range. Covers: the clip lands on a free video track exactly
// over the range with one envelope value per composition frame; silence gives
// a flat zero curve; the "one track" source differs from the whole mix; a
// real `remotion render` of a short fragment produces an opaque h264 mp4 at
// project size whose centre rows are lit while the top stays black; and the
// toolbar button follows the range.
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { readdirSync, unlinkSync } from 'fs'

const PORT = process.env.KADR_CDP_PORT || 9777

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('CDP target not found')
}

let id = 0
let ws
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
}
async function rawEval(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true })
  if (r.exceptionDetails) throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  return r.result.value
}
async function evalJs(expression, { timeout = 600000 } = {}) {
  const key = `k${Date.now()}_${++id}`
  await rawEval(
    `window.__e2e = window.__e2e || {};` +
    `(async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) }` +
    ` catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`
  )
  const t0 = Date.now()
  for (;;) {
    const raw = await rawEval(`window.__e2e.${key} ?? null`)
    if (raw !== null) {
      const r = JSON.parse(raw)
      if ('err' in r) throw new Error('JS exception: ' + r.err)
      return r.ok
    }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 800))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

// media: a steady tone, a tone audible only in [2, 4) s, and digital silence
execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test/nw && cd /tmp/kadr-test/nw && ' +
  'ffmpeg -v error -y -f lavfi -i "sine=frequency=440:duration=6" -ac 2 -c:a pcm_s16le tone.wav && ' +
  'ffmpeg -v error -y -f lavfi -i "sine=frequency=660:duration=6" -af "volume=0:enable=\'lt(t,2)+gt(t,4)\'" -ac 2 -c:a pcm_s16le burst.wav && ' +
  'ffmpeg -v error -y -f lavfi -i "anullsrc=r=48000:cl=stereo" -t 6 -c:a pcm_s16le silent.wav'])

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

const RENDER_DIR = `${process.env.HOME}/.config/kadr/fragment-renders`
const created = []
try {
  // --- project: 1920×1080 @ 30 fps, three audio tracks, one file each
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor; const st = () => E.useEditor.getState()
    st().setProject({ ...st().project, width: 1920, height: 1080, fps: 30, tracks: [], assets: [] }, null)
    st().addTrack('video')
    const ids = {}
    for (const name of ['tone', 'burst', 'silent']) {
      st().addTrack('audio')
      const tr = st().project.tracks[st().project.tracks.length - 1]
      const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/nw/' + name + '.wav')
      const id = E.uid(); st().addAsset({ id, ...asset })
      st().insertClipFromAsset(id, tr.id, 0)
      ids[name] = tr.id
    }
    return { tracks: st().project.tracks.map((t) => t.kind + ':' + t.clips.length), ids }
  })()`)
  check('project: one audio clip per audio track', setup.tracks.join(',') === 'video:0,audio:1,audio:1,audio:1', setup.tracks.join(','))
  const T = setup.ids

  const readEnv = (entry) => `(async () => {
    const tsx = await window.kadr.readTextFile(${JSON.stringify(entry)})
    const m = tsx.match(/const ENV[^=]*= (\\[[^\\]]*\\])/)
    return { env: m ? JSON.parse(m[1]) : null, bytes: tsx.length }
  })()`

  // --- 1. whole mix over [1, 2): a remotion clip exactly over the range, ENV per frame
  const r1 = await evalJs(`(async () => {
    const E = window.kadrEditor; const st = () => E.useEditor.getState()
    st().setRange({ start: 1, end: 2 })
    const r = await E.neonWave({ range: { start: 1, end: 2 }, source: 'mix' })
    const track = st().project.tracks.find((t) => t.clips.some((c) => c.id === r.clipId))
    const clip = track.clips.find((c) => c.id === r.clipId)
    const overlaps = track.clips.filter((c) => c.id !== clip.id && c.start < clip.start + clip.duration && c.start + c.duration > clip.start).length
    return { r, trackKind: track.kind, overlaps, clip: { kind: clip.kind, start: clip.start, duration: clip.duration, meta: clip.fragmentMeta }, selection: st().selection }
  })()`)
  created.push(r1.r.fragmentId)
  check('clip is a remotion fragment on a video track', r1.clip.kind === 'remotion' && r1.trackKind === 'video')
  check('clip sits exactly over the range', r1.clip.start === 1 && Math.abs(r1.clip.duration - 1) < 1e-9, `${r1.clip.start}+${r1.clip.duration}`)
  check('no other clip overlaps it on that track', r1.overlaps === 0)
  check('fragment is opaque and ≥ 60 fps', r1.clip.meta.transparent === false && r1.clip.meta.fps >= 60, `fps ${r1.clip.meta.fps}`)
  check('durationInFrames = round(1 s · fps)', r1.clip.meta.durationInFrames === Math.round(r1.clip.meta.fps), String(r1.clip.meta.durationInFrames))
  check('the new clip is selected', r1.selection.length === 1 && r1.selection[0] === r1.r.clipId)
  const e1 = await evalJs(readEnv(r1.r.entry))
  check('TSX carries one ENV value per frame', Array.isArray(e1.env) && e1.env.length === r1.clip.meta.durationInFrames, `${e1.env?.length}`)
  check('mix of a steady tone is loud', e1.env && Math.max(...e1.env) > 0.05 && r1.r.peak > 0.05, `peak ${r1.r.peak.toFixed(3)}`)

  // --- 2. the silent track alone → all zeros
  const r2 = await evalJs(`(async () => {
    const E = window.kadrEditor
    const r = await E.neonWave({ range: { start: 1, end: 2 }, source: { trackId: ${JSON.stringify(T.silent)} } })
    return r
  })()`)
  created.push(r2.fragmentId)
  const e2 = await evalJs(readEnv(r2.entry))
  check('silent track → flat zero envelope', e2.env && e2.env.length > 0 && e2.env.every((v) => v === 0), `peak ${r2.peak}`)

  // --- 3. the burst track over [1.5, 2.5): quiet first half, loud second half; differs from the mix
  const r3 = await evalJs(`(async () => {
    const E = window.kadrEditor
    const a = await E.neonWave({ range: { start: 1.5, end: 2.5 }, source: { trackId: ${JSON.stringify(T.burst)} } })
    const b = await E.neonWave({ range: { start: 1.5, end: 2.5 }, source: 'mix' })
    return { a, b }
  })()`)
  created.push(r3.a.fragmentId, r3.b.fragmentId)
  const e3a = await evalJs(readEnv(r3.a.entry))
  const e3b = await evalJs(readEnv(r3.b.entry))
  const half = Math.floor(e3a.env.length / 2)
  const firstHalfMax = Math.max(...e3a.env.slice(0, half - 2))
  const secondHalfMax = Math.max(...e3a.env.slice(half + 3))
  check('burst track: silent before 2 s, loud after', firstHalfMax < 0.01 && secondHalfMax > 0.05, `${firstHalfMax.toFixed(4)} / ${secondHalfMax.toFixed(3)}`)
  const diff = e3a.env.reduce((s, v, i) => s + Math.abs(v - e3b.env[i]), 0)
  check('track-restricted envelope differs from the whole mix', diff > 1, `Σ|a−b| = ${diff.toFixed(2)}`)
  const mixFirst = Math.max(...e3b.env.slice(1, half - 2))
  check('the mix is loud where the burst track is silent (tone track contributes)', mixFirst > 0.05, mixFirst.toFixed(3))

  // --- 4. a real render of a short fragment: opaque h264 mp4 at project size, lit centre, black top
  const r4 = await evalJs(`(async () => {
    const E = window.kadrEditor
    return await E.neonWave({ range: { start: 0, end: 0.5 }, source: { trackId: ${JSON.stringify(T.tone)} } })
  })()`)
  created.push(r4.fragmentId)
  for (const f of readdirSync(RENDER_DIR)) if (f.startsWith(r4.fragmentId)) unlinkSync(`${RENDER_DIR}/${f}`)
  const t0 = Date.now()
  const out = await evalJs(`window.kadr.fragmentRender(${JSON.stringify(r4.fragmentId)})`, { timeout: 600000 })
  const renderMs = Date.now() - t0
  check('render produced an mp4 (opaque fragment)', typeof out?.path === 'string' && out.path.endsWith('.mp4') && out.cached === false, out?.path)
  check('no .part sidecar left behind', !readdirSync(RENDER_DIR).some((f) => f.startsWith(r4.fragmentId) && f.includes('.part.')))
  const probe = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
    'stream=codec_name,width,height,r_frame_rate,nb_frames', '-of', 'csv=p=0', out.path]).toString().trim()
  const [codec, w, h, rate, nb] = probe.split(',')
  check('mp4 is h264 1920×1080 at the fragment fps', codec === 'h264' && w === '1920' && h === '1080' && rate.startsWith('60/1'), probe)
  check('frame count ≈ 0.5 s · 60', Math.abs(Number(nb) - 30) <= 1, `${nb} frames in ${renderMs} ms`)
  const gray = execFileSync('ffmpeg', ['-v', 'error', '-ss', '0.25', '-i', out.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 16 << 20 })
  let lit = 0
  for (let y = 480; y < 600; y++) for (let x = 0; x < 1920; x++) if (gray[y * 1920 + x] > 40) lit++
  let topSum = 0
  for (let y = 0; y < 100; y++) for (let x = 0; x < 1920; x++) topSum += gray[y * 1920 + x]
  const topMean = topSum / (100 * 1920)
  check('the centre band is lit (the line is there)', lit >= 200, `${lit} px > 40`)
  check('the top of the frame is black', topMean < 3, `mean ${topMean.toFixed(2)}`)

  // --- 5. toolbar button follows the range
  const btn = await evalJs(`(async () => {
    const st = window.kadrEditor.useEditor.getState
    const find = () => document.querySelector('.tl-toolbar button[data-act="neon-wave"]')
    st().setRange(null); await new Promise((r) => setTimeout(r, 150))
    const without = find()?.disabled
    st().setRange({ start: 1, end: 2 }); await new Promise((r) => setTimeout(r, 150))
    const withRange = find()?.disabled
    st().setRange(null)
    return { without, withRange }
  })()`)
  check('the wave button is disabled without a range, enabled with one', btn.without === true && btn.withRange === false, JSON.stringify(btn))
} finally {
  // deleteFragment also removes the referencing clips (a bare fragmentDelete leaves zombies)
  await evalJs(`(async () => { for (const id of ${JSON.stringify(created)}) await window.kadrEditor.deleteFragment(id).catch(() => {}); return 1 })()`).catch(() => {})
  for (const f of readdirSync(RENDER_DIR)) if (created.some((id) => f.startsWith(id))) unlinkSync(`${RENDER_DIR}/${f}`)
  ws.close()
}
console.log('e2e33 finished')
