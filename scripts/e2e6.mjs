// Test: linked audio+video clips, U unlink, speed/trim keyframe rebinding,
// shape masks (ellipse + invert + feather) on the GPU, smooth interpolation flag.
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
async function mouse(type, x, y, opts = {}) {
  await send('Input.dispatchMouseEvent', {
    type, x: Math.round(x), y: Math.round(y),
    button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1, ...opts
  })
}
async function drag(x0, y0, x1, y1) {
  await mouse('mousePressed', x0, y0)
  for (let i = 1; i <= 8; i++) {
    await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 8, y0 + ((y1 - y0) * i) / 8)
    await new Promise((r) => setTimeout(r, 25))
  }
  await mouse('mouseReleased', x1, y1)
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
try { await rawEval('setTimeout(() => location.reload(), 50); 0') } catch { /* reloading */ }
await new Promise((r) => setTimeout(r, 1800))
for (let i = 0; i < 30; i++) {
  try {
    if (await rawEval(`!!window.kadrEditor && !!window.kadr`)) break
  } catch { /* mid-reload */ }
  await new Promise((r) => setTimeout(r, 1000))
}

// 1. inserting a video with audio creates a linked pair
const pair = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/a.mp4')
  const idA = ed.uid()
  st().addAsset({ id: idA, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idA, v1.id, 0)
  st().setZoom(50)
  const p = st().project
  const vc = p.tracks.find(t => t.name === 'V1').clips[0]
  const ac = p.tracks.find(t => t.kind === 'audio').clips[0]
  return {
    video: vc ? { link: vc.linkId, muted: vc.muted } : null,
    audio: ac ? { link: ac.linkId, muted: ac.muted, start: ac.start, dur: ac.duration } : null,
    sel: st().selection.length
  }
})()`)
check('video insert creates linked audio clip on A-track',
  !!pair.audio && pair.video.link === pair.audio.link && pair.video.muted && !pair.audio.muted,
  JSON.stringify(pair))

// 2. dragging the video clip moves the audio twin (real mouse)
await evalJs(`(() => { window.kadrEditor.useEditor.getState().select([]); return 1 })()`)
const vr = await evalJs(`(() => {
  const el = document.querySelector('.lane.video .clip')
  const r = el.getBoundingClientRect()
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
})()`)
await drag(vr.cx, vr.cy, vr.cx + 100, vr.cy)
const moved = await evalJs(`(() => {
  const p = window.kadrEditor.useEditor.getState().project
  return {
    v: +p.tracks.find(t => t.name === 'V1').clips[0].start.toFixed(2),
    a: +p.tracks.find(t => t.kind === 'audio').clips[0].start.toFixed(2)
  }
})()`)
check('linked pair moves together', moved.v > 1.5 && Math.abs(moved.v - moved.a) < 0.01, JSON.stringify(moved))

// 3. U unlinks: after unlink, moving video leaves audio in place
const unlink = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const p = st().project
  const vc = p.tracks.find(t => t.name === 'V1').clips[0]
  st().select([vc.id])
  st().toggleLinkSelection()
  const p2 = st().project
  return {
    v: p2.tracks.find(t => t.name === 'V1').clips[0].linkId ?? null,
    a: p2.tracks.find(t => t.kind === 'audio').clips[0].linkId ?? null
  }
})()`)
check('U unlinks the pair', unlink.v === null && unlink.a === null, JSON.stringify(unlink))
await evalJs(`(() => { window.kadrEditor.useEditor.getState().select([]); return 1 })()`)
const vr2 = await evalJs(`(() => {
  const el = document.querySelector('.lane.video .clip')
  const r = el.getBoundingClientRect()
  return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }
})()`)
await drag(vr2.cx, vr2.cy, vr2.cx - 50, vr2.cy)
const moved2 = await evalJs(`(() => {
  const p = window.kadrEditor.useEditor.getState().project
  return {
    v: +p.tracks.find(t => t.name === 'V1').clips[0].start.toFixed(2),
    a: +p.tracks.find(t => t.kind === 'audio').clips[0].start.toFixed(2)
  }
})()`)
check('after unlink they move separately', Math.abs(moved2.v - moved2.a) > 0.5, JSON.stringify(moved2))

