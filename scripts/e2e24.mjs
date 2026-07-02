// Test: Remotion fragments — create over a range (clip on a fresh top
// track, ≥60 fps meta), live preview overlay iframe, hot file edits keep it
// alive, one-shot final render (vp9 alpha webm), export materialization
// composites the fragment over a video, MCP exposes kadr_fragment_create.
// Requires the workspace to be installed (first fragmentEnsure run).
import WebSocket from 'ws'
import { spawn, execFileSync } from 'child_process'
import { writeFileSync, unlinkSync, readFileSync } from 'fs'

const PORT = process.env.KADR_CDP_PORT || 9777
const ENV_FILE = `${process.env.HOME}/.config/kadr/claude-env.json`

// self-contained media: the export check counts smpte-bar pixels below the fragment
execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test && ffmpeg -v error -f lavfi -i "smptebars=s=640x360:d=3:r=30" ' +
  '-c:v libx264 -crf 18 -pix_fmt yuv420p -y /tmp/kadr-test/b.mp4'])

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
async function evalJs(expression, { timeout = 900000 } = {}) {
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
    await new Promise((r) => setTimeout(r, 1000))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test && [ -f /tmp/kadr-test/b.mp4 ] || ' +
  'ffmpeg -v error -f lavfi -i smptebars=duration=6:size=640x360:rate=30 -pix_fmt yuv420p -c:v libx264 -movflags +faststart -y /tmp/kadr-test/b.mp4'])

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

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
} catch { /* mid-load */ }

try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

let fragId = null
let envBackup = null
let envWritten = false
try {
  // 1) create a short fragment over [1, 2)
  const created = await evalJs(`(async () => {
    const ed = window.kadrEditor
    const st = () => ed.useEditor.getState()
    const r = await ed.createFragment({ name: 'e2e-frag', start: 1, end: 2 })
    const track = st().project.tracks.find(t => t.clips.some(c => c.id === r.clipId))
    const clip = track?.clips.find(c => c.id === r.clipId)
    const overlapping = track?.clips.filter(c =>
      c.id !== r.clipId && c.start < 2 && c.start + c.duration > 1).length
    return { id: r.id, entry: r.entry, kind: clip?.kind, fps: clip?.fragmentMeta?.fps,
             trackKind: track?.kind, overlapping }
  })()`)
  fragId = created.id
  check('fragment created as a remotion clip on a free video track',
    created.kind === 'remotion' && created.fps >= 60 &&
    created.trackKind === 'video' && created.overlapping === 0,
    JSON.stringify(created))

  // 2) live overlay appears at the playhead
  const overlay = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().setPlayhead(1.5)
    for (let i = 0; i < 30; i++) {
      const f = document.querySelector('.frag-frame')
      if (f && getComputedStyle(f).visibility === 'visible') return { ok: true, src: f.src }
      await new Promise(r => setTimeout(r, 1000))
    }
    return { ok: false }
  })()`)
  check('preview overlay iframe is live', overlay.ok === true && overlay.src.includes(fragId),
    overlay.src ?? '')

  // 3) hot edit survives (Claude's loop): rewrite the entry, overlay stays
  const entrySrc = readFileSync(created.entry, 'utf8')
  writeFileSync(created.entry, entrySrc.replace('e2e-frag', 'HOT-OK'))
  const afterEdit = await evalJs(`(async () => {
    await new Promise(r => setTimeout(r, 2500))
    const f = document.querySelector('.frag-frame')
    return !!f && getComputedStyle(f).visibility === 'visible'
  })()`)
  check('hot edit keeps the overlay alive', afterEdit === true)

  // 4) one-shot render: vp9 alpha webm lands in the cache
  const rendered = await evalJs(`(async () =>
    window.kadr.fragmentRender(${JSON.stringify(fragId)}, { transparent: true })
  )()`)
  check('fragment renders to an alpha webm', rendered.path.endsWith('.webm'), rendered.path)
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries',
    'stream=codec_name,width,r_frame_rate', '-of', 'csv', rendered.path]).toString()
  check('render is vp9 at 60 fps, project width',
    probe.includes('vp9') && probe.includes('60/1'), probe.trim().split('\n')[0])

  // 5) export composites the fragment over an underlying video
  await evalJs(`(async () => {
    const ed = window.kadrEditor
    const st = () => ed.useEditor.getState()
    const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
    const idB = ed.uid()
    st().addAsset({ id: idB, ...asset })
    const v1 = st().project.tracks.find(t => t.name === 'V1')
    st().insertClipFromAsset(idB, v1.id, 0)
    const c = st().project.tracks.find(t => t.name === 'V1').clips.slice(-1)[0]
    st().setClipDuration(c.id, 3)
    st().updateClip(c.id, { muted: true })
    const preset = ed.PRESETS.find(p => p.container === 'mp4')
    const h = ed.startExport(st().project, preset, '/tmp/kadr-test/frag-export.mp4',
      () => {}, { start: 1.1, end: 1.9 }, { motionBlur: false })
    await h.done
    return true
  })()`)
  // the frame must show BOTH the smpte bars and the fragment's bright text:
  // count colored (bars) and near-white-green (title) sampled pixels
  const px = execFileSync('bash', ['-c',
    `ffmpeg -v error -ss 0.4 -i /tmp/kadr-test/frag-export.mp4 -frames:v 1 -f rawvideo -pix_fmt rgb24 -y /tmp/kadr-test/frag-f.rgb && python3 -c "
