// Smoke test for: Audacity waveforms, fades, loop-extend, speed, range delete,
// hardware encoder availability, export with all of the above.
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
await new Promise((r) => setTimeout(r, 1500))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// 1. waveform data present and dense
const wf = await evalJs(`(async () => {
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  window.__assetA = asset
  const w = asset.waveform
  return w ? { rate: w.rate, bins: atob(w.max).length, rms: atob(w.rms).length, dur: asset.duration } : null
})()`)
check('waveform: ~1000 bins/sec with rms', !!wf && wf.rate > 900 && Math.abs(wf.bins - wf.dur * wf.rate) < wf.rate,
  JSON.stringify(wf))

// 2. timeline: looped+faded clip, speed clip; range delete sanity
const tl = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const idA = ed.uid()
  st().addAsset({ id: idA, ...window.__assetA })
  const { asset: b } = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idB = ed.uid()
  st().addAsset({ id: idB, ...b })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  let clipA = st().project.tracks.find(t => t.name === 'V1').clips[0]
  // extend past the source (loop) + fades
  st().updateClip(clipA.id, { duration: 9, fadeIn: 1, fadeOut: 1 })
  st().insertClipFromAsset(idB, v1.id, 9)
  let clipB = st().project.tracks.find(t => t.name === 'V1').clips[1]
  st().updateClip(clipB.id, { duration: b.duration / 2, speed: 2 })
  const dur = ed.projectDuration(st().project)
  // range delete on a scratch copy of state: use range 20..21 (empty) then real one
  return { dur, clips: st().project.tracks.find(t => t.name === 'V1').clips.map(c => [c.start, +c.duration.toFixed(3), c.speed]) }
})()`)
check('timeline: loop 9s + speed×2 ≈ 2.01s', Math.abs(tl.dur - 11.012) < 0.05, JSON.stringify(tl))

// 3. deleteRange splits correctly
const dr = await evalJs(`(() => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  st().setRange({ start: 2, end: 3 })
  st().deleteRange()
  const clips = st().project.tracks.find(t => t.name === 'V1').clips
    .map(c => [+c.start.toFixed(2), +c.duration.toFixed(2)]).sort((a, b) => a[0] - b[0])
  st().undo()
  st().setRange(null)
  return clips
})()`)
// numeric tolerance on the third clip: it is b.mp4/2, and the exact container
// duration of the generated file varies slightly (4.02 s with aac, 4.00 without)
const drOk = dr.length === 3 &&
  Math.abs(dr[0][0] - 0) < 0.01 && Math.abs(dr[0][1] - 2) < 0.01 &&
  Math.abs(dr[1][0] - 3) < 0.01 && Math.abs(dr[1][1] - 6) < 0.01 &&
  Math.abs(dr[2][0] - 9) < 0.01 && Math.abs(dr[2][1] - 2) < 0.05
check('deleteRange 2..3 splits clip into [0,2]+[3,6]', drOk, JSON.stringify(dr))

// 4. hardware encoder availability (informational)
const hw = await evalJs(`(async () => {
  const cfg = { codec: 'avc1.640028', width: 1280, height: 720, bitrate: 8000000, framerate: 30 }
  const h = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: 'prefer-hardware' }).catch(() => null)
  const s = await VideoEncoder.isConfigSupported({ ...cfg, hardwareAcceleration: 'prefer-software' }).catch(() => null)
  return { hardware: !!(h && h.supported), software: !!(s && s.supported) }
})()`)
console.log(`INFO  encoders: hardware=${hw.hardware} software=${hw.software}`)
check('some encoder available', hw.hardware || hw.software)

// 5. export with loop+fade+speed
const exp = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const preset = ed.PRESETS.find(p => p.id === 'hd720')
  let last = null
  const muxDone = new Promise((resolve) => {
    const off = window.kadr.onExportProgress(p => {
      if (['done','error','cancelled'].includes(p.phase)) { last = p; off(); resolve() }
    })
  })
  const t0 = performance.now()
  const h = ed.startExport(st().project, preset, '/tmp/kadr-test/out3.mp4', () => {})
  await h.done
  await muxDone
  return { phase: last && last.phase, message: last && last.message, sec: ((performance.now() - t0) / 1000).toFixed(1) }
})()`)
check('export with loop/fade/speed finished', exp.phase === 'done', JSON.stringify(exp))

ws.close()
console.log('e2e3 finished')
