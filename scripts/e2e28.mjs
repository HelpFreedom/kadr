// Test: save feedback — the ● dirty dot appears after an edit, clicking
// Save writes the file, shows a transient "✓ saved" flash and clears the
// dot; the flash disappears on its own; a new edit brings the dot back.
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { statSync } from 'fs'

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
  return { flash: flash?.textContent ?? null, err: flash?.classList.contains('error') ?? null,
           dot: !!document.querySelector('.dirty-dot') }
})()`)
let onDisk = false
try { onDisk = statSync('/tmp/kadr-test/save/p.kadr').size > 10 } catch { /* missing */ }
check('save writes the file and flashes ✓', onDisk && saved.flash?.includes('✓') && saved.err === false,
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

ws.close()
console.log('e2e28 finished')
