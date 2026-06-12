// Test: fragment pixel capture — plain fragments stay in the fast iframe
// overlay (clipped to the canvas box), while 3D/masks/transitions/effects
// flip the clip into capture mode where it becomes a real GL layer:
// perspective compresses geometry, track transitions blend pixels.
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
    await new Promise((r) => setTimeout(r, 1000))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test && [ -f /tmp/kadr-test/b.mp4 ] || ' +
  'ffmpeg -v error -f lavfi -i smptebars=duration=6:size=640x360:rate=30 -pix_fmt yuv420p -c:v libx264 -movflags +faststart -y /tmp/kadr-test/b.mp4'])

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

// helpers injected once
await rawEval(`window.__grab = () => {
  const cv = document.querySelector('.preview canvas')
  const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height
  const ctx = t.getContext('2d'); ctx.drawImage(cv, 0, 0)
  const d = ctx.getImageData(0, 0, t.width, t.height).data
  let minX = 1e9, maxX = -1, n = 0
  for (let y = 0; y < t.height; y += 2) for (let x = 0; x < t.width; x += 2) {
    const i = (y * t.width + x) * 4
    if (d[i] + d[i + 1] + d[i + 2] > 380) { n++; if (x < minX) minX = x; if (x > maxX) maxX = x }
  }
  return { n, w: maxX - minX }
}
window.__px = (fx, y) => {
  const cv = document.querySelector('.preview canvas')
  const t = document.createElement('canvas'); t.width = cv.width; t.height = cv.height
  const ctx = t.getContext('2d'); ctx.drawImage(cv, 0, 0)
  return [...ctx.getImageData(Math.round(cv.width * fx), y, 1, 1).data].slice(0, 3)
}; 0`)

let fragId = null
try {
  // plain fragment: iframe overlay (clipped box), nothing on the GL canvas
  const plain = await evalJs(`(async () => {
    const ed = window.kadrEditor
    const st = () => ed.useEditor.getState()
    const r = await ed.createFragment({ name: 'cap-test', start: 1, end: 4 })
    st().setPlayhead(2.2)
    for (let i = 0; i < 30; i++) {
      if (document.querySelector('.frag-frame')) break
      await new Promise(r2 => setTimeout(r2, 1000))
    }
    const box = document.querySelector('.frag-clipbox')
    return { id: r.id, clipId: r.clipId,
      iframe: !!document.querySelector('.frag-frame'),
      clipped: box ? getComputedStyle(box).overflow === 'hidden' : false,
      glPixels: window.__grab().n }
  })()`)
  fragId = plain.id
  check('plain fragment: iframe overlay clipped to the canvas box',
    plain.iframe && plain.clipped && plain.glPixels === 0, JSON.stringify(plain))

  // 3D: capture takes over, perspective compresses the text
  const threeD = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    const clip = st().project.tracks.flatMap(t => t.clips).find(c => c.kind === 'remotion')
    st().updateClip(clip.id, { transform: { ...clip.transform, rotY: { value: 5 } } })
    st().setPlayhead(2.21)
    let near = { n: 0 }
    for (let i = 0; i < 25; i++) {
      await new Promise(r => setTimeout(r, 1000))
      near = window.__grab()
      if (near.n > 0) break
    }
    const iframeGone = !document.querySelector('.frag-frame')
    st().updateClip(clip.id, { transform: { ...clip.transform, rotY: { value: 62 } } })
    st().setPlayhead(2.22)
    await new Promise(r => setTimeout(r, 1800))
    const rot = window.__grab()
    return { near, rot, iframeGone }
  })()`)
  check('3D flips to capture: fragment pixels land on the GL canvas',
    threeD.near.n > 0 && threeD.iframeGone, JSON.stringify(threeD.near))
  check('3D rotY compresses the geometry (perspective applied)',
    threeD.rot.n > 0 && threeD.rot.w < threeD.near.w * 0.8,
    `w ${threeD.near.w} → ${threeD.rot.w}`)

  // track transition: fragment ↔ media crossfade blends pixels
  const trans = await evalJs(`(async () => {
    const ed = window.kadrEditor
    const st = () => ed.useEditor.getState()
    const frag = st().project.tracks.flatMap(t => t.clips).find(c => c.kind === 'remotion')
    st().updateClip(frag.id, { transform: { ...frag.transform, rotY: { value: 0 } } })
    const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
    const idB = ed.uid()
    st().addAsset({ id: idB, ...asset })
    const tr = st().project.tracks.find(t => t.clips.some(c => c.id === frag.id))
    st().insertClipFromAsset(idB, tr.id, 3)
    const c2 = st().project.tracks.find(t => t.id === tr.id).clips.find(c => c.assetId === idB)
    st().updateClip(c2.id, { muted: true })
    st().setPlayhead(3.5)
    await new Promise(r => setTimeout(r, 3000))
    const mid = window.__px(0.72, 300)
    st().setPlayhead(4.5)
    await new Promise(r => setTimeout(r, 1500))
    const pure = window.__px(0.72, 300)
    return { mid, pure }
  })()`)
  check('overlap transition blends fragment with media (red bar ≈ half)',
    trans.mid[0] > trans.pure[0] * 0.25 && trans.mid[0] < trans.pure[0] * 0.8,
    `mid=${trans.mid} pure=${trans.pure}`)
} finally {
  if (fragId) {
    await evalJs(`(async () => window.kadr.fragmentDelete(${JSON.stringify(fragId)}))()`)
      .catch(() => { /* best effort */ })
  }
}

ws.close()
console.log('e2e25 finished')
