// Test: preview proxies — importing a ≥720p video builds a 540p proxy in
// the background, the asset gets proxyPath, the media bin shows the badge,
// preview renders through the proxy; export (original sources, no audio-twin
// seeks) still produces a correct file.
import WebSocket from 'ws'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'

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
async function evalJs(expression, { timeout = 180000 } = {}) {
  const key = `r${++id}`
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
try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// 1. import a 720p video — a proxy gets built in the background
const proxied = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/hd.mp4')
  const idHd = ed.uid()
  st().addAsset({ id: idHd, ...asset })
  window.__hd = idHd
  for (let i = 0; i < 240; i++) {
    const a = st().project.assets.find(x => x.id === idHd)
    if (a?.proxyPath) return { proxyPath: a.proxyPath }
    await new Promise(r => setTimeout(r, 500))
  }
  return { proxyPath: null }
})()`, { timeout: 180000 })
check('proxy built and recorded on the asset',
  !!proxied.proxyPath && proxied.proxyPath.includes('proxies'),
  JSON.stringify(proxied))

const onDisk = proxied.proxyPath && existsSync(proxied.proxyPath)
let proxyH = 0
if (onDisk) {
  proxyH = Number(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=height', '-of', 'csv=p=0', proxied.proxyPath
  ]).toString().trim())
}
check('proxy file exists and is 540p', onDisk && proxyH === 540, `h=${proxyH}`)

// 2. media bin shows the proxy badge
const badge = await evalJs(`(() => ({
  badges: document.querySelectorAll('.proxy-badge').length
}))()`)
check('proxy badge in the media bin', badge.badges >= 1, JSON.stringify(badge))

// 3. preview renders the proxied asset (non-black pixels)
const pix = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(window.__hd, v1.id, 0)
  st().setPlayhead(1)
  await new Promise(r => setTimeout(r, 2500))
  const canvas = document.querySelector('.preview canvas')
  const off = document.createElement('canvas')
  off.width = canvas.width; off.height = canvas.height
  const ctx = off.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  const d = ctx.getImageData(0, 0, off.width, off.height).data
  let lum = 0
  for (let i = 0; i < d.length; i += 4 * 997) lum += d[i] + d[i + 1] + d[i + 2]
  return { lum }
})()`)
check('preview composites the proxied clip', pix.lum > 1000, JSON.stringify(pix))

// 4. export (original source + linked audio) completes and carries audio
const exp = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const preset = ed.PRESETS.find(p => p.container === 'mp4')
  const t0 = performance.now()
  const h = ed.startExport(ed.useEditor.getState().project, preset,
    '/tmp/kadr-test/proxy-export.mp4', () => {}, { start: 0.5, end: 2.5 })
  try {
    await h.done
    return { ok: true, ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { ok: false, err: e.message }
  }
})()`, { timeout: 300000 })
let audioStream = ''
let exportW = 0
if (exp.ok) {
  audioStream = execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', '/tmp/kadr-test/proxy-export.mp4'
  ]).toString().trim()
  exportW = Number(execFileSync('ffprobe', [
    '-v', 'error', '-select_streams', 'v:0',
    '-show_entries', 'stream=width', '-of', 'csv=p=0', '/tmp/kadr-test/proxy-export.mp4'
  ]).toString().trim())
}
check('export completes with audio (no audio-twin seeks)',
  exp.ok && audioStream === 'aac' && exportW === 1920,
  JSON.stringify({ ...exp, audioStream, exportW }))

ws.close()
console.log('e2e16 finished')
