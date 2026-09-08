// Test: the preview detached into an OS window of its own.
//
// The whole feature is one claim — that nothing is REBUILT on the way over.
// The preview is a live WebGL2 canvas with Remotion iframes positioned on top
// of it, so re-creating it in the other document would mean a fresh GL context
// every toggle (Chromium keeps 16 per renderer and force-loses the oldest) and
// a reload of every fragment. So the checks below are mostly about identity:
// the SAME canvas element, the SAME context, still drawing, and the clock now
// running on the other window's rAF — a minimised editor window throttles its
// own frames to a crawl, and the picture being watched must not stall with it.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// Needs /tmp/kadr-test/hd.mp4 (scripts/gen-test-media.sh).
import WebSocket from 'ws'
import { existsSync } from 'fs'
const PORT = process.env.KADR_CDP_PORT || 9777
const SRC = '/tmp/kadr-test/hd.mp4'

async function targets() {
  for (let i = 0; i < 30; i++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    } catch { await new Promise((r) => setTimeout(r, 1000)) }
  }
  throw new Error('CDP not answering')
}
async function pageWs(match) {
  const list = await targets()
  const t = list.find((x) => x.type === 'page' && x.url.includes(match))
  return t ? t.webSocketDebuggerUrl : null
}

/** one CDP connection with the eval/poll dance the other suites use */
function connect(url) {
  const sock = new WebSocket(url)
  let id = 0
  const ready = new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      sock.off('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    sock.on('message', onMsg)
    sock.send(JSON.stringify({ id: msgId, method, params }))
  })
  // userGesture: everything here is a button the user presses, and a popup
  // opened without one would be a different code path than the real editor's
  const rawEval = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) {
      throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result.value
  }
  const evalJs = async (expression, { timeout = 60000 } = {}) => {
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
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return { sock, ready, send, rawEval, evalJs }
}

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (!existsSync(SRC)) {
  console.log('SKIP  e2e43 needs /tmp/kadr-test/hd.mp4 (scripts/gen-test-media.sh)')
  process.exit(0)
}

const main = connect(await pageWs('localhost'))
await main.ready
const { evalJs, rawEval, send } = main

/** the brightest channel anywhere on a canvas — "is there a picture at all" */
const BRIGHT = (cvExpr) => `(() => {
  const cv = ${cvExpr}
  if (!cv) return -1
  const c2 = document.createElement('canvas')
  c2.width = 96; c2.height = 54
  const g = c2.getContext('2d')
  g.drawImage(cv, 0, 0, 96, 54)
  const d = g.getImageData(0, 0, 96, 54).data
  let mx = 0
  for (let i = 0; i < d.length; i += 4) mx = Math.max(mx, d[i], d[i + 1], d[i + 2])
  return mx
})()`

// the geometry of the detached window is remembered between sessions, and it
// is the user's — put it back exactly as we found it
const savedGeom = await rawEval(`localStorage.getItem('kadr.previewWindow')`)

