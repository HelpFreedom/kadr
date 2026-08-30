// Test: the session log — the panel that makes a failure visible while the
// editor is running.
//
// Twenty places in the renderer used to report a failure with console.warn and
// nothing else, so a snapshot that did not happen looked exactly like a click
// that did nothing. This suite holds the contract: real failures reach the
// log, the topbar stays quiet until one does, the panel shows it, and none of
// it survives the window (it is a session log, not a file on a full disk).
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
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
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
const key = (k, code, mods = 0) =>
  send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: 0, modifiers: mods })
    .then(() => send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers: mods }))

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })


try {
  // a clean slate, and the panel closed
  await evalJs(`(() => {
    const E = window.kadrEditor
    if (document.querySelector('.debug-panel')) document.querySelector('[data-act="debug"]').click()
    E.clearLog()
    return 1
  })()`)

  // ---- 1. the button says nothing while nothing is wrong
  const quiet = await evalJs(`(() => {
    const b = document.querySelector('[data-act="debug"]')
    return { exists: !!b, news: b.classList.contains('has-news'), badge: !!b.querySelector('.log-badge') }
  })()`)
  check('the log button exists and is quiet when nothing failed',
        quiet.exists && quiet.news === false && quiet.badge === false, JSON.stringify(quiet))

  // ---- 2. a REAL failure lands in it. importFiles on a missing path is one
  // of the twenty sites that used to only reach the console.
  const caught = await evalJs(`(async () => {
    const E = window.kadrEditor
    try { await E.importFiles(['/nope/does-not-exist.mp4'], null) } catch { /* reported, not thrown */ }
    await new Promise((r) => setTimeout(r, 400))
    const s = E.useLog.getState()
    const e = s.entries[s.entries.length - 1]
    return { n: s.entries.length, unseen: s.unseen,
             level: e && e.level, source: e && e.source, msg: e && e.msg, detail: !!(e && e.detail) }
  })()`)
  check('a failure that used to be silent now reaches the log',
        caught.n === 1 && caught.level === 'error' && /does-not-exist/.test(caught.msg || ''),
        JSON.stringify(caught))
  check('and it carries the reason, not just a headline', caught.detail === true)

  // ---- 3. the button lights up, with a count
  const lit = await evalJs(`(() => {
    const b = document.querySelector('[data-act="debug"]')
    return { news: b.classList.contains('has-news'), badge: b.querySelector('.log-badge')?.textContent }
  })()`)
  check('the button lights up only once something failed',
        lit.news === true && lit.badge === '1', JSON.stringify(lit))

  // ---- 4. an ordinary message must not raise the badge: the button is a
  // warning light, and a warning light that blinks for good news is noise
  const info = await evalJs(`(() => {
    window.kadrEditor.logInfo('экспорт', 'готово')
    const b = document.querySelector('[data-act="debug"]')
    return { unseen: window.kadrEditor.useLog.getState().unseen, badge: b.querySelector('.log-badge')?.textContent }
  })()`)
  check('an informational entry does not raise the badge',
        info.unseen === 1 && info.badge === '1', JSON.stringify(info))

  // ---- 5. the panel shows what happened, and looking at it clears the badge
  const panel = await evalJs(`(async () => {
    document.querySelector('[data-act="debug"]').click()
    await new Promise((r) => setTimeout(r, 400))
    const p = document.querySelector('.debug-panel')
    const rows = [...p.querySelectorAll('.log-row')]
    const first = rows[0]
    first.querySelector('.log-line').click()
    await new Promise((r) => setTimeout(r, 200))
    const b = document.querySelector('[data-act="debug"]')
    return {
      open: !!p,
      rows: rows.length,
      levels: rows.map((r) => r.className.replace('log-row ', '')),
      text: first.textContent,
      detailShown: !!first.querySelector('.log-detail'),
      news: b.classList.contains('has-news'),
      badge: !!b.querySelector('.log-badge')
    }
  })()`)
  check('the panel lists the entries with their level',
        panel.open && panel.rows === 2 && panel.levels[0] === 'error' && panel.levels[1] === 'info',
        JSON.stringify({ rows: panel.rows, levels: panel.levels }))
  check('a row opens to show the reason', panel.detailShown === true)
  check('the entry names its source and says what happened',
        /импорт/.test(panel.text) && /does-not-exist/.test(panel.text), panel.text.slice(0, 80))
  check('opening the panel clears the badge', panel.news === false && panel.badge === false)

  // ---- 6. copyable as plain text (the point of the panel: hand it over)
  const text = await evalJs(`window.kadrEditor.logAsText()`)
  check('the whole log is one block of plain text',
        /ERROR/.test(text) && /импорт/.test(text) && /does-not-exist/.test(text), text.slice(0, 90))

  // ---- 7. clearing empties it and brings the empty state back
  const cleared = await evalJs(`(async () => {
    const btns = [...document.querySelectorAll('.debug-panel .claude-head button')]
    // the trash is the second control (copy, clear, close)
    btns[1].click()
    await new Promise((r) => setTimeout(r, 300))
    const p = document.querySelector('.debug-panel')
    return { rows: p.querySelectorAll('.log-row').length, hint: !!p.querySelector('.hint'),
             n: window.kadrEditor.useLog.getState().entries.length }
  })()`)
  check('clearing empties the log and shows the empty state',
        cleared.rows === 0 && cleared.hint === true && cleared.n === 0, JSON.stringify(cleared))

  // ---- 8. nothing is written to disk: a reload starts from nothing
  await evalJs(`(() => { window.kadrEditor.logWarn('проверка', 'до перезагрузки'); return 1 })()`)
  await rawEval('location.reload()')
  await new Promise((r) => setTimeout(r, 5000))
  for (let i = 0; i < 60; i++) {
    try { if (await rawEval('!!window.kadrEditor')) break } catch { /* reloading */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
  const after = await evalJs(`(() => {
    const s = window.kadrEditor.useLog.getState()
    return { n: s.entries.length, unseen: s.unseen,
             panel: !!document.querySelector('.debug-panel') }
  })()`)
  check('the log does not survive the window — it is a session, not a diary',
        after.n === 0 && after.unseen === 0, JSON.stringify(after))

  // ---- 9. a browser notice that is not a failure must not be counted as one.
  // Chromium delivers «ResizeObserver loop …» through window.onerror: an
  // observation it could not fit into this frame is delivered in the next one,
  // nothing is lost, and there is no Error and no stack to act on. It used to
  // be logged as a red ERROR (the preview detach raised one every time), which
  // is exactly the false alarm the amber counter must not carry.
  const notice = await evalJs(`(async () => {
    const L = window.kadrEditor.useLog
    const before = L.getState().unseen
    dispatchEvent(new ErrorEvent('error', {
      message: 'ResizeObserver loop completed with undelivered notifications.'
    }))
    await new Promise((r) => setTimeout(r, 100))
    const e = L.getState().entries[L.getState().entries.length - 1]
    const mid = { level: e.level, source: e.source, unseen: L.getState().unseen - before }
    dispatchEvent(new ErrorEvent('error', { message: 'настоящая поломка' }))
    await new Promise((r) => setTimeout(r, 100))
    const e2 = L.getState().entries[L.getState().entries.length - 1]
    return { mid, real: { level: e2.level, unseen: L.getState().unseen - before } }
  })()`)
  check('a ResizeObserver notice is recorded but not counted as a failure',
        notice.mid.level === 'info' && notice.mid.unseen === 0, JSON.stringify(notice.mid))
  check('while a real window error still is',
        notice.real.level === 'error' && notice.real.unseen === 1, JSON.stringify(notice.real))
} finally {
  ws.close()
}
console.log('e2e41 finished')
