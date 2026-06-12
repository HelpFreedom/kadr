// Test: fast export decode (mp4box + WebCodecs) vs the element-seek path.
// Same project (overlap crossfade, looping clip with an in-point, linked
// audio) exported through both; the outputs must match (PSNR) and the fast
// path must actually be used and faster.
import WebSocket from 'ws'
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
async function evalJs(expression, { timeout = 300000 } = {}) {
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

// setup: a (0..6) + b at 4 (crossfade overlap) on V1; on V2 a looping clip
// with a deep in-point at half opacity — exercises the demuxer jump path
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const a = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const b = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idA = ed.uid(), idB = ed.uid()
  st().addAsset({ id: idA, ...a.asset })
  st().addAsset({ id: idB, ...b.asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  const v2 = st().project.tracks.find(t => t.name === 'V2')
  st().insertClipFromAsset(idA, v1.id, 0)
  st().insertClipFromAsset(idB, v1.id, 4)
  st().insertClipFromAsset(idB, v2.id, 0)
  const top = st().project.tracks.find(t => t.name === 'V2').clips[0]
  st().updateClip(top.id, {
    inPoint: 1,
    transform: { ...top.transform, opacity: { value: 0.5 }, scale: { value: 0.5 } }
  })
  st().setClipDuration(top.id, 6.5) // span 3s → loops twice
  st().select([])
  // console hook to see which decode path each clip takes
  window.__logs = []
  const orig = console.info
  console.info = (...args) => { window.__logs.push(args.join(' ')); orig(...args) }
  return true
})()`)

const runExport = (out, disable) => evalJs(`(async () => {
  globalThis.KADR_DISABLE_FAST_DECODE = ${disable}
  const ed = window.kadrEditor
  const preset = ed.PRESETS.find(p => p.container === 'mp4')
  const t0 = performance.now()
  const h = ed.startExport(ed.useEditor.getState().project, preset,
    '${out}', () => {}, { start: 3.0, end: 6.5 })
  await h.done
  return { ms: Math.round(performance.now() - t0) }
})()`, { timeout: 600000 })

// 1. fast path export
const fast = await runExport('/tmp/kadr-test/exp-fast.mp4', false)
const logsFast = await evalJs(`(() => { const l = window.__logs; window.__logs = []; return l })()`)
const usedWebcodecs = logsFast.filter((l) => l.includes('export decode') && l.includes('webcodecs')).length
check('fast path engaged for the mp4 clips', usedWebcodecs >= 3,
  `webcodecs sources: ${usedWebcodecs}, ${fast.ms}ms`)

// 2. element path export of the identical project
const slow = await runExport('/tmp/kadr-test/exp-slow.mp4', true)
const logsSlow = await evalJs(`(() => { const l = window.__logs; window.__logs = []; return l })()`)
const usedElement = logsSlow.filter((l) => l.includes('export decode') && l.includes('element')).length
check('fallback path still works (forced)', usedElement >= 3,
  `element sources: ${usedElement}, ${slow.ms}ms`)

// 3. the two exports show the same picture (PSNR over every frame)
let psnr = 0
try {
  execFileSync('ffmpeg', [
    '-v', 'info', '-i', '/tmp/kadr-test/exp-fast.mp4', '-i', '/tmp/kadr-test/exp-slow.mp4',
    '-lavfi', 'psnr', '-f', 'null', '-'
  ], { stdio: ['ignore', 'pipe', 'pipe'] })
} catch { /* ffmpeg writes the stats to stderr and may exit 0 anyway */ }
const stderr = execFileSync('bash', ['-c',
  `ffmpeg -i /tmp/kadr-test/exp-fast.mp4 -i /tmp/kadr-test/exp-slow.mp4 -lavfi psnr -f null - 2>&1 | grep -o 'average:[0-9.inf]*' | head -1`
]).toString().trim()
psnr = stderr.includes('inf') ? 99 : Number(stderr.split(':')[1] || 0)
check('both paths render the same picture (PSNR ≥ 32 dB)', psnr >= 32, `psnr ${stderr}`)

// 4. fast is measurably faster
check('fast decode beats element seeks', fast.ms * 1.15 < slow.ms,
  `fast ${fast.ms}ms vs element ${slow.ms}ms (×${(slow.ms / fast.ms).toFixed(2)})`)

ws.close()
console.log('e2e17 finished')
