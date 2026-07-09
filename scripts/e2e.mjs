// End-to-end smoke test driven over the Chrome DevTools Protocol.
// Requires the app running with --remote-debugging-port=9777 and the media
// set from scripts/gen-test-media.sh.
import WebSocket from 'ws'

const PORT = process.env.KADR_CDP_PORT || 9777

async function getPageWs() {
  for (let i = 0; i < 30; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
      const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
      if (page) return page.webSocketDebuggerUrl
    } catch { /* app still starting */ }
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
// async evals park results in globals and poll — awaitPromise is flaky under GC
async function evalJs(expression, { timeout = 300000 } = {}) {
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
    await new Promise((r) => setTimeout(r, 300))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// protect the user's live work before reloading into a fresh state
try {
  const saved = await evalJs(`(async () => {
    const st = window.kadrEditor?.useEditor?.getState?.()
    if (!st) return 'no-store'
    const clips = st.project.tracks.reduce((n, t) => n + t.clips.length, 0)
    if (!clips) return 'empty'
    const p = '${process.env.HOME}/Downloads/autosave-' + Date.now() + '.kadr'
    await window.kadr.writeProject(p, st.project)
    return p
  })()`, { timeout: 15000 })
  if (saved !== 'empty' && saved !== 'no-store') console.log('live project autosaved →', saved)
} catch { /* page mid-load */ }

try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// 1. scripting surface present
const hasApi = await evalJs(`!!window.kadr && !!window.kadrEditor`)
check('scripting API exposed', hasApi)

// 2. probe + import three assets
const assets = await evalJs(`(async () => {
  const out = []
  for (const p of ['/tmp/kadr-test/a.mp4', '/tmp/kadr-test/b.mp4', '/tmp/kadr-test/music.mp3']) {
    const { asset } = await window.kadr.probeMedia(p)
    const id = window.kadrEditor.uid()
    window.kadrEditor.useEditor.getState().addAsset({ id, ...asset })
    out.push({ id, kind: asset.kind, duration: asset.duration, w: asset.width, h: asset.height,
               hasAudio: asset.hasAudio, wave: !!asset.waveform && asset.waveform.rate > 0,
               thumb: !!asset.thumbnail })
  }
  return out
})()`)
check('probe a.mp4: video 1280x720 ~6s with audio+thumb+waveform',
  assets[0].kind === 'video' && assets[0].w === 1280 && Math.abs(assets[0].duration - 6) < 0.2 &&
  assets[0].hasAudio && assets[0].thumb && assets[0].wave,
  JSON.stringify(assets[0]))
check('probe music.mp3: audio with waveform', assets[2].kind === 'audio' && assets[2].hasAudio && assets[2].wave)

// 3. build a timeline: a.mp4 [0..4] (+ its linked audio twin), b.mp4 [4..8]
// on V1, music [0..7] on A1, text overlay on V2
const timeline = await evalJs(`(() => {
  const s = window.kadrEditor.useEditor.getState()
  const p = s.project
  const v1 = p.tracks.find(t => t.name === 'V1')
  const a1 = p.tracks.find(t => t.kind === 'audio')
  s.insertClipFromAsset('${assets[0].id}', v1.id, 0)
  s.insertClipFromAsset('${assets[1].id}', v1.id, 4)
  s.insertClipFromAsset('${assets[2].id}', a1.id, 0)
  s.insertTextClip(1)
  const st = window.kadrEditor.useEditor.getState()
  // trim the first video clip to 4s (the linked twin follows) and music to 7s
  const clips = st.project.tracks.flatMap(t => t.clips.map(c => ({...c, kind2: t.kind})))
  const c0 = clips.find(c => c.start === 0 && c.kind2 === 'video')
  const cm = clips.find(c => c.assetId === '${assets[2].id}')
  st.trimClip(c0.id, 'out', 4)
  st.trimClip(cm.id, 'out', 7)
  const fin = window.kadrEditor.useEditor.getState()
  return {
    duration: window.kadrEditor.projectDuration(fin.project),
    clipCount: fin.project.tracks.reduce((n, t) => n + t.clips.length, 0)
  }
})()`)
// 5 clips: a + its audio twin + b + music + text; duration = b's end ≈ 8
check('timeline built: 5 clips (incl. AV twin), duration ≈8s',
  timeline.clipCount === 5 && Math.abs(timeline.duration - 8) < 0.1,
  JSON.stringify(timeline))

// 4. split at playhead — a, its twin, music and text cross t=2 (b does not)
const split = await evalJs(`(() => {
  const s = window.kadrEditor.useEditor.getState()
  s.setPlayhead(2)
  s.select([])
  s.splitAtPlayhead()
  const fin = window.kadrEditor.useEditor.getState()
  return fin.project.tracks.reduce((n, t) => n + t.clips.length, 0)
})()`)
check('split at 2s adds clips (5 -> 9: video+twin+music+text cross 2s)', split === 9, 'clips=' + split)

// 5. undo restores
const undone = await evalJs(`(() => {
  window.kadrEditor.useEditor.getState().undo()
  const fin = window.kadrEditor.useEditor.getState()
  return fin.project.tracks.reduce((n, t) => n + t.clips.length, 0)
})()`)
check('undo restores 5 clips', undone === 5, 'clips=' + undone)

// 6. preview actually composites pixels (seek to 1s, canvas not black)
const pixels = await evalJs(`(async () => {
  const s = window.kadrEditor.useEditor.getState()
  s.setPlayhead(1.0)
  await new Promise(r => setTimeout(r, 2500)) // let video seek + draw
  const canvas = document.querySelector('.preview canvas')
  const off = document.createElement('canvas')
  off.width = canvas.width; off.height = canvas.height
  const ctx = off.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  const d = ctx.getImageData(0, 0, off.width, off.height).data
  let sum = 0
  for (let i = 0; i < d.length; i += 4007 * 4) sum += d[i] + d[i + 1] + d[i + 2]
  return sum
})()`)
check('GPU preview renders non-black frame at t=1s', pixels > 1000, 'pixelSum=' + pixels)

// 7. full export through the raw ffmpeg pipeline
const exp = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const s = ed.useEditor.getState()
  const preset = ed.PRESETS.find(p => p.id === 'hd720')
  let last = null
  const progress = []
  const muxDone = new Promise((resolve) => {
    const off = window.kadr.onExportProgress(p => {
      progress.push(p.phase + ':' + p.progress.toFixed(2))
      if (p.phase === 'done' || p.phase === 'error' || p.phase === 'cancelled') { last = p; off(); resolve() }
    })
  })
  const h = ed.startExport(s.project, preset, '/tmp/kadr-test/out.mp4', () => {})
  await h.done
  await muxDone
  return { phase: last && last.phase, message: last && last.message, tail: progress.slice(-3) }
})()`, { timeout: 300000 })
check('export finished ok', exp.phase === 'done', JSON.stringify(exp))

ws.close()
console.log('e2e finished')
