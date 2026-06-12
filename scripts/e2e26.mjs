// Test: autosave (writes <name>.autosave.kadr next to the project, skips
// while exporting/Claude is active, skips unchanged) and auto-captions
// (generated caption fragment from synthetic word cues, live overlay,
// mouse gizmo moves/scales the clip transform).
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { statSync, unlinkSync } from 'fs'

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
    await new Promise((r) => setTimeout(r, 800))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test/as && rm -f /tmp/kadr-test/as/* && ' +
  '[ -f /tmp/kadr-test/b.mp4 ] || ffmpeg -v error -f lavfi -i smptebars=duration=6:size=640x360:rate=30 -pix_fmt yuv420p -c:v libx264 -movflags +faststart -y /tmp/kadr-test/b.mp4'])

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

// ---- autosave -------------------------------------------------------------
const as = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idB = ed.uid()
  st().addAsset({ id: idB, ...asset })
  st().insertClipFromAsset(idB, null, 0)
  // pretend the user saved here once
  await window.kadr.writeProject('/tmp/kadr-test/as/proj.kadr', st().project)
  st().setProjectPath('/tmp/kadr-test/as/proj.kadr')

  await ed.autosaveNow()
  const after1 = await window.kadr.statFile('/tmp/kadr-test/as/proj.autosave.kadr')

  // unchanged project → no rewrite
  await new Promise(r => setTimeout(r, 60))
  await ed.autosaveNow()
  const after2 = await window.kadr.statFile('/tmp/kadr-test/as/proj.autosave.kadr')

  // changed project, but exporting → skipped
  st().updateClip(st().project.tracks.flatMap(t => t.clips)[0].id, { label: 'touched' })
  ed.activity.exporting = true
  await ed.autosaveNow()
  const during = await window.kadr.statFile('/tmp/kadr-test/as/proj.autosave.kadr')
  ed.activity.exporting = false

  // …and written again once the export flag clears
  await new Promise(r => setTimeout(r, 60))
  await ed.autosaveNow()
  const after3 = await window.kadr.statFile('/tmp/kadr-test/as/proj.autosave.kadr')
  const restored = JSON.parse(await window.kadr.readTextFile('/tmp/kadr-test/as/proj.autosave.kadr'))
  return { after1, same: after2 === after1, skipped: during === after1,
           rewritten: after3 > after1, label: restored.tracks.flatMap(t=>t.clips)[0].label }
})()`)
check('autosave writes <name>.autosave.kadr next to the project', as.after1 !== null)
check('unchanged project is not rewritten', as.same === true)
check('autosave skipped while exporting, written after', as.skipped && as.rewritten && as.label === 'touched',
  JSON.stringify({ skipped: as.skipped, rewritten: as.rewritten, label: as.label }))

// ---- auto captions (synthetic cues, no speech needed) ----------------------
const cap = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const frag = await ed.createFragment({ name: 'captions', start: 0.5, end: 3.5, transparent: true })
  const cues = [
    { start: 0.2, end: 1.1, text: 'Привет мир', words: [
      { word: 'Привет', start: 0.2, end: 0.6 }, { word: 'мир', start: 0.6, end: 1.1 } ] },
    { start: 1.4, end: 2.6, text: 'Это авто субтитры', words: [
      { word: 'Это', start: 1.4, end: 1.7 }, { word: 'авто', start: 1.7, end: 2.1 },
      { word: 'субтитры', start: 2.1, end: 2.6 } ] }
  ]
  const code = ed.captionsTsx(cues, { fontFamily: 'sans-serif', fontSize: 72, bold: true,
    color: '#ffffff', highlightColor: '#ffd23f', entrance: 'pop', highlight: 'color', speed: 1 })
  await window.kadr.writeTextFile(frag.entry, code)
  st().updateClip(frag.clipId, { transform: {
    ...st().project.tracks.flatMap(t=>t.clips).find(c=>c.id===frag.clipId).transform,
    y: { value: Math.round(st().project.height * 0.3) } } })
  st().select([frag.clipId])
  st().setPlayhead(1.0) // mid first cue
  for (let i = 0; i < 30; i++) {
    if (document.querySelector('.frag-frame')) break
    await new Promise(r => setTimeout(r, 1000))
  }
  await new Promise(r => setTimeout(r, 2500)) // hot reload of the entry
  return { fragId: frag.id, clipId: frag.clipId,
    overlay: !!document.querySelector('.frag-frame'),
    gizmo: !!document.querySelector('.frag-gizmo') }
})()`)
check('caption fragment overlays live + gizmo on selection', cap.overlay && cap.gizmo,
  JSON.stringify(cap))

// mouse drag on the gizmo moves the clip transform
const drag = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const clip = () => st().project.tracks.flatMap(t => t.clips).find(c => c.id === ${JSON.stringify(cap.clipId)})
  const before = { x: clip().transform.x.value, y: clip().transform.y.value }
  const g = document.querySelector('.frag-gizmo')
  const r = g.getBoundingClientRect()
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2
  const opts = { bubbles: true, pointerId: 1, isPrimary: true }
  g.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: cx, clientY: cy }))
  g.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: cx + 40, clientY: cy - 25 }))
  g.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: cx + 40, clientY: cy - 25 }))
  await new Promise(r2 => setTimeout(r2, 300))
  const after = { x: clip().transform.x.value, y: clip().transform.y.value }
  const undoLabel = st().past[st().past.length - 1]?.label
  return { before, after, undoLabel,
    moved: after.x > before.x + 10 && after.y < before.y - 5 }
})()`)
check('gizmo drag moves the captions (with an undo entry)',
  drag.moved && !!drag.undoLabel, JSON.stringify(drag))

// cleanup
await evalJs(`(async () => window.kadr.fragmentDelete(${JSON.stringify(cap.fragId)}))()`)
  .catch(() => { /* best effort */ })
try { unlinkSync('/tmp/kadr-test/as/proj.autosave.kadr') } catch { /* gone */ }

ws.close()
console.log('e2e26 finished')
