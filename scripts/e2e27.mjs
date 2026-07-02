// Test: clip reversal — a luma-ramp source (brightness rises with time) is
// reversed via kadrEditor.reverseClip: the rendered file must play backwards
// (first frame brighter than last), the clip and its linked audio twin swap
// to the reversed asset with the right inPoint mapping, reversing again
// restores the original instantly, and undo works.
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

/** average luma of one frame at the start or end of a file (signalstats YAVG) */
function yavgOf(file, atEnd = false) {
  const args = [...(atEnd ? ['-sseof', '-0.15'] : []), '-i', file,
    '-vf', 'signalstats,metadata=print:file=-', '-frames:v', '1', '-f', 'null', '-']
  const out = execFileSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 8e6, stdio: ['ignore', 'pipe', 'pipe'] })
  const m = out.match(/YAVG=([\d.]+)/)
  return m ? parseFloat(m[1]) : NaN
}

// luma ramp: brightness rises with time, plus a tone so the clip links A+V
execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test/rev && rm -f /tmp/kadr-test/rev/* && ' +
  'ffmpeg -v error -f lavfi -i "color=c=black:s=320x240:d=4:r=30,geq=lum=\'40+T*50\':cb=128:cr=128" ' +
  '-f lavfi -i "sine=frequency=440:duration=4" ' +
  '-c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -shortest -y /tmp/kadr-test/rev/ramp.mp4'])

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// protect the user's live project, then start clean
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

// import + place, trimmed to source range [1s, 3s]
const setup = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/rev/ramp.mp4')
  const aid = ed.uid()
  st().addAsset({ id: aid, ...asset })
  st().insertClipFromAsset(aid, null, 0)
  const clips = st().project.tracks.flatMap(t => t.clips.map(c => ({ ...c, track: t.kind })))
  for (const c of clips) st().updateClip(c.id, { inPoint: 1, duration: 2 })
  const v = clips.find(c => c.track === 'video')
  const a = clips.find(c => c.track === 'audio')
  return { aid, videoId: v?.id ?? null, audioId: a?.id ?? null, n: clips.length,
           linked: !!v?.linkId && v?.linkId === a?.linkId }
})()`)
check('setup: linked AV pair on the timeline', setup.videoId && setup.audioId && setup.linked,
  JSON.stringify(setup))

// reverse
const rev = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  await ed.reverseClip(${JSON.stringify(setup.videoId)})
  const p = st().project
  const v = p.tracks.flatMap(t => t.clips).find(c => c.id === ${JSON.stringify(setup.videoId)})
  const a = p.tracks.flatMap(t => t.clips).find(c => c.id === ${JSON.stringify(setup.audioId)})
  const ra = p.assets.find(x => x.id === v.assetId)
  return { vAsset: v.assetId, aAsset: a.assetId, vIn: v.inPoint, aIn: a.inPoint,
           revOf: ra?.reverseOf ?? null, revPath: ra?.path ?? null, dur: ra?.duration ?? 0,
           hasAudio: ra?.hasAudio ?? false, undoLabel: st().past[st().past.length - 1]?.label }
})()`)
check('reverse swaps both linked clips to one reversed asset',
  rev.vAsset === rev.aAsset && rev.vAsset !== setup.aid, JSON.stringify({ v: rev.vAsset, a: rev.aAsset }))
check('reversed asset marks its origin range',
  rev.revOf && rev.revOf.assetId === setup.aid &&
  Math.abs(rev.revOf.start - 1) < 0.01 && Math.abs(rev.revOf.duration - 2) < 0.01,
  JSON.stringify(rev.revOf))
check('inPoint remapped (range end ↔ start)', Math.abs(rev.vIn) < 0.05 && Math.abs(rev.aIn) < 0.05,
  `vIn=${rev.vIn} aIn=${rev.aIn}`)
check('reversal pushed one undo entry', rev.undoLabel === 'hReverse', String(rev.undoLabel))
check('reversed file has audio and ~2s duration',
  rev.hasAudio && Math.abs(rev.dur - 2) < 0.2, `dur=${rev.dur}`)

// the file really plays backwards: ramp rises in the source → falls when reversed
const first = yavgOf(rev.revPath)
const last = yavgOf(rev.revPath, true)
check('luma ramp is reversed on disk (first frame brighter than last)',
  first - last > 60, `first=${first} last=${last}`)

// reverse again → instant un-reverse to the original
const back = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const t0 = Date.now()
  await ed.reverseClip(${JSON.stringify(setup.videoId)})
  const p = st().project
  const v = p.tracks.flatMap(t => t.clips).find(c => c.id === ${JSON.stringify(setup.videoId)})
  const a = p.tracks.flatMap(t => t.clips).find(c => c.id === ${JSON.stringify(setup.audioId)})
  return { vAsset: v.assetId, vIn: v.inPoint, aIn: a.inPoint, ms: Date.now() - t0 }
})()`)
check('un-reverse restores the original asset and inPoint',
  back.vAsset === setup.aid && Math.abs(back.vIn - 1) < 0.05 && Math.abs(back.aIn - 1) < 0.05,
  JSON.stringify(back))
check('un-reverse is instant (no re-render)', back.ms < 1000, `${back.ms}ms`)

// undo returns to the reversed state
const undone = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  st().undo()
  const v = st().project.tracks.flatMap(t => t.clips).find(c => c.id === ${JSON.stringify(setup.videoId)})
  return { vAsset: v.assetId }
})()`)
check('undo restores the reversed state', undone.vAsset === rev.vAsset, JSON.stringify(undone))

// double-click guard: two concurrent calls on a fresh range → one render,
// one history entry; progress events reach the page
const guard = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  await ed.reverseClip(${JSON.stringify(setup.videoId)}) // back to the original
  for (const cid of [${JSON.stringify(setup.videoId)}, ${JSON.stringify(setup.audioId)}])
    st().updateClip(cid, { inPoint: 0.5, duration: 2 }) // new range → cache miss
  let events = 0
  const off = window.kadr.onReverseProgress(() => { events++ })
  const before = st().past.length
  await Promise.all([
    ed.reverseClip(${JSON.stringify(setup.videoId)}),
    ed.reverseClip(${JSON.stringify(setup.videoId)})
  ])
  off()
  const v = st().project.tracks.flatMap(t => t.clips).find(c => c.id === ${JSON.stringify(setup.videoId)})
  const a = st().project.assets.find(x => x.id === v.assetId)
  return { added: st().past.length - before, events,
           reversed: !!a?.reverseOf, start: a?.reverseOf?.start }
})()`)
check('double invocation renders once and pushes one undo entry',
  guard.added === 1 && guard.reversed && Math.abs(guard.start - 0.5) < 0.01,
  JSON.stringify(guard))
check('reverse progress events reach the renderer', guard.events > 0, `events=${guard.events}`)

ws.close()
console.log('e2e27 finished')