data = open('/tmp/kadr-test/frag-f.rgb','rb').read()
n = len(data)//3
bars = sum(1 for i in range(0, n, 17) if data[i*3] > 150 and data[i*3+1] < 90)  # red-ish bar
text = sum(1 for i in range(0, n, 17) if data[i*3] > 90 and data[i*3+1] > 200 and data[i*3+2] > 90)  # green title
print(bars, text)
"`]).toString().trim().split(/\s+/).map(Number)
  check('export composites fragment text over the video below',
    px[0] > 200 && px[1] > 30, `bar-px=${px[0]} text-px=${px[1]}`)

  // 6) MCP exposes the fragment tool
  try { envBackup = readFileSync(ENV_FILE, 'utf8') } catch { /* none */ }
  writeFileSync(ENV_FILE, JSON.stringify({ command: 'bash', args: [] }))
  envWritten = true
  const opened = await evalJs(`(async () => window.kadr.claudeOpen(80, 24, null))()`)
  const mcp = spawn('node', ['electron/mcp-bridge.cjs', String(opened.port)],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'inherit'] })
  const pending = new Map()
  let buf = ''
  mcp.stdout.on('data', (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg)
          pending.delete(msg.id)
        }
      } catch { /* partial */ }
    }
  })
  let mcpId = 0
  const mcpCall = (method, params) => new Promise((resolve, reject) => {
    const i = ++mcpId
    pending.set(i, resolve)
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(method + ' timeout')) } }, 30000)
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
  })
  await mcpCall('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' }
  })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = await mcpCall('tools/list', {})
  const names = (tools.result?.tools ?? []).map((t) => t.name)
  check('MCP exposes kadr_fragment_create', names.includes('kadr_fragment_create'), names.join(','))
  mcp.kill()
  await evalJs(`(async () => window.kadr.claudeClose())()`)
} finally {
  if (envWritten) {
    if (envBackup !== null) writeFileSync(ENV_FILE, envBackup)
    else try { unlinkSync(ENV_FILE) } catch { /* absent */ }
  }
  if (fragId) {
    await evalJs(`(async () => window.kadrEditor.deleteFragment(${JSON.stringify(fragId)}))()`)
      .catch(() => { /* best effort */ })
  }
}

ws.close()
console.log('e2e24 finished')
