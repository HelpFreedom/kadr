// Test: effect presets — the Inspector ⭐ menu saves the clip's effect stack
// under a name, the preset applies to another clip (new effect ids), survives
// in the userData file store, and can be deleted.
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
async function evalJs(expression, { timeout = 120000 } = {}) {
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

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// protect the user's live work before reloading
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
} catch { /* page mid-load */ }

try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// clean slate for the fx preset store
await evalJs(`(async () => {
  const ed = window.kadrEditor
  for (const p of [...ed.useFxPresets.getState().presets]) ed.useFxPresets.getState().deletePreset(p.id)
  return true
})()`)

// setup: two clips; clip A gets a glow, clip B stays bare; A selected
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idB = ed.uid()
  st().addAsset({ id: idB, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idB, v1.id, 0)
  st().insertClipFromAsset(idB, v1.id, 3)
  const [a] = st().project.tracks.find(t => t.name === 'V1').clips
  st().updateClip(a.id, { effects: [{ id: ed.uid(), type: 'glow', enabled: true,
    params: { color: '#22ff88', size: 90, intensity: 1.4, saturation: 1.1,
              smoke: 0.5, speed: 1.2, particles: 0.3 } }] })
  st().select([a.id])
  await new Promise(r => setTimeout(r, 500))
  return true
})()`)

// open the ⭐ menu in the Inspector, type a name, save
const savedUi = await evalJs(`(async () => {
  const btn = document.querySelector('.fx-preset-btn')
  if (!btn) return { err: 'no preset button' }
  btn.click()
  await new Promise(r => setTimeout(r, 300))
  const menu = document.querySelector('.fx-preset-menu')
  if (!menu) return { err: 'menu did not open' }
  const input = menu.querySelector('.preset-save-row input')
  const setVal = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setVal.call(input, 'Зелёный дым')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 200))
  const save = menu.querySelector('.preset-save-row button')
  if (save.disabled) return { err: 'save disabled' }
  save.click()
  await new Promise(r => setTimeout(r, 400))
  const presets = window.kadrEditor.useFxPresets.getState().presets
  return { count: presets.length, name: presets[0]?.name,
           size: presets[0]?.effects?.[0]?.params?.size }
})()`)
check('UI saves the effect stack as a named preset',
  savedUi.count === 1 && savedUi.name === 'Зелёный дым' && savedUi.size === 90,
  JSON.stringify(savedUi))

// preset persists in the userData file store (not just localStorage)
await new Promise((r) => setTimeout(r, 500))
const inFile = await evalJs(`window.kadr.readUserStore('fx-presets')`)
check('preset lands in the file store',
  Array.isArray(inFile) && inFile.length === 1 && inFile[0].name === 'Зелёный дым',
  JSON.stringify(inFile && inFile.map((p) => p.name)))

// apply to the bare clip B via the menu
const applied = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const clips = st().project.tracks.find(t => t.name === 'V1').clips
  const b = clips[clips.length - 1]
  st().select([b.id])
  await new Promise(r => setTimeout(r, 400))
  if (!document.querySelector('.fx-preset-menu')) {
    document.querySelector('.fx-preset-btn').click()
    await new Promise(r => setTimeout(r, 300))
  }
  const menu = document.querySelector('.fx-preset-menu')
  if (!menu) return { err: 'menu did not open' }
  const item = menu.querySelector('.preset-item button')
  item.click()
  await new Promise(r => setTimeout(r, 400))
  const nb = st().project.tracks.find(t => t.name === 'V1').clips
    .find(c => c.id === b.id)
  const a = st().project.tracks.find(t => t.name === 'V1').clips[0]
  return { fx: nb.effects?.[0]?.params, newId: nb.effects?.[0]?.id !== a.effects[0].id }
})()`)
check('preset applies to another clip with a fresh effect id',
  applied.fx?.size === 90 && applied.fx?.color === '#22ff88' && applied.newId === true,
  JSON.stringify(applied))

// delete the preset from the menu
const deleted = await evalJs(`(async () => {
  const menuBefore = document.querySelector('.fx-preset-menu')
  if (!menuBefore) {
    document.querySelector('.fx-preset-btn').click()
    await new Promise(r => setTimeout(r, 300))
  }
  const del = document.querySelector('.fx-preset-menu .preset-del')
  if (!del) return { err: 'no delete button' }
  del.click()
  await new Promise(r => setTimeout(r, 400))
  const left = window.kadrEditor.useFxPresets.getState().presets.length
  const file = await window.kadr.readUserStore('fx-presets')
  return { left, fileLen: Array.isArray(file) ? file.length : -1 }
})()`)
check('preset deletes from store and file', deleted.left === 0 && deleted.fileLen === 0,
  JSON.stringify(deleted))

ws.close()
console.log('e2e20 finished')
