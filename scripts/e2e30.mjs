// Test: blur effect — an Effect{type:'blur'} softens the layer in the GL
// preview (peak edge gradient collapses), intensity scales it, disabling
// restores sharpness, fx presets carry the stack, export renders it.
import WebSocket from 'ws'
import { execFileSync } from 'child_process'

const PORT = process.env.KADR_CDP_PORT || 9777

execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test && ffmpeg -v error -f lavfi -i "smptebars=s=640x360:d=3:r=30" ' +
  '-c:v libx264 -crf 18 -pix_fmt yuv420p -y /tmp/kadr-test/b.mp4'])

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
    await new Promise((r) => setTimeout(r, 400))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

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

// setup: centered bars clip + edge-energy probe over the middle strip
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const { asset } = await window.kadr.probeMedia('/tmp/kadr-test/b.mp4')
  const idB = ed.uid()
  st().addAsset({ id: idB, ...asset })
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  st().insertClipFromAsset(idB, v1.id, 0)
  const c = v1.clips ? st().project.tracks.find(t => t.name === 'V1').clips[0]
              : null
  window.__clipId = st().project.tracks.find(t => t.name === 'V1').clips[0].id
  st().setPlayhead(0.5)
  st().select([])
  window.__edgeEnergy = () => {
    const cv = document.querySelector('.preview canvas') || document.querySelector('canvas')
    const t = document.createElement('canvas')
    t.width = cv.width; t.height = cv.height
    const ctx = t.getContext('2d')
    ctx.drawImage(cv, 0, 0)
    const y = Math.round(cv.height / 2)
    const row = ctx.getImageData(0, y, cv.width, 1).data
    let e = 0
    for (let x = 1; x < cv.width; x++) {
      const g = Math.abs(row[x * 4] - row[(x - 1) * 4]) +
                Math.abs(row[x * 4 + 1] - row[(x - 1) * 4 + 1])
      if (g > e) e = g // peak gradient: blur flattens it, sums stay invariant
    }
    return e
  }
  await new Promise(r => setTimeout(r, 900))
  return true
})()`)

const sharp = await evalJs(`(async () => window.__edgeEnergy())()`)

// blur effect on → peak gradient collapses
const blurred = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const c = () => st().project.tracks.flatMap(t => t.clips).find(x => x.id === window.__clipId)
  window.__fxId = ed.uid()
  st().updateClip(c().id, { effects: [{ id: window.__fxId, type: 'blur', enabled: true, params: { size: 40 } }] })
  await new Promise(r => setTimeout(r, 700))
  return window.__edgeEnergy()
})()`)
check('blur effect (size 40) softens the layer (≥3×)',
  sharp > 60 && blurred < sharp / 3, `sharp=${sharp} blurred=${blurred}`)

// the intensity slider scales the effect; the checkbox turns it off
const knobs = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const c = () => st().project.tracks.flatMap(t => t.clips).find(x => x.id === window.__clipId)
  const patch = (p) => st().updateClip(c().id, {
    effects: c().effects.map(e => e.id === window.__fxId ? { ...e, ...p } : e)
  })
  patch({ params: { size: 150 } })
  await new Promise(r => setTimeout(r, 700))
  const strong = window.__edgeEnergy()
  patch({ enabled: false })
  await new Promise(r => setTimeout(r, 700))
  const off = window.__edgeEnergy()
  patch({ enabled: true, params: { size: 40 } })
  return { strong, off }
})()`)
check('higher intensity blurs more; disabling restores sharpness',
  knobs.strong <= blurred && knobs.off > sharp * 0.8,
  JSON.stringify({ blurred, ...knobs }))

// fx preset carries the blur effect across clips/projects
const fxp = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const c = () => st().project.tracks.flatMap(t => t.clips).find(x => x.id === window.__clipId)
  ed.useFxPresets.getState().savePreset({
    name: 'e2e-blur-fx',
    effects: c().effects.map(e => ({ ...e, params: { ...e.params } }))
  })
  st().updateClip(c().id, { effects: [] })
  const preset = ed.useFxPresets.getState().presets.find(p => p.name === 'e2e-blur-fx')
  // apply the way the ⭐ menu does: fresh ids, copied params
  st().updateClip(c().id, { effects: preset.effects.map(e => ({ ...e, id: ed.uid(), params: { ...e.params } })) })
  const fx = c().effects.find(e => e.type === 'blur')
  ed.useFxPresets.getState().deletePreset(preset.id)
  window.__fxId = fx?.id
  return { size: fx?.params.size, enabled: fx?.enabled, newId: fx && fx.id !== undefined }
})()`)
check('fx preset stores and re-applies the blur effect',
  fxp.size === 40 && fxp.enabled === true && fxp.newId === true, JSON.stringify(fxp))

// export carries the blur (WYSIWYG)
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const c = () => st().project.tracks.flatMap(t => t.clips).find(x => x.id === window.__clipId)
  st().updateClip(c().id, { effects: [], muted: true })
  const preset = ed.PRESETS.find(p => p.container === 'mp4')
  let h = ed.startExport(st().project, preset, '/tmp/kadr-test/blur-off.mp4', () => {}, { start: 0.4, end: 0.9 }, { motionBlur: false })
  await h.done
  st().updateClip(c().id, { effects: [{ id: ed.uid(), type: 'blur', enabled: true, params: { size: 40 } }] })
  h = ed.startExport(st().project, preset, '/tmp/kadr-test/blur-on.mp4', () => {}, { start: 0.4, end: 0.9 }, { motionBlur: false })
  await h.done
  return true
})()`)
const energies = []
for (const f of ['blur-off', 'blur-on']) {
  execFileSync('bash', ['-c',
    `ffmpeg -v error -ss 0.2 -i /tmp/kadr-test/${f}.mp4 -frames:v 1 -vf format=gray -f rawvideo -y /tmp/kadr-test/${f}.gray`])
  energies.push(Number(execFileSync('python3', ['-c', `
data = open('/tmp/kadr-test/${f}.gray','rb').read()
W = 1920
y = 540
row = data[y*W:(y+1)*W]
print(max(abs(row[x]-row[x-1]) for x in range(1, W)))
`]).toString().trim()))
}
check('export renders the blur (edge energy drops ≥3×)',
  energies[0] > 8 && energies[1] < energies[0] / 3,
  `off=${energies[0]} on=${energies[1]}`)

ws.close()
console.log('e2e30 finished')
