// Test: the GPU context lifecycle (reported from outside as PR #10).
//
// 1. Every export builds its own Compositor on a detached canvas. Without
//    dispose() that context lived until GC got round to the canvas — measured
//    up to 4 stranded at once over 25 exports, each pinning command-buffer
//    memory, and Chromium force-loses the OLDEST context (the preview's) once
//    a renderer holds 16.
// 2. A lost context makes every GL call a silent no-op: readPixels leaves its
//    buffer untouched, so an export would finish "successfully" as a black
//    file and the preview would go black and stay black.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
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
    await new Promise((r) => setTimeout(r, 500))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// start from a pristine page: this suite patches getContext, and a leftover
// patch from an earlier run would wrap it and swallow the tagging
await rawEval('location.reload()')
await new Promise((r) => setTimeout(r, 5000))
for (let i = 0; i < 60; i++) {
  try { if (await rawEval('!!window.kadrEditor && !!window.kadr')) break } catch { /* reloading */ }
  await new Promise((r) => setTimeout(r, 1000))
}

try {
  // one clip, small frame — these exports only need to run, not look like anything
  await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().setProject({ ...st().project, width: 640, height: 360, fps: 30, tracks: [], assets: [] }, null)
    st().addTrack('video'); st().addTrack('audio')
    const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
    const id = E.uid(); st().addAsset({ id, ...asset })
    st().insertClipFromAsset(id, null, 0)
    // watch every webgl2 context the page makes; WeakRefs so the probe itself
    // never keeps one alive, and each context is tagged so repeat look-ups
    // (getContext hands back the SAME object) are not counted twice
    if (!window.__gl) {
      const orig = HTMLCanvasElement.prototype.getContext
      const L = window.__gl = { refs: [], created: 0, last: null, orig }
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        const g = orig.call(this, type, ...rest)
        if (type === 'webgl2' && g && !g.__e2e35) {
          g.__e2e35 = ++L.created
          L.refs.push(new WeakRef(g))
          L.last = g
        }
        return g
      }
    }
    return 1
  })()`)

  const runExport = (range, out) => evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const preset = E.PRESETS.find((p) => p.id === 'hd720')
    const muxDone = new Promise((resolve) => {
      const off = window.kadr.onExportProgress((p) => {
        if (['done', 'error', 'cancelled'].includes(p.phase)) { off(); resolve(p.phase) }
      })
    })
    const h = E.startExport(st().project, preset, ${JSON.stringify(out)}, () => {}, ${JSON.stringify(range)})
    try { await h.done } catch (e) { return 'threw: ' + String(e && e.message || e) }
    return await muxDone
  })()`, { timeout: 240000 })

  // ---- 1. an export must not strand a live GPU context
  const stats = () => evalJs(`(() => {
    const L = window.__gl
    let aliveNotLost = 0
    for (const r of L.refs) { const g = r.deref(); if (g && !g.isContextLost()) aliveNotLost++ }
    const cv = document.querySelector('.preview-canvas-wrap canvas') || document.querySelector('canvas')
    // reach the preview context through the UNPATCHED getContext: asking the
    // patched one would enrol the preview in the tracked set and read as a leak
    const pg = cv && L.orig.call(cv, 'webgl2')
    return { created: L.created, aliveNotLost, previewLost: pg ? pg.isContextLost() : null }
  })()`)

  const base = await stats()
  let worst = 0
  for (let i = 1; i <= 4; i++) {
    const phase = await runExport({ start: 0, end: 0.3 }, '/tmp/kadr-test/ctx-leak.mp4')
    const s = await stats()
    check(`export ${i} finishes`, phase === 'done', `${phase}, extra live contexts now: ${s.aliveNotLost - base.aliveNotLost}`)
    // the preview's context is the only one that may still be live
    worst = Math.max(worst, s.aliveNotLost - base.aliveNotLost)
  }
  const after = await stats()
  check('four exports built four compositors', after.created - base.created === 4, `${after.created - base.created}`)
  check('no export leaves a live GPU context behind', worst === 0, `worst extra live contexts: ${worst}`)
  check('the preview context is untouched by exports', after.previewLost === false)

  // ---- 2. a context lost mid-export must fail the run, not blacken it
  const lost = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const preset = E.PRESETS.find((p) => p.id === 'hd720')
    window.__gl.last = null
    let phase = null
    const off = window.kadr.onExportProgress((p) => { if (['done','error','cancelled'].includes(p.phase)) phase = p.phase })
    const h = E.startExport(st().project, preset, '/tmp/kadr-test/ctx-lost.mp4', () => {}, { start: 0, end: 6 })
    // getExtension returns null once a context is lost, so take the handle
    // while the run is still going, then pull the rug out
    let ext = null
    for (let i = 0; i < 40 && !ext; i++) {
      await new Promise((r) => setTimeout(r, 100))
      const g = window.__gl.last
      if (g && !g.isContextLost()) ext = g.getExtension('WEBGL_lose_context')
    }
    if (!ext) return { reached: false }
    ext.loseContext()
    let threw = null
    try { await h.done } catch (e) { threw = String(e && e.message || e) }
    await new Promise((r) => setTimeout(r, 1500))
    off()
    return { reached: true, threw, phase }
  })()`, { timeout: 240000 })
  check('the running export compositor was reachable', lost.reached === true)
  check('losing the context mid-export fails loudly', /context lost/i.test(lost.threw || ''), lost.threw || 'no error thrown')
  check('and the export never reports success', lost.phase !== 'done', `phase=${lost.phase}`)

  // ---- 3. the preview survives a lost context instead of going black for good
  const prev = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    const cv = document.querySelector('.preview-canvas-wrap canvas') || document.querySelector('canvas')
    const gl = cv.getContext('webgl2')
    const bright = () => {
      const c2 = document.createElement('canvas'); c2.width = cv.width; c2.height = cv.height
      c2.getContext('2d').drawImage(cv, 0, 0)
      const d = c2.getContext('2d').getImageData(0, 0, cv.width, cv.height).data
      let mx = 0; for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i+1], d[i+2])
      return mx
    }
    st().setPlayhead(1)
    await new Promise((r) => setTimeout(r, 1500))
    const before = bright()
    // Chromium dispatches webglcontextlost on its own turn and the rebuild
    // lands right after, so watch the flag rather than sampling it
    const seen = []
    const unsub = window.kadrEditor.useEditor.subscribe((s, p) => {
      if (s.previewGpuLost !== p.previewGpuLost) seen.push(s.previewGpuLost)
    })
    gl.getExtension('WEBGL_lose_context').loseContext()
    // snapshotFrame checks the context before its first await, so this call
    // still lands inside the lost window
    let snapErr = null
    try { await window.kadrEditor.snapshotFrame({ t: 1, dir: '/tmp/kadr-test', interactive: false, importToBin: false }) }
    catch (e) { snapErr = String(e && e.message || e) }
    for (let i = 0; i < 40 && st().previewGpuLost; i++) await new Promise((r) => setTimeout(r, 250))
    st().setPlayhead(1.5)
    await new Promise((r) => setTimeout(r, 2000))
    const after = { flag: st().previewGpuLost, lost: gl.isContextLost(), bright: bright() }
    unsub()
    // the banner needs a React render, so drive the flag directly for it
    st().setPreviewGpuLost(true)
    await new Promise((r) => setTimeout(r, 300))
    const bannerShown = !!document.querySelector('.preview-gpu-lost')
    st().setPreviewGpuLost(false)
    await new Promise((r) => setTimeout(r, 300))
    return { before, seen, snapErr, after, bannerShown, bannerGone: !document.querySelector('.preview-gpu-lost') }
  })()`, { timeout: 240000 })
  check('the preview drew real pixels to begin with', prev.before > 40, `brightest=${prev.before}`)
  check('the loss is noticed and then cleared', prev.seen[0] === true && prev.seen[prev.seen.length - 1] === false, JSON.stringify(prev.seen))
  check('a snapshot refuses instead of handing back a stale frame', /context lost/i.test(prev.snapErr || ''), prev.snapErr || 'no error')
  check('the context comes back on its own', prev.after.flag === false && prev.after.lost === false)
  check('and the preview paints again', prev.after.bright > 40, `brightest=${prev.after.bright}`)
  check('the banner shows while the flag is up and goes when it clears', prev.bannerShown && prev.bannerGone)
} finally {
  ws.close()
}
console.log('e2e35 finished')
