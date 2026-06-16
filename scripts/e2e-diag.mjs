// Diagnostic for the "GPU preview renders non-black frame" failure.
// Run the app with --remote-debugging-port=9777, then: node scripts/e2e-diag.mjs
import WebSocket from 'ws'

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
function evalJs(expression, { awaitPromise = true, timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const timer = setTimeout(() => reject(new Error('eval timeout')), timeout)
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      clearTimeout(timer)
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)))
      if (msg.result.exceptionDetails)
        return reject(new Error('JS exception: ' + JSON.stringify(msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text)))
      resolve(msg.result.result.value)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, awaitPromise, returnByValue: true } }))
  })
}

const url = await getPageWs()
ws = new WebSocket(url)
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

try { await evalJs('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try { if (await evalJs(`!!window.kadrEditor && !!window.kadr`)) break } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// Report the WebGL renderer SwiftShader actually gave us.
const glInfo = await evalJs(`(() => {
  const c = document.createElement('canvas')
  const gl = c.getContext('webgl2')
  if (!gl) return { webgl2: false }
  const dbg = gl.getExtension('WEBGL_debug_renderer_info')
  return {
    webgl2: true,
    vendor: gl.getParameter(gl.VENDOR),
    renderer: gl.getParameter(gl.RENDERER),
    unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(no ext)'
  }
})()`)
console.log('GL:', JSON.stringify(glInfo))

// Does this Chromium build support H.264 at all — in <video> and in WebCodecs?
await evalJs(`(() => {
  window.__codec = 'pending'
  ;(async () => {
    const out = {}
    try {
      out.mse_h264_high = !!(window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028, mp4a.40.2"'))
      out.mse_h264_base = !!(window.MediaSource && MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"'))
      const probeEl = document.createElement('video')
      out.canPlayMp4 = probeEl.canPlayType('video/mp4; codecs="avc1.640028"')
      if (window.VideoDecoder) {
        out.webcodecs_h264 = (await VideoDecoder.isConfigSupported({ codec: 'avc1.640028' })).supported
      } else out.webcodecs = 'no VideoDecoder'
      // confirm the protocol now sends Content-Type
      const r = await fetch(window.kadr.fileUrl('/tmp/kadr-test/a.mp4'), { headers: { Range: 'bytes=0-1023' } })
      out.fetchStatus = r.status
      out.fetchContentType = r.headers.get('content-type')
    } catch (e) { out.err = e && e.message }
    window.__codec = JSON.stringify(out)
  })()
  return 0
})()`, { awaitPromise: false })
for (let i = 0; i < 20; i++) {
  const st = await evalJs(`window.__codec`, { awaitPromise: false })
  if (st !== 'pending') { console.log('CODEC:', st); break }
  await new Promise((r) => setTimeout(r, 400))
}

// Build the same timeline as e2e.mjs (one video clip + text), seek to 1s.
// awaitPromise is flaky under GC (see CLAUDE.md) — park the result and poll.
await evalJs(`(() => {
  window.__diag = 'pending'
  ;(async () => {
    try {
      const ed = window.kadrEditor
      const s = ed.useEditor.getState()
      const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
      const aid = ed.uid()
      s.addAsset({ id: aid, ...asset })
      const v1 = s.project.tracks.find(t => t.name === 'V1')
      s.insertClipFromAsset(aid, v1.id, 0)
      ed.useEditor.getState().setPlayhead(1.0)
      window.__diag = 'done'
    } catch (e) { window.__diag = 'error: ' + (e && e.message) }
  })()
  return 0
})()`, { awaitPromise: false })

for (let i = 0; i < 30; i++) {
  const st = await evalJs(`window.__diag`, { awaitPromise: false })
  if (st !== 'pending') { console.log('build:', st); break }
  await new Promise((r) => setTimeout(r, 500))
}

await new Promise((r) => setTimeout(r, 3000))

const diag = await evalJs(`(() => {
  const canvases = [...document.querySelectorAll('.preview canvas')]
  const canvas = canvases[0]
  const out = { canvasCount: canvases.length }
  if (!canvas) return { ...out, error: 'no canvas' }
  out.w = canvas.width; out.h = canvas.height
  out.cssW = canvas.clientWidth; out.cssH = canvas.clientHeight

  // video elements in the media pool
  const vids = [...document.querySelectorAll('video')].map(v => ({
    readyState: v.readyState, currentTime: +v.currentTime.toFixed(2),
    w: v.videoWidth, h: v.videoHeight, paused: v.paused, src: (v.src||v.currentSrc||'').slice(0,60)
  }))
  out.videos = vids

  // try a direct GL readback from the live context (most reliable)
  const gl = canvas.getContext('webgl2')
  out.hasGlCtx = !!gl
  if (gl) {
    const px = new Uint8Array(canvas.width * canvas.height * 4)
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px)
    let glSum = 0, glMax = 0
    for (let i = 0; i < px.length; i += 4) { const v = px[i]+px[i+1]+px[i+2]; glSum += v; if (v>glMax) glMax=v }
    out.glReadPixelsSum = glSum
    out.glReadPixelsMax = glMax
  }

  // 2D drawImage readback (what the test does)
  const off = document.createElement('canvas')
  off.width = canvas.width; off.height = canvas.height
  const ctx = off.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  const d = ctx.getImageData(0, 0, off.width, off.height).data
  let drawSum = 0, drawMax = 0
  for (let i = 0; i < d.length; i += 4) { const v = d[i]+d[i+1]+d[i+2]; drawSum += v; if (v>drawMax) drawMax=v }
  out.drawImageSum = drawSum
  out.drawImageMax = drawMax
  return out
})()`, { awaitPromise: false })
console.log('DIAG:', JSON.stringify(diag, null, 2))

// Isolate the video decode pipeline: a bare <video> on the kadr:// URL.
await evalJs(`(() => {
  window.__vid = 'pending'
  const v = document.createElement('video')
  v.muted = true; v.preload = 'auto'; v.crossOrigin = 'anonymous'
  const url = window.kadr.fileUrl('/tmp/kadr-test/a.mp4')
  window.__vidUrl = url
  v.src = url
  v.onerror = () => { window.__vid = 'error: ' + (v.error ? v.error.code + ' ' + v.error.message : '?') }
  v.onloadeddata = () => { window.__vid = 'loadeddata rs=' + v.readyState + ' ' + v.videoWidth + 'x' + v.videoHeight }
  v.load()
  v.currentTime = 1.0
  window.__vidEl = v
  return url
})()`, { awaitPromise: false })

for (let i = 0; i < 16; i++) {
  await new Promise((r) => setTimeout(r, 500))
  const st = await evalJs(`window.__vid + ' | rs=' + (window.__vidEl ? window.__vidEl.readyState : '?') + ' net=' + (window.__vidEl ? window.__vidEl.networkState : '?')`, { awaitPromise: false })
  if (!st.startsWith('pending')) { console.log('bareVideo:', st, 'url=', await evalJs('window.__vidUrl', { awaitPromise: false })); break }
  if (i === 15) console.log('bareVideo: still', st, 'url=', await evalJs('window.__vidUrl', { awaitPromise: false }))
}

ws.close()
