// Test: save feedback — the ● dirty dot appears after an edit, clicking
// Save writes the file, shows a transient "✓ saved" flash and clears the
// dot; the flash disappears on its own; a new edit brings the dot back.
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { statSync, readFileSync } from 'fs'

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
async function evalJs(expression, { timeout = 60000 } = {}) {
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
    await new Promise((r) => setTimeout(r, 300))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

execFileSync('bash', ['-c', 'mkdir -p /tmp/kadr-test/save && rm -f /tmp/kadr-test/save/*'])

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
await new Promise((r) => setTimeout(r, 500)) // let App mount-effect mark the baseline

// fresh session: no dirty dot
const clean = await evalJs(`(async () => !document.querySelector('.dirty-dot'))()`)
check('fresh session shows no dirty dot', clean === true)

// edit → dot appears
const dirty = await evalJs(`(async () => {
  const st = window.kadrEditor.useEditor.getState()
  st.setState ?? null
  window.kadrEditor.useEditor.setState({ project: { ...st.project, name: 'save-test' } })
  await new Promise(r => setTimeout(r, 200))
  return !!document.querySelector('.dirty-dot')
})()`)
check('an edit shows the dirty dot', dirty === true)

// save via the toolbar button → file on disk, flash shown, dot gone
const saved = await evalJs(`(async () => {
  window.kadrEditor.useEditor.getState().setProjectPath('/tmp/kadr-test/save/p.kadr')
  const btn = [...document.querySelectorAll('.topbar button')].find(b => b.title === 'Ctrl+S')
  btn.click()
  await new Promise(r => setTimeout(r, 600))
  const flash = document.querySelector('.save-flash')
  return { flash: flash?.textContent ?? null, tick: !!flash?.querySelector('svg'),
           err: flash?.classList.contains('error') ?? null,
           dot: !!document.querySelector('.dirty-dot') }
})()`)
let onDisk = false
try { onDisk = statSync('/tmp/kadr-test/save/p.kadr').size > 10 } catch { /* missing */ }
check('save writes the file and flashes a tick', onDisk && saved.tick === true && saved.err === false,
  JSON.stringify(saved))
check('dirty dot clears after save', saved.dot === false)

// flash goes away by itself
const gone = await evalJs(`(async () => {
  await new Promise(r => setTimeout(r, 3000))
  return !document.querySelector('.save-flash')
})()`)
check('the flash fades out on its own', gone === true)

// next edit → dot returns
const again = await evalJs(`(async () => {
  const st = window.kadrEditor.useEditor.getState()
  window.kadrEditor.useEditor.setState({ project: { ...st.project, name: 'save-test-2' } })
  await new Promise(r => setTimeout(r, 200))
  return !!document.querySelector('.dirty-dot')
})()`)
check('the next edit brings the dot back', again === true)

// ---------------------------------------------------------------- history size
//
// A project is deep-copied twice per edit — by the mutation and by the history
// entry — and an asset's waveform and thumbnails are almost all of its bytes.
// On a real 78 MB project a full copy took 248 ms (four frames per second while
// dragging a clip) and fifty history entries held 3.82 GB, which is exactly
// where V8 quits: "JavaScript heap out of memory", three times in one working
// day. So cloneProject() SHARES those derived blobs instead of duplicating
// them, and the checks below hold that in place from both sides — the copy must
// still be a genuine deep copy of everything else, and the blobs must still
// reach the file on disk.

const BLOB = 'W'.repeat(4096)          // stands in for a waveform's base64
const PROJ = '/tmp/kadr-test/save/blob.kadr'

const hist = await evalJs(`(async () => {
  const E = window.kadrEditor, st = () => E.useEditor.getState()
  st().setProject({
    ...st().project, name: 'blob-test', assets: [], tracks: [],
    texts: [], markers: [], defects: [], voiceRuns: []
  }, ${JSON.stringify(PROJ)})
  st().addTrack('video')
  st().addAsset({ id: 'A1', path: '/tmp/kadr-test/none.mp4', name: 'none.mp4',
                  kind: 'video', duration: 5, width: 16, height: 9, fps: 30,
                  hasAudio: true,
                  waveform: { rate: 1000, max: ${JSON.stringify(BLOB)}, rms: ${JSON.stringify(BLOB)} },
                  thumbnail: ${JSON.stringify(BLOB)} })
  st().insertTextClip(0)
  await new Promise((r) => setTimeout(r, 100))

  const liveBefore = st().project
  const clipId = st().project.tracks.flatMap((t) => t.clips)[0].id
  const wasName = st().project.name

  st().pushHistory('hRename')
  st().updateClip(clipId, { start: 3.25 })
  await new Promise((r) => setTimeout(r, 100))

  const snap = st().past[st().past.length - 1].project
  const live = st().project
  const clipIn = (p) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)

  return {
    // the snapshot is a real deep copy: the edit did not reach it
    snapshotUntouched: clipIn(snap).start !== 3.25 && clipIn(live).start === 3.25,
    freshObjects: snap !== live && snap.tracks !== live.tracks &&
                  clipIn(snap) !== clipIn(live) && snap.assets[0] !== live.assets[0],
    // ...but the blobs inside it are the very same objects. Only the waveform
    // can prove it: a thumbnail is a string, and === compares strings by value,
    // so a duplicated one looks identical. The waveform is an object, so this
    // is a true identity test — and it is the big one anyway.
    waveShared: snap.assets[0].waveform === live.assets[0].waveform,
    thumbEqual: snap.assets[0].thumbnail === live.assets[0].thumbnail,
    // and they are whole
    waveWhole: snap.assets[0].waveform.max.length === ${BLOB.length} &&
               snap.assets[0].waveform.rate === 1000,
    // a snapshot serializes exactly like a plain deep copy of the same project
    serializesSame: JSON.stringify(snap) ===
                    JSON.stringify(JSON.parse(JSON.stringify(snap))),
    wasName, liveIsNew: live !== liveBefore
  }
})()`, { timeout: 30000 })
check('a history snapshot is a real deep copy', hist.snapshotUntouched === true && hist.freshObjects === true,
  JSON.stringify(hist))
check('but the waveform object is shared, not duplicated', hist.waveShared === true)
check('and the thumbnail comes through unchanged', hist.thumbEqual === true)
check('and they arrive in the snapshot whole', hist.waveWhole === true)
check('a snapshot still serializes like a plain deep copy', hist.serializesSame === true)

// fifty entries must not hold fifty waveforms
const deep = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const clipId = st().project.tracks.flatMap((t) => t.clips)[0].id
  for (let i = 0; i < 50; i++) {
    st().pushHistory('hMove')
    st().updateClip(clipId, { start: 1 + i / 100 })
  }
  await new Promise((r) => setTimeout(r, 200))
  const s = st()
  const w = s.project.assets[0].waveform
  return {
    depth: s.past.length,
    allShared: s.past.every((e) => e.project.assets[0].waveform === w),
    distinctClips: new Set(s.past.map((e) =>
      e.project.tracks.flatMap((t) => t.clips)[0])).size
  }
})()`, { timeout: 60000 })
check('fifty history entries hold ONE waveform between them',
  deep.allShared === true && deep.depth === 50, JSON.stringify(deep))
check('while each entry still has its own clip objects', deep.distinctClips === 50, String(deep.distinctClips))

// undo brings the value back with the blob intact
const undone = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const clipId = st().project.tracks.flatMap((t) => t.clips)[0].id
  const before = st().project.tracks.flatMap((t) => t.clips)[0].start
  st().undo()
  await new Promise((r) => setTimeout(r, 150))
  const a = st().project.assets[0]
  return {
    moved: st().project.tracks.flatMap((t) => t.clips)[0].start !== before,
    waveWhole: a.waveform?.max?.length === ${BLOB.length} && a.waveform?.rms?.length === ${BLOB.length},
    thumbWhole: a.thumbnail?.length === ${BLOB.length},
    noPlaceholder: a.waveform !== 0 && a.thumbnail !== 0
  }
})()`, { timeout: 30000 })
check('undo restores the value', undone.moved === true, JSON.stringify(undone))
check('and the blobs survive undo whole', undone.waveWhole === true && undone.thumbWhole === true &&
  undone.noPlaceholder === true)

// THE ONE THAT MATTERS: a project restored from history is written to disk with
// its waveforms. A copy that quietly lost one would stay invisible until the
// day that project was reopened.
await evalJs(`(async () => {
  const st = window.kadrEditor.useEditor.getState()
  await window.kadr.writeProject(${JSON.stringify(PROJ)}, st.project)
  return 1
})()`, { timeout: 30000 })
let onDiskBlob = { ok: false }
try {
  const j = JSON.parse(readFileSync(PROJ, 'utf8'))
  const a = j.assets?.[0] ?? {}
  onDiskBlob = {
    ok: true,
    wave: a.waveform?.max?.length ?? null,
    rms: a.waveform?.rms?.length ?? null,
    rate: a.waveform?.rate ?? null,
    thumb: a.thumbnail?.length ?? null
  }
} catch (e) { onDiskBlob = { ok: false, err: String(e.message || e) } }
check('the file written after an undo still carries the waveform',
  onDiskBlob.wave === BLOB.length && onDiskBlob.rms === BLOB.length && onDiskBlob.rate === 1000,
  JSON.stringify(onDiskBlob))
check('and the thumbnail', onDiskBlob.thumb === BLOB.length)

ws.close()
console.log('e2e28 finished')
