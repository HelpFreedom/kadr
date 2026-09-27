// Test: 3D models and Kadr's 3D kit end to end —
//   an STL and a 3MF (two objects) imported into the project's kadr-lib/models
//   at their real sizes, shown as tiles in the bin; a turntable fragment
//   inserted from the bin draws the model in the preview and renders; and the
//   collision check tells a part moving THROUGH another (a warning, at the
//   right time) from parts that touch all along (an assembly: a note).
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// REFUSES to run over an open project with clips (it replaces the project)
// unless KADR_E2E_FORCE=1. Works in /tmp/kadr-e2e49 and deletes it, with the
// fragments and renders it made. Needs three / @remotion/three /
// @react-three/fiber / three-mesh-bvh in the fragment workspace.
import WebSocket from 'ws'
import { zipSync, strToU8 } from 'fflate'
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { homedir } from 'os'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-e2e49'
const WS_DIR = process.env.KADR_FRAGMENTS_DIR || `${homedir()}/kadr-fragments`

const targets = () => fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = (await targets()).find((t) => t.type === 'page' && t.title === 'Kadr')
if (!page) throw new Error('editor page not found')

function connect(url) {
  const sock = new WebSocket(url, { perMessageDeflate: false })
  const ready = new Promise((r, j) => { sock.on('open', r); sock.on('error', j) })
  ready.catch(() => { /* closed before it opened: the send() that needs it reports */ })
  let id = 0
  const send = async (method, params = {}) => {
    await ready
    return new Promise((resolve, reject) => {
      const m = ++id
      const on = (raw) => { const x = JSON.parse(raw); if (x.id !== m) return; sock.off('message', on); x.error ? reject(new Error(JSON.stringify(x.error))) : resolve(x.result) }
      sock.on('message', on)
      sock.send(JSON.stringify({ id: m, method, params }))
    })
  }
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result.value
  }
  return { send, ev, close: () => { try { sock.close() } catch { /* not open yet */ } } }
}
let ed = connect(page.webSocketDebuggerUrl)
// long async work in the editor: park the result in a global and poll
// (awaitPromise over CDP is flaky under GC — see CLAUDE.md)
const evalJs = async (expression, timeout = 180000) => {
  const key = `k${Date.now()}_${Math.random().toString(36).slice(2)}`
  await ed.ev(`window.__e2e = window.__e2e || {}; (async () => { try { window.__e2e.${key} = JSON.stringify({ ok: await (${expression}) }) } catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`)
  const t0 = Date.now()
  for (;;) {
    const raw = await ed.ev(`window.__e2e.${key} ?? null`)
    if (raw !== null) { const r = JSON.parse(raw); if ('err' in r) throw new Error(r.err); return r.ok }
    if (Date.now() - t0 > timeout) throw new Error('eval timeout')
    await new Promise((r) => setTimeout(r, 200))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const S = 'window.kadrEditor.useEditor.getState()'
/** a CDP connection to the fragment page (iframe or capture window) of an id */
async function pageOf(fragId, type = 'iframe', timeout = 20000) {
  const t0 = Date.now()
  for (;;) {
    const t = (await targets()).find((x) => x.type === type && x.url.includes(`comp=${fragId}`))
    if (t) return { ...connect(t.webSocketDebuggerUrl), url: t.url }
    if (Date.now() - t0 > timeout) return null
    await sleep(250)
  }
}
/** until fn() is truthy (or the time is up) */
async function until(fn, timeout = 15000, step = 250) {
  const t0 = Date.now()
  for (;;) {
    const v = await fn().catch(() => null)
    if (v) return v
    if (Date.now() - t0 > timeout) return null
    await sleep(step)
  }
}



const clipsOpen = await ed.ev(`${S}.project.tracks.reduce((n, t) => n + t.clips.length, 0)`)
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e49 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

// a box [x0,x1]×[y0,y1]×[z0,z1] mm as vertices + triangles (Z-up CAD)
const box = (x0, x1, y0, y1, z0, z1) => {
  const v = []
  for (const x of [x0, x1]) for (const y of [y0, y1]) for (const z of [z0, z1]) v.push([x, y, z])
  const f = [[0, 1, 3], [0, 3, 2], [4, 6, 7], [4, 7, 5], [0, 4, 5], [0, 5, 1], [2, 3, 7], [2, 7, 6], [0, 2, 6], [0, 6, 4], [1, 5, 7], [1, 7, 3]]
  return { v, f }
}
const stl = (b) => {
  const buf = Buffer.alloc(84 + b.f.length * 50)
  buf.writeUInt32LE(b.f.length, 80)
  b.f.forEach((tri, i) => tri.forEach((vi, k) => b.v[vi].forEach((c, j) => buf.writeFloatLE(c, 84 + i * 50 + 12 + (k * 3 + j) * 4))))
  return buf
}
const obj3mf = (id, name, b) => `<object id="${id}" name="${name}" type="model"><mesh><vertices>${b.v.map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join('')}</vertices><triangles>${b.f.map(([a, c, d]) => `<triangle v1="${a}" v2="${c}" v3="${d}"/>`).join('')}</triangles></mesh></object>`

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })
writeFileSync(`${DIR}/block.stl`, stl(box(0, 40, 0, 20, 0, 10)))
// three objects: "base" and "lid" touch (lid sits ON base: an assembly), "slider" is apart
const xml = `<?xml version="1.0"?><model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>` +
  obj3mf(1, 'base', box(0, 60, 0, 60, 0, 20)) + obj3mf(2, 'lid', box(10, 50, 10, 50, 19, 30)) + obj3mf(3, 'slider', box(120, 150, 20, 40, 0, 20)) +
  `</resources><build><item objectid="1"/><item objectid="2"/><item objectid="3"/></build></model>`
