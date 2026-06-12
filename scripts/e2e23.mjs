// Test: transcription pipeline — whole-asset and range flows over a tone
// (VAD must yield zero hallucinated cues, files still written and registered
// as project texts), SRT round-trip, and the kadr_transcribe MCP tool.
import WebSocket from 'ws'
import { spawn, execFileSync } from 'child_process'
import { writeFileSync, unlinkSync, readFileSync } from 'fs'

const PORT = process.env.KADR_CDP_PORT || 9777
const ENV_FILE = `${process.env.HOME}/.config/kadr/claude-env.json`

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
    await new Promise((r) => setTimeout(r, 400))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

// tone + silence: speech recognition must produce NOTHING for this
execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test/tr && rm -f /tmp/kadr-test/tr/* && ' +
  'ffmpeg -v error -f lavfi -i "sine=frequency=440:duration=2" -ar 16000 -y /tmp/kadr-test/tr/tone.wav'])

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

// SRT round-trip
const rt = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const cues = [
    { start: 0.48, end: 2.04, text: 'Привет, мир' },
    { start: 3661.5, end: 3663.25, text: 'двё строки\\nвторая' }
  ]
  const back = ed.parseSrt(ed.cuesToSrt(cues))
  return { n: back.length, t0: back[0].text, s1: back[1].start, e1: back[1].end, t1: back[1].text }
})()`)
check('SRT round-trip preserves cues',
  rt.n === 2 && rt.t0 === 'Привет, мир' && Math.abs(rt.s1 - 3661.5) < 0.002 &&
  Math.abs(rt.e1 - 3663.25) < 0.002 && rt.t1.includes('вторая'),
  JSON.stringify(rt))

// word-level cue splitting: even groups, pause and sentence breaks honored
const sp = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const w = (s, e, t) => ({ start: s, end: e, word: t, probability: 1 })
  const segs = [{
    start: 0, end: 6.6, text: 'Раз два три четыре пять. Шесть семь',
    words: [
      w(0.0, 0.4, ' Раз'), w(0.4, 0.8, ' два'), w(0.8, 1.2, ' три'),
      w(1.2, 1.6, ' четыре'), w(1.6, 2.0, ' пять.'),
      // 1.5s pause, then a sentence break mid-run is already covered above
      w(3.5, 3.9, ' Шесть'), w(3.9, 4.3, ' семь')
    ]
  }]
  const cues = ed.segmentsToCues(segs, 10, 3)
  return cues.map(c => ({ s: +c.start.toFixed(2), e: +c.end.toFixed(2), t: c.text }))
})()`)
check('word splitting: ≤3 words, even groups, breaks on sentence and pause',
  JSON.stringify(sp) === JSON.stringify([
    { s: 10.0, e: 11.2, t: 'Раз два три' },
    { s: 11.2, e: 12.0, t: 'четыре пять.' },
    { s: 13.5, e: 14.3, t: 'Шесть семь' }
  ]),
  JSON.stringify(sp))

// whole-asset transcription of a pure tone → zero cues, files registered
const assetRes = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  ed.useEditor.setState({ project: { ...st().project, name: 'tr-test' } })
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/tr/tone.wav')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  st().insertClipFromAsset(idA, null, 0)
  const r = await ed.transcribe({ target: { kind: 'asset', assetId: idA }, model: 'base' })
  const srtStat = await window.kadr.statFile(r.srtPath)
  const txtStat = await window.kadr.statFile(r.txtPath)
  return { cues: r.segments.length, srtPath: r.srtPath, txtPath: r.txtPath,
           srtOnDisk: srtStat !== null, txtOnDisk: txtStat !== null,
           texts: (st().project.texts ?? []).length }
})()`)
check('asset flow: tone yields no hallucinated cues',
  assetRes.cues === 0, `cues=${assetRes.cues}`)
check('asset flow: srt+txt written next to media and registered',
  assetRes.srtOnDisk && assetRes.txtOnDisk && assetRes.texts === 2 &&
  assetRes.srtPath.startsWith('/tmp/kadr-test/tr/tone'),
  JSON.stringify({ srt: assetRes.srtPath, texts: assetRes.texts }))

// range transcription with relative timecodes
const rangeRes = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const r = await ed.transcribe({
    target: { kind: 'range', start: 0.2, end: 1.8 }, model: 'base', timecodes: 'relative'
  })
  const doc = (st().project.texts ?? []).find(d => d.id === r.doc.id)
  return { cues: r.segments.length, srtPath: r.srtPath, offset: doc?.offset,
           onDisk: (await window.kadr.statFile(r.srtPath)) !== null,
           texts: (st().project.texts ?? []).length }
})()`)
check('range flow: files written, relative offset recorded',
  rangeRes.onDisk && rangeRes.texts === 4 && Math.abs(rangeRes.offset - 0.2) < 1e-6 &&
  rangeRes.srtPath.includes('tr-test'),
  JSON.stringify(rangeRes))

// the MCP server exposes kadr_transcribe
let envBackup = null
try { envBackup = readFileSync(ENV_FILE, 'utf8') } catch { /* none */ }
writeFileSync(ENV_FILE, JSON.stringify({ command: 'bash', args: [] }))
try {
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
    setTimeout(() => { if (pending.has(i)) { pending.delete(i); reject(new Error(method + ' timeout')) } }, 120000)
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n')
  })
  await mcpCall('initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e', version: '0' }
  })
  mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
  const tools = await mcpCall('tools/list', {})
  const names = (tools.result?.tools ?? []).map((t) => t.name)
  check('MCP exposes kadr_transcribe', names.includes('kadr_transcribe'), names.join(','))

  const tr = await mcpCall('tools/call', {
    name: 'kadr_transcribe',
    arguments: { start: 0.2, end: 1.4, model: 'base', timecodes: 'absolute' }
  })
  const out = JSON.parse(tr.result?.content?.[0]?.text ?? '{}')
  check('kadr_transcribe runs end-to-end',
    typeof out.srtPath === 'string' && out.cues === 0 && Array.isArray(out.preview),
    JSON.stringify(out))
  mcp.kill()
  await evalJs(`(async () => window.kadr.claudeClose())()`)
} finally {
  if (envBackup !== null) writeFileSync(ENV_FILE, envBackup)
  else try { unlinkSync(ENV_FILE) } catch { /* absent */ }
}

ws.close()
console.log('e2e23 finished')
