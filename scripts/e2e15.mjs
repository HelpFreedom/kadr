// Test: pose presets — save the current transform/mask state under a name,
// apply it to another clip (keyframe lands when the param is animated),
// delete presets, survive a reload (localStorage).
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
    await new Promise((r) => setTimeout(r, 250))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
async function connect() {
  ws = new WebSocket(await getPageWs())
  await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
}
async function reload() {
  try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
  await new Promise((r) => setTimeout(r, 1800))
  for (let i = 0; i < 30; i++) {
    try {
      if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
    } catch { /* mid-reload */ }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

await connect()
await reload()
await evalJs(`(async () => {
  localStorage.removeItem('kadr.posePresets')
  await window.kadr.writeUserStore('pose-presets', [])
  return 1
})()`)
await reload()

// setup: two separate clips on V1; open the anim editor on clip A
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const a = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const b = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idA = ed.uid(), idB = ed.uid()
  st().addAsset({ id: idA, ...a.asset })
  st().addAsset({ id: idB, ...b.asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  st().insertClipFromAsset(idB, v1.id, 7)
  const cs = [...st().project.tracks.find(t => t.name === 'V1').clips].sort((x, y) => x.start - y.start)
  // pose on A: moved right and scaled up
  st().updateClip(cs[0].id, { transform: { ...cs[0].transform,
    x: { value: 200 }, y: { value: -80 }, scale: { value: 1.4 }, rotation: { value: 15 } } })
  st().setPlayhead(1)
  st().setAnimClip(cs[0].id)
  window.__ids = { a: cs[0].id, b: cs[1].id }
  return true
})()`)
await new Promise((r) => setTimeout(r, 600))

// 1. save the transform pose through the UI
const saved = await evalJs(`(async () => {
  const btn = [...document.querySelectorAll('.anim-toolbar button')]
    .find(b => /Пресеты|Presets/.test(b.textContent))
  btn.click()
  await new Promise(r => setTimeout(r, 250))
  const input = document.querySelector('.preset-save-row input')
  if (!input) return { menu: false }
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'Сдвиг вправо')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  const save = [...document.querySelectorAll('.preset-save-row button')]
    .find(b => /Сохранить|Save/.test(b.textContent))
  save.click()
  await new Promise(r => setTimeout(r, 250))
  const items = [...document.querySelectorAll('.preset-item')].map(i => i.textContent)
  const ls = JSON.parse(localStorage.getItem('kadr.posePresets') || '[]')
  return { menu: true, items, ls: ls.map(p => ({ name: p.name, kind: p.kind, x: p.values?.x })) }
})()`)
check('transform pose saved via UI (list + localStorage)',
  saved.menu && saved.items.length === 1 && saved.items[0].includes('Сдвиг вправо') &&
  saved.ls.length === 1 && saved.ls[0].kind === 'transform' && saved.ls[0].x === 200,
  JSON.stringify(saved))

// 2. apply to clip B — static params take the values directly
const applied = await evalJs(`(async () => {
  const st = window.kadrEditor.useEditor.getState()
  st.setAnimClip(window.__ids.b)
  st.setPlayhead(8)
  await new Promise(r => setTimeout(r, 400))
  if (!document.querySelector('.preset-menu')) {
    const btn = [...document.querySelectorAll('.anim-toolbar button')]
      .find(b => /Пресеты|Presets/.test(b.textContent))
    btn.click()
    await new Promise(r => setTimeout(r, 250))
  }
  const item = [...document.querySelectorAll('.preset-item button')]
    .find(b => b.textContent.includes('Сдвиг вправо'))
  item.click()
  await new Promise(r => setTimeout(r, 250))
  const s2 = window.kadrEditor.useEditor.getState()
  const f = s2.project.tracks.flatMap(t => t.clips).find(c => c.id === window.__ids.b)
  return {
    x: f.transform.x.value, y: f.transform.y.value,
    scale: f.transform.scale.value, rot: f.transform.rotation.value,
    kfs: f.transform.x.keyframes ?? null,
    undo: s2.past[s2.past.length - 1]?.label,
    menuGone: !document.querySelector('.preset-menu')
  }
})()`)
check('preset applied to another clip as static values',
  applied.x === 200 && applied.y === -80 && applied.scale === 1.4 && applied.rot === 15 &&
  applied.kfs === null && applied.undo === 'hPreset' && applied.menuGone,
  JSON.stringify(applied))

// 3. a keyframed param records the pose as a keyframe at the playhead
const kfApplied = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const f0 = st.project.tracks.flatMap(t => t.clips).find(c => c.id === window.__ids.b)
  st.updateClip(window.__ids.b, { transform: { ...f0.transform,
    x: { value: 0, keyframes: [{ time: 0, value: 0, easing: 'linear' }] } } })
  st.setPlayhead(9) // rel = 2 inside clip B
  await new Promise(r => setTimeout(r, 300))
  if (!document.querySelector('.preset-menu')) {
    const btn = [...document.querySelectorAll('.anim-toolbar button')]
      .find(b => /Пресеты|Presets/.test(b.textContent))
    btn.click()
    await new Promise(r => setTimeout(r, 250))
  }
  const item = [...document.querySelectorAll('.preset-item button')]
    .find(b => b.textContent.includes('Сдвиг вправо'))
  item.click()
  await new Promise(r => setTimeout(r, 250))
  const f = ed.useEditor.getState().project.tracks.flatMap(t => t.clips)
    .find(c => c.id === window.__ids.b)
  return { kfs: f.transform.x.keyframes }
})()`)
check('keyframed param gets a pose keyframe at the playhead',
  kfApplied.kfs?.length === 2 &&
  Math.abs(kfApplied.kfs[1].time - 2) < 0.05 && kfApplied.kfs[1].value === 200,
  JSON.stringify(kfApplied))