try {
  // ---- 0. a project with one real clip, so "the picture survived" can be measured
  await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    if (E.usePopout.getState().win) E.dockPreviewWindow()
    st().setProject({ ...st().project, name: 'popout-test', tracks: [], assets: [] }, null)
    st().addTrack('video')
    const { asset } = await window.kadr.probeMedia(${JSON.stringify(SRC)})
    const id = E.uid()
    st().addAsset({ id, ...asset })
    st().insertClipFromAsset(id, st().project.tracks[0].id, 0)
    st().setPlayhead(1)
    await new Promise((r) => setTimeout(r, 2500))
    // the identity everything below is checked against
    window.__popCanvas = document.querySelector('.preview canvas')
    E.clearLog()
    return 1
  })()`, { timeout: 60000 })

  const docked = await evalJs(`(() => ({
    inSlot: !!document.querySelector('.preview-slot > .preview-host > .preview'),
    bright: ${BRIGHT(`document.querySelector('.preview canvas')`)},
    btn: (() => { const b = document.querySelector('[data-act="popout"]'); return b ? !!b.getAttribute('aria-label') : false })()
  }))()`)
  check('docked: the preview sits in its slot and draws', docked.inSlot && docked.bright > 40, JSON.stringify(docked))
  check('the button carries data-act and an aria-label', docked.btn === true)

  // ---- 1. the button detaches the preview
  await rawEval(`document.querySelector('[data-act="popout"]').click(); 0`)
  await sleep(1200)
  const out = await evalJs(`(() => {
    const w = window.kadrEditor.usePopout.getState().win
    if (!w) return { win: false }
    const cv = w.document.querySelector('.preview canvas')
    const gl = cv && cv.getContext('webgl2')
    return {
      win: true,
      same: cv === window.__popCanvas,
      goneFromEditor: !document.querySelector('.preview canvas'),
      lost: gl ? gl.isContextLost() : null,
      placeholder: !!document.querySelector('.preview-detached'),
      body: w.document.body.className,
      styles: w.document.head.querySelectorAll('[data-kadr-style]').length,
      bg: w.getComputedStyle(w.document.body).backgroundColor,
      title: w.document.title
    }
  })()`)
  check('a click opens a real window of its own', out.win === true, JSON.stringify(out))
  check('the very same canvas moved across — nothing was rebuilt', out.same === true)
  check('and it is no longer in the editor document', out.goneFromEditor === true)
  check('its GL context survived the move', out.lost === false)
  check('the editor shows what happened in its place', out.placeholder === true)
  check('the window carries the editor stylesheet and its background',
        out.styles >= 1 && out.bg === 'rgb(11, 13, 18)' && out.body === 'kadr-popout', JSON.stringify(out))
  check('and a title of its own', /предпросмотр|preview/i.test(out.title || ''), out.title)

  const brightOut = await evalJs(
    `${BRIGHT(`window.kadrEditor.usePopout.getState().win.document.querySelector('.preview canvas')`)}`)
  check('the picture is still being drawn in the new window', brightOut > 40, String(brightOut))

  // ---- 1b. THE OBSERVERS CAME WITH IT.
  // A ResizeObserver belongs to the document it was created in and delivers
  // nothing for an element in another one — measured here on the very same
  // element: created in the editor's window it fired 0 times, created in the
  // detached window it fired on every change. So the preview's observers must
  // be rebuilt when it moves, or the audio meter would keep drawing into a
  // backing store of the old size and the fragment overlay would sit at the
  // old rect for as long as the window is detached. (This is also the cause of
  // the «ResizeObserver loop completed with undelivered notifications» notice
  // the editor used to log on every detach.)
  const follows = await evalJs(`(async () => {
    const w = window.kadrEditor.usePopout.getState().win
    const meter = w.document.querySelector('.audio-meter')
    const read = () => ({ buf: meter.height, css: meter.clientHeight })
    const before = read()
    w.document.body.style.height = '520px'
    await new Promise((r) => setTimeout(r, 900))
    const small = read()
    w.document.body.style.height = ''
    await new Promise((r) => setTimeout(r, 900))
    const back = read()
    return { before, small, back }
  })()`, { timeout: 30000 })
  check('the preview\'s observers work in the window it moved to',
        follows.small.buf === follows.small.css && follows.small.buf > 0 &&
        follows.small.buf < follows.before.buf && follows.back.buf === follows.before.buf,
        JSON.stringify(follows))

  // and the same element, watched the two possible ways at once: this is the
  // measurement the fix rests on, so it is checked rather than assumed
  const whoFires = await evalJs(`(async () => {
    const w = window.kadrEditor.usePopout.getState().win
    const el = w.document.querySelector('.audio-meter')
    let editorWin = 0, previewWin = 0
    const a = new window.ResizeObserver(() => { editorWin++ })
    const b = new w.ResizeObserver(() => { previewWin++ })
    a.observe(el); b.observe(el)
    await new Promise((r) => setTimeout(r, 400))
    w.document.body.style.height = '520px'
    await new Promise((r) => setTimeout(r, 800))
    w.document.body.style.height = ''
    await new Promise((r) => setTimeout(r, 800))
    a.disconnect(); b.disconnect()
    return { editorWin, previewWin }
  })()`, { timeout: 30000 })
  check('an observer left in the editor document delivers nothing at all',
        whoFires.editorWin === 0 && whoFires.previewWin >= 2, JSON.stringify(whoFires))

  const quiet = await evalJs(`window.kadrEditor.useLog.getState().entries
    .filter((e) => e.level !== 'info').map((e) => e.level + ': ' + e.msg)`)
  check('detaching the preview logs no failure', quiet.length === 0, JSON.stringify(quiet))

  // ---- 2. a style change reaches the detached window (a CSS edit in dev is
  //         a mutation of the injected <style>, not a new document)
  const mirrored = await evalJs(`(async () => {
    const w = window.kadrEditor.usePopout.getState().win
    const st = document.createElement('style')
    st.textContent = '.e2e43-probe { color: rgb(1, 2, 3) }'
    document.head.appendChild(st)
    await new Promise((r) => setTimeout(r, 400))
    const seen = [...w.document.head.querySelectorAll('[data-kadr-style]')]
      .some((e) => (e.textContent || '').includes('rgb(1, 2, 3)'))
    st.remove()
    await new Promise((r) => setTimeout(r, 400))
    const dropped = ![...w.document.head.querySelectorAll('[data-kadr-style]')]
      .some((e) => (e.textContent || '').includes('rgb(1, 2, 3)'))
    return { seen, dropped }
  })()`)
  check('styles keep following the editor while detached',
        mirrored.seen && mirrored.dropped, JSON.stringify(mirrored))

  // ---- 3. the clock runs on the detached window's frames
  const ran = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().setPlayhead(0)
    st().setPlaying(true)
    await new Promise((r) => setTimeout(r, 1000))
    const t = st().playhead
    st().setPlaying(false)
    return { advanced: t }
  })()`)
  check('playback keeps running with the preview detached', ran.advanced > 0.5, JSON.stringify(ran))

  // ---- 4. the keyboard reaches the transport from the detached window
  const popWsUrl = await pageWs('about:blank')
  check('the detached preview is a page of its own', !!popWsUrl)
  if (popWsUrl) {
    const pop = connect(popWsUrl)
    await pop.ready
    await evalJs(`(() => { window.kadrEditor.useEditor.getState().setPlayhead(0); return 1 })()`)
    await pop.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 })
    await pop.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Space', key: ' ', windowsVirtualKeyCode: 32 })
    await sleep(700)
    const playing = await evalJs(`(() => {
      const s = window.kadrEditor.useEditor.getState()
      const r = { playing: s.playing, t: s.playhead }
      s.setPlaying(false)
      return r
    })()`)
    check('Space pressed in the detached window drives the transport',
          playing.playing === true && playing.t > 0.2, JSON.stringify(playing))

    // ---- 5. a snapshot still grabs the real frame from over there
    const shot = await evalJs(
      `window.kadrEditor.snapshotFrame({ dir: '/tmp/kadr-test', importToBin: false })`, { timeout: 60000 })
    check('a frame snapshot still works while detached',
          !!shot.path && shot.width > 0, JSON.stringify(shot))

    // ---- 6. closing the window from its own side brings the preview home
    await pop.rawEval(`window.close(); 0`).catch(() => { /* the socket dies with it */ })
    await sleep(1500)
    const home = await evalJs(`(() => {
      const cv = document.querySelector('.preview canvas')
      const gl = cv && cv.getContext('webgl2')
      return {
        win: window.kadrEditor.usePopout.getState().win !== null,
        inSlot: !!document.querySelector('.preview-slot > .preview-host > .preview'),
        same: cv === window.__popCanvas,
        lost: gl ? gl.isContextLost() : null,
        placeholder: !!document.querySelector('.preview-detached')
      }
    })()`)
    check('closing that window returns the preview to the editor',
          home.win === false && home.inSlot && !home.placeholder, JSON.stringify(home))
    check('and it is still the same live canvas', home.same === true && home.lost === false)
    try { pop.sock.close() } catch { /* already gone */ }
  }

  const brightHome = await evalJs(`(async () => {
    window.kadrEditor.useEditor.getState().setPlayhead(2)
    await new Promise((r) => setTimeout(r, 1500))
    return ${BRIGHT(`document.querySelector('.preview canvas')`)}
  })()`, { timeout: 30000 })
  check('and it draws again in the editor', brightHome > 40, String(brightHome))

  // ---- 7. the second click puts it back (what the button promises)
  await rawEval(`document.querySelector('[data-act="popout"]').click(); 0`)
  await sleep(1200)
  const again = await evalJs(`window.kadrEditor.usePopout.getState().win !== null`)
  await rawEval(`document.querySelector('[data-act="popout"]').click(); 0`)
  await sleep(1000)
  const back = await evalJs(`(() => ({
    win: window.kadrEditor.usePopout.getState().win !== null,
    inSlot: !!document.querySelector('.preview-slot > .preview-host > .preview'),
    same: document.querySelector('.preview canvas') === window.__popCanvas,
    geom: localStorage.getItem('kadr.previewWindow')
  }))()`)
  check('the button toggles: out on one click, back on the next',
        again === true && back.win === false && back.inSlot, JSON.stringify(back))
  check('the window remembers where and how big it was',
        !!back.geom && JSON.parse(back.geom).w >= 320, back.geom)
  check('through every round trip it stayed the one canvas', back.same === true)

  // ---- 8. only that one window may be opened at all
  const denied = await evalJs(`(() => {
    let r = null
    try { r = window.open('', 'e2e43-not-the-preview', 'width=200,height=200') } catch { return 'threw' }
    if (r) { try { r.close() } catch { /* ignore */ } }
    return r === null
  })()`)
  check('the main process refuses any other window.open', denied === true, String(denied))

  const left = (await targets()).filter((t) => t.type === 'page' && t.url.startsWith('about:blank'))
  check('no detached window is left behind', left.length === 0, String(left.length))
} finally {
  await rawEval(`(() => {
    if (window.kadrEditor.usePopout.getState().win) window.kadrEditor.dockPreviewWindow()
    ${savedGeom === null
      ? `localStorage.removeItem('kadr.previewWindow')`
      : `localStorage.setItem('kadr.previewWindow', ${JSON.stringify(savedGeom)})`}
    return 1
  })()`).catch(() => { /* the page may be gone */ })
  try { main.sock.close() } catch { /* already closed */ }
}
console.log('e2e43 finished')