writeFileSync(`${DIR}/kit.3mf`, zipSync({ '3D/3dmodel.model': strToU8(xml) }))

let made = []
const renders = []
try {
  const setup = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const mk = (name, kind) => ({ id: E.uid(), kind, name, muted: false, locked: false, gain: 1, clips: [] })
    st().setProject({ version: 1, id: E.uid(), name: 'e2e49', width: 1280, height: 720, fps: 30, background: '#000000',
      tracks: [mk('V', 'video')], assets: [], markers: [], texts: [] }, null)
    await window.kadr.writeProject('${DIR}/e2e49.kadr', st().project)
    st().setProjectPath('${DIR}/e2e49.kadr')
    await E.importFiles(['${DIR}/block.stl', '${DIR}/kit.3mf'], null)
    await new Promise((r) => setTimeout(r, 400))
    const models = E.useModelsUi.getState().models.map((m) => ({ name: m.name, size: m.sizeMm, parts: m.parts.map((p) => p.name) }))
    return { models, tiles: document.querySelectorAll('.bin-item.model').length, assets: st().project.assets.length }
  })()`)
  const block = setup.models.find((m) => m.name === 'block'), kit = setup.models.find((m) => m.name === 'kit')
  check('an STL goes to kadr-lib/models, not to the media: its real size, Z-up → Y-up (40 × 10 × 20)',
    !!block && JSON.stringify(block.size) === '[40,10,20]' && setup.assets === 0, JSON.stringify(block))
  check('a 3MF keeps its objects as parts', !!kit && kit.parts.join() === 'base,lid,slider', JSON.stringify(kit))
  check('both show in the bin as model tiles', setup.tiles === 2, `${setup.tiles}`)

  // ---- the turntable from the bin draws the model -------------------------------
  const tt = await evalJs(`(async () => {
    const E = window.kadrEditor
    E.useEditor.getState().setPlayhead(0)
    const f = await E.insertModelFragment('block', { start: 0, duration: 3 })
    await new Promise((r) => setTimeout(r, 2500))
    const r = await E.snapshotFrame({ t: 2.5, dir: '${DIR}', importToBin: false })
    const img = new Image(); img.crossOrigin = 'anonymous'; img.src = window.kadr.fileUrl(r.path); await img.decode()
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height
    const g = c.getContext('2d'); g.drawImage(img, 0, 0)
    const d = g.getImageData(0, 0, img.width, img.height).data
    let lit = 0
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 150) lit++
    return { id: f.id, lit: lit / (d.length / 4) }
  })()`, 120000)
  made.push(tt.id)
  check('a turntable fragment inserted from the bin draws the model', tt.lit > 0.02, `${(tt.lit * 100).toFixed(1)} % of the frame lit`)
  const tc = await evalJs(`window.kadr.fragmentTypecheck('${tt.id}')`, 180000)
  check('…and its code type-checks against the kit', tc.ok, JSON.stringify(tc.errors.slice(0, 2)))

  // ---- collisions: the slider passes through the base between 1 and 2 s -------
  const coll = await evalJs(`(async () => {
    const E = window.kadrEditor
    const f = await E.createFragment({ name: 'e2e49-collide', start: 3, end: 6, transparent: false })
    await window.kadr.writeTextFile(f.entry, \`import React from 'react'
import { useCurrentFrame, useVideoConfig } from 'remotion'
import { Scene3D, Studio, Camera, cameraPath, useModel, Part } from '@kadr/three'
import url from '@lib/models/kit.glb'
import meta from './meta.json'
const cam = cameraPath([{ t: 0, target: [0, 0.2, 0], az: 0, el: 30, r: 4 }])
const F: React.FC = () => {
  const { fps, width, height } = useVideoConfig()
  const t = useCurrentFrame() / fps
  const m = useModel(url)
  if (!m) return null
  // 1–2 s: the slider travels 2.2 units towards −x — into the base, through it and out
  const x = -2.2 * Math.min(1, Math.max(0, t - 1))
  return (
    <Scene3D width={width} height={height} background="#101014">
      <Studio shadow={false} />
      <Camera cam={cam(t)} aspect={width / height} />
      <Part part={m.parts.base} />
      <Part part={m.parts.lid} />
      <Part part={m.parts.slider} position={[x, 0, 0]} />
    </Scene3D>
  )
}
export const fragment = { component: F, meta }
\`)
    await new Promise((r) => setTimeout(r, 1500))
    const r = await E.runChecks({ collisions: true, clipIds: [f.clipId] })
    return { id: f.id, issues: r.issues.map((i) => ({ kind: i.kind, level: i.level, t: +i.t.toFixed(2), end: i.end != null ? +i.end.toFixed(2) : null, m: i.message })) }
  })()`, 600000)
  made.push(coll.id)
  const hits = coll.issues.filter((i) => i.kind === 'collision')
  // the slider crosses the base (and grazes the lid's lowest millimetre on the way)
  check('a part moving through another is found, inside the time it happens',
    hits.some((i) => /slider/.test(i.m) && /base/.test(i.m)) && hits.every((i) => /slider/.test(i.m) && i.t >= 3 + 1 && (i.end ?? i.t) <= 3 + 2.1),
    JSON.stringify(hits.map((i) => [i.t, i.end, i.m.split(' проходят')[0]])))
  check('parts touching all along are an assembly (a note, not a warning)',
    coll.issues.some((i) => i.kind === 'contact' && /\bbase\b/.test(i.m) && /\blid\b/.test(i.m) && i.level === 'info') &&
      !hits.some((i) => /\blid\b/.test(i.m) && /\bbase\b/.test(i.m)), JSON.stringify(coll.issues.map((i) => [i.kind, i.level, i.m.slice(0, 40)])))

  // ---- the turntable renders -----------------------------------------------------
  const r = await evalJs(`window.kadr.fragmentRender('${tt.id}')`, 600000)
  if (r?.path) renders.push(r.path)
  check('the turntable renders through remotion (kit + model through webpack)', !!r?.path && existsSync(r.path), JSON.stringify(r))
} finally {
  for (const f of made) await ed.ev(`window.kadr.fragmentDelete('${f}').then(() => 1, () => 0)`).catch(() => {})
  for (const p of renders) rmSync(p, { force: true })
  rmSync(DIR, { recursive: true, force: true })
  ed.close()
}
