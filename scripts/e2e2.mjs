// Smoke test for: close-gap, copy/paste, range export, range overlay.
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
function rawEval(expression) {
  return new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      ws.off('message', onMsg)
      if (msg.error) return reject(new Error(JSON.stringify(msg.error)))
      if (msg.result.exceptionDetails) {
        return reject(new Error('JS exception: ' + (msg.result.exceptionDetails.exception?.description || msg.result.exceptionDetails.text)))
      }
      resolve(msg.result.result.value)
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id: msgId, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
  })
}

// CDP awaitPromise is unreliable under GC pressure ("Promise was collected"),
// so async results are parked in a global and polled synchronously.
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

// fresh page so state from previous runs doesn't leak in
try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1500))

// wait until the renderer has fully booted (HMR reloads can collect promises)
for (let i = 0; i < 30; i++) {
  try {
    if (await evalJs(`!!window.kadrEditor && !!window.kadr`, { timeout: 5000 })) break
  } catch { /* page mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// setup: video at [0..2] and [5..7] on V1 (gap 2..5), music on A1
const setup = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const { asset: av } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const { asset: am } = await window.kadr.probeMedia('/tmp/kadr-test/music.mp3')
  const s = ed.useEditor.getState()
  const vid = ed.uid(), mus = ed.uid()
  s.addAsset({ id: vid, ...av })
  s.addAsset({ id: mus, ...am })
  const st = () => ed.useEditor.getState()
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  const a1 = st().project.tracks.find(t => t.kind === 'audio')
  st().insertClipFromAsset(vid, v1.id, 0)
  st().insertClipFromAsset(vid, v1.id, 5)
  st().insertClipFromAsset(mus, a1.id, 0)
  const clips = st().project.tracks.find(t => t.name === 'V1').clips
  st().trimClip(clips[0].id, 'out', 2)
  st().trimClip(clips[1].id, 'out', 7)
  return { v1: v1.id, starts: st().project.tracks.find(t => t.name === 'V1').clips.map(c => [c.start, c.duration]) }
})()`)
check('setup: clips at 0(2s) and 5(2s)', JSON.stringify(setup.starts) === '[[0,2],[5,2]]', JSON.stringify(setup.starts))

// 1. close gap with Ctrl+click logic
const gap = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  st().closeGapAt('${setup.v1}', 3.5)
  return st().project.tracks.find(t => t.id === '${setup.v1}').clips.map(c => c.start).sort((a,b)=>a-b)
})()`)
check('closeGapAt joins clips (0, 2)', JSON.stringify(gap) === '[0,2]', JSON.stringify(gap))

// 2. copy/paste
const cp = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const clip = st().project.tracks.find(t => t.id === '${setup.v1}').clips[0]
  st().select([clip.id])
  st().copySelection()
  st().setPlayhead(10)
  st().pasteAtPlayhead()
  const clips = st().project.tracks.find(t => t.id === '${setup.v1}').clips
  return { count: clips.length, pasted: clips.map(c => c.start).sort((a,b)=>a-b) }
})()`)
check('paste at playhead 10', cp.count === 3 && cp.pasted.includes(10), JSON.stringify(cp))

// undo chain: paste -> gap -> trims... verify multiple undos work
const undo = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  st().undo() // paste
  const afterPasteUndo = st().project.tracks.find(t => t.id === '${setup.v1}').clips.length
  st().undo() // close gap
  const starts = st().project.tracks.find(t => t.id === '${setup.v1}').clips.map(c => c.start).sort((a,b)=>a-b)
  return { afterPasteUndo, starts: JSON.stringify(starts) }
})()`)
check('multi-undo: paste undone, gap restored', undo.afterPasteUndo === 2 && undo.starts === '[0,5]', JSON.stringify(undo))

// 3. range export 1..3s
const exp = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  st().setRange({ start: 1, end: 3 })
  const preset = ed.PRESETS.find(p => p.id === 'hd720')
  let last = null
  const muxDone = new Promise((resolve) => {
    const off = window.kadr.onExportProgress(p => {
      if (['done','error','cancelled'].includes(p.phase)) { last = p; off(); resolve() }
    })
  })
  const h = ed.startExport(st().project, preset, '/tmp/kadr-test/frag.mp4', () => {}, st().range)
  await h.done
  await muxDone
  return { phase: last && last.phase, message: last && last.message }
})()`)
check('range export finished', exp.phase === 'done', JSON.stringify(exp))

// 4. range overlay is rendered in the DOM
const overlay = await evalJs(`(() => {
  const el = document.querySelector('.range-overlay')
  if (!el) return null
  return { left: el.style.left, width: el.style.width }
})()`)
check('range overlay visible', !!overlay, JSON.stringify(overlay))

ws.close()
console.log('e2e2 finished')
