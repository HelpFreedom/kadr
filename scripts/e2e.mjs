// End-to-end smoke test driven over the Chrome DevTools Protocol.
// Requires the app running with --remote-debugging-port=9777.
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

function evalJs(expression, { awaitPromise = true, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const timer = setTimeout(() => reject(new Error('eval timeout: ' + expression.slice(0, 80))), timeout)
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      clearTimeout(timer)
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)))
      const r = msg.result.result
      if (msg.result.exceptionDetails) {
        return reject(new Error('JS exception: ' + JSON.stringify(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text)))
      }
      resolve(r.value)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({
      id: msgId,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise, returnByValue: true }
    }))
  })
}

function check(name, cond, extra = '') {
  const ok = !!cond
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!ok) process.exitCode = 1
}

const url = await getPageWs()
ws = new WebSocket(url)
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

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
               hasAudio: asset.hasAudio, peaks: (asset.peaks || []).length, thumb: !!asset.thumbnail })
  }
  return out
})()`)
check('probe a.mp4: video 1280x720 ~6s with audio+thumb+peaks',
  assets[0].kind === 'video' && assets[0].w === 1280 && Math.abs(assets[0].duration - 6) < 0.2 &&
  assets[0].hasAudio && assets[0].thumb && assets[0].peaks > 100,
  JSON.stringify(assets[0]))
check('probe music.mp3: audio with peaks', assets[2].kind === 'audio' && assets[2].hasAudio && assets[2].peaks > 100)

// 3. build a timeline: a.mp4 [0..4], b.mp4 [4..7] on V1, music on A1, text overlay on V2
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
  // trim first clip to 4s, music to 7s
  const clips = st.project.tracks.flatMap(t => t.clips.map(c => ({...c, track: t.name, kind2: t.kind})))
  const c0 = clips.find(c => c.start === 0 && c.kind2 === 'video')
  const cm = clips.find(c => c.kind2 === 'audio')
  st.trimClip(c0.id, 'out', 4)
  st.trimClip(cm.id, 'out', 7)
  const fin = window.kadrEditor.useEditor.getState()
  return {
    duration: window.kadrEditor.projectDuration(fin.project),
    clipCount: fin.project.tracks.reduce((n, t) => n + t.clips.length, 0)
  }
})()`)
check('timeline built: 4 clips, duration 7s', timeline.clipCount === 4 && Math.abs(timeline.duration - 7) < 0.01,
  JSON.stringify(timeline))

// 4. split at playhead
const split = await evalJs(`(() => {
  const s = window.kadrEditor.useEditor.getState()
  s.setPlayhead(2)
  s.select([])
  s.splitAtPlayhead()
  const fin = window.kadrEditor.useEditor.getState()
  return fin.project.tracks.reduce((n, t) => n + t.clips.length, 0)
})()`)
check('split at 2s adds clips (4 -> 7: video+text+audio cross 2s)', split === 7, 'clips=' + split)

// 5. undo restores
const undone = await evalJs(`(() => {
  window.kadrEditor.useEditor.getState().undo()
  const fin = window.kadrEditor.useEditor.getState()
  return fin.project.tracks.reduce((n, t) => n + t.clips.length, 0)
})()`)
check('undo restores 4 clips', undone === 4, 'clips=' + undone)

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

// 7. full export through WebCodecs + ffmpeg
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