// 4. mask preset with a drawn shape — saved on A, applied to B
const maskRes = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = ed.useEditor.getState()
  const fA = st.project.tracks.flatMap(t => t.clips).find(c => c.id === window.__ids.a)
  st.updateClip(window.__ids.a, {
    mask: { left: { value: 0.1 }, top: { value: 0 }, right: { value: 0.1 }, bottom: { value: 0 } },
    maskShapes: [{ type: 'ellipse', invert: false,
      cx: { value: 0.5 }, cy: { value: 0.4 }, w: { value: 0.6 }, h: { value: 0.5 },
      featherIn: { value: 0.02 }, featherOut: { value: 0.08 } }]
  })
  st.setAnimClip(window.__ids.a)
  st.setPlayhead(1)
  await new Promise(r => setTimeout(r, 400))
  // switch the editor to mask mode
  const maskBtn = [...document.querySelectorAll('.anim-toolbar button')]
    .find(b => /^(Маска|Mask)$/.test(b.textContent.trim()))
  maskBtn.click()
  await new Promise(r => setTimeout(r, 250))
  if (!document.querySelector('.preset-menu')) {
    const btn = [...document.querySelectorAll('.anim-toolbar button')]
      .find(b => /Пресеты|Presets/.test(b.textContent))
    btn.click()
    await new Promise(r => setTimeout(r, 250))
  }
  const input = document.querySelector('.preset-save-row input')
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
  setter.call(input, 'Овал по центру')
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await new Promise(r => setTimeout(r, 150))
  ;[...document.querySelectorAll('.preset-save-row button')]
    .find(b => /Сохранить|Save/.test(b.textContent)).click()
  await new Promise(r => setTimeout(r, 250))
  // apply to B (mask mode persists in the editor)
  st.setAnimClip(window.__ids.b)
  await new Promise(r => setTimeout(r, 300))
  if (!document.querySelector('.preset-menu')) {
    const btn2 = [...document.querySelectorAll('.anim-toolbar button')]
      .find(b => /Пресеты|Presets/.test(b.textContent))
    btn2.click()
    await new Promise(r => setTimeout(r, 250))
  }
  const titles = document.querySelector('.preset-menu .ctx-title')?.textContent
  const item = [...document.querySelectorAll('.preset-item button')]
    .find(b => b.textContent.includes('Овал'))
  item.click()
  await new Promise(r => setTimeout(r, 250))
  const f = ed.useEditor.getState().project.tracks.flatMap(t => t.clips)
    .find(c => c.id === window.__ids.b)
  return {
    title: titles,
    mL: f.mask.left.value, mR: f.mask.right.value,
    shapes: (f.maskShapes ?? []).map(s => ({ type: s.type, w: s.w.value, fo: s.featherOut.value }))
  }
})()`)
check('mask preset (edges + ellipse) applied to another clip',
  maskRes.mL === 0.1 && maskRes.mR === 0.1 && maskRes.shapes.length === 1 &&
  maskRes.shapes[0].type === 'ellipse' && maskRes.shapes[0].w === 0.6 &&
  Math.abs(maskRes.shapes[0].fo - 0.08) < 1e-6,
  JSON.stringify(maskRes))

// 5. delete a preset via the ✕ button
const delRes = await evalJs(`(async () => {
  if (!document.querySelector('.preset-menu')) {
    const btn = [...document.querySelectorAll('.anim-toolbar button')]
      .find(b => /Пресеты|Presets/.test(b.textContent))
    btn.click()
    await new Promise(r => setTimeout(r, 250))
  }
  const del = document.querySelector('.preset-item .preset-del')
  del.click()
  await new Promise(r => setTimeout(r, 250))
  const left = JSON.parse(localStorage.getItem('kadr.posePresets') || '[]')
  return { items: document.querySelectorAll('.preset-item').length, ls: left.map(p => p.name) }
})()`)
check('preset deleted from list and localStorage',
  delRes.items === 0 && delRes.ls.length === 1 && delRes.ls[0] === 'Сдвиг вправо',
  JSON.stringify(delRes))

// 6. presets survive even with localStorage wiped — the userData file is
// the source of truth (a second app instance can lock the renderer profile)
await evalJs(`(() => { localStorage.removeItem('kadr.posePresets'); return 1 })()`)
await reload()
await new Promise((r) => setTimeout(r, 800))
const persisted = await evalJs(`(async () => {
  const fromFile = await window.kadr.readUserStore('pose-presets')
  for (let i = 0; i < 10; i++) {
    const st = window.kadrEditor.usePosePresets.getState().presets
    if (st.length) return { store: st.map(p => p.name), file: (fromFile ?? []).map(p => p.name) }
    await new Promise(r => setTimeout(r, 300))
  }
  return { store: [], file: (fromFile ?? []).map(p => p.name) }
})()`)
check('presets persist via userData file even without localStorage',
  persisted.store.length === 1 && persisted.store[0] === 'Сдвиг вправо' &&
  persisted.file.length === 1,
  JSON.stringify(persisted))

ws.close()
console.log('e2e15 finished')