// 4. speed change rescales keyframes and fades
const speedKf = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const vc = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(vc.id, {
    fadeIn: 1,
    transform: { ...vc.transform, scale: { value: 1, keyframes: [
      { time: 1, value: 0.5, easing: 'linear' },
      { time: 4, value: 1.5, easing: 'linear' }
    ] } }
  })
  st().setClipSpeed(vc.id, 2, vc.duration / 2) // twice as fast
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  return {
    kfs: c.transform.scale.keyframes.map(k => +k.time.toFixed(3)),
    fadeIn: +c.fadeIn.toFixed(3),
    speed: c.speed
  }
})()`)
check('speed×2 rescales keyframes (1,4 -> 0.5,2) and fade (1 -> 0.5)',
  JSON.stringify(speedKf.kfs) === '[0.5,2]' && Math.abs(speedKf.fadeIn - 0.5) < 0.01,
  JSON.stringify(speedKf))

// 5. trim-in shifts keyframes to stay on content
const trimKf = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c0 = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().trimClip(c0.id, 'in', c0.start + 0.5)
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  return c.transform.scale.keyframes.map(k => +k.time.toFixed(3))
})()`)
check('trim-in 0.5s shifts keyframes (0.5,2 -> 0,1.5)', JSON.stringify(trimKf) === '[0,1.5]', JSON.stringify(trimKf))

// 6. ellipse shape mask on GPU: center lit, corners dark; invert flips it
const shapePix = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, {
    transform: { x:{value:0}, y:{value:0}, scale:{value:1}, rotation:{value:0}, opacity:{value:1} },
    fadeIn: 0,
    maskShape: {
      type: 'ellipse',
      cx: {value:0.5}, cy: {value:0.5}, w: {value:0.5}, h: {value:0.5},
      featherIn: {value:0}, featherOut: {value:0}, invert: false
    }
  })
  st().setPlayhead(c.start + 0.5)
  await new Promise(r => setTimeout(r, 2000))
  const sample = () => {
    const canvas = document.querySelector('.preview canvas')
    const off = document.createElement('canvas')
    off.width = canvas.width; off.height = canvas.height
    const ctx = off.getContext('2d')
    ctx.drawImage(canvas, 0, 0)
    const d = ctx.getImageData(0, 0, off.width, off.height).data
    const px = (fx, fy) => {
      const i = ((Math.floor(off.height * fy) * off.width) + Math.floor(off.width * fx)) * 4
      return d[i] + d[i+1] + d[i+2]
    }
    return { center: px(0.5, 0.5), corner: px(0.06, 0.06) }
  }
  const normal = sample()
  const cc = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(cc.id, { maskShape: { ...cc.maskShape, invert: true } })
  await new Promise(r => setTimeout(r, 800))
  const inverted = sample()
  return { normal, inverted }
})()`)
check('ellipse mask: center lit, corner dark',
  shapePix.normal.center > 60 && shapePix.normal.corner < 20, JSON.stringify(shapePix.normal))
check('invert (exclude) flips the mask',
  shapePix.inverted.center < 20 && shapePix.inverted.corner > 60, JSON.stringify(shapePix.inverted))

// 7. feather softens the edge (alpha between 0 and full near the boundary)
const feather = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, { maskShape: { ...c.maskShape, invert: false,
    featherIn: {value:0.15}, featherOut: {value:0.15} } })
  await new Promise(r => setTimeout(r, 800))
  const canvas = document.querySelector('.preview canvas')
  const off = document.createElement('canvas')
  off.width = canvas.width; off.height = canvas.height
  const ctx = off.getContext('2d')
  ctx.drawImage(canvas, 0, 0)
  const d = ctx.getImageData(0, 0, off.width, off.height).data
  const px = (fx, fy) => {
    const i = ((Math.floor(off.height * fy) * off.width) + Math.floor(off.width * fx)) * 4
    return d[i] + d[i+1] + d[i+2]
  }
  // ellipse half-height = 0.25 of layer; vertical edge at y=0.25 from center
  return { center: px(0.5, 0.5), edge: px(0.5, 0.26), out: px(0.5, 0.06) }
})()`)
check('feather makes a soft edge (center > edge > outside)',
  feather.center > feather.edge * 1.2 && feather.edge > feather.out + 10,
  JSON.stringify(feather))

// 8. smooth flag toggles parabolic interpolation
const smooth = await evalJs(`(() => {
  const st = () => window.kadrEditor.useEditor.getState()
  const c = st().project.tracks.find(t => t.name === 'V1').clips[0]
  st().updateClip(c.id, { transform: { ...c.transform,
    x: { value: 0, smooth: true, keyframes: [
      { time: 0, value: 0, easing: 'linear' },
      { time: 1, value: 100, easing: 'linear' },
      { time: 2, value: 0, easing: 'linear' }
    ] } } })
  return st().project.tracks.find(t => t.name === 'V1').clips[0].transform.x.smooth === true
})()`)
check('smooth flag persists on anim', smooth === true)

ws.close()
console.log('e2e6 finished')
