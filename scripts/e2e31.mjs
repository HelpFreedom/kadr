// Test: v0.2.1 feature batch —
//  1) importFiles (OS drag-and-drop backend): probe+add to bin with path
//     dedup, clips laid back-to-back from the drop point, audio routed to
//     an audio track, one undo entry;
//  2) media bin deletion: per-tile ✕ with confirm dialog when timeline clips
//     use the asset, cascade removal (linked twin included), single undo;
//  3) unlimited clip speed with snap during Ctrl-drag (old 0.25–4 clamp gone);
//  4) playbackRate clamp — playback keeps running at speed 30;
//  5) Claude panel: rect restored from localStorage, header drag moves it,
//     corner resize works, both persisted.
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { createServer } from 'http'

const PORT = process.env.KADR_CDP_PORT || 9777
const ENV_FILE = `${process.env.HOME}/.config/kadr/claude-env.json`

// self-contained media: video+audio, video-only, image, audio-only
execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test && ' +
  '[ -f /tmp/kadr-test/b.mp4 ] || ffmpeg -v error -f lavfi -i smptebars=duration=3:size=640x360:rate=30 -pix_fmt yuv420p -c:v libx264 -movflags +faststart -y /tmp/kadr-test/b.mp4 && ' +
  'ffmpeg -v error -f lavfi -i smptebars=duration=3:size=640x360:rate=30 -f lavfi -i sine=frequency=440:duration=3 ' +
  '-pix_fmt yuv420p -c:v libx264 -c:a aac -shortest -movflags +faststart -y /tmp/kadr-test/ba.mp4 && ' +
  'ffmpeg -v error -f lavfi -i color=c=orange:s=320x240 -frames:v 1 -y /tmp/kadr-test/img.png && ' +
  'ffmpeg -v error -f lavfi -i sine=frequency=220:duration=2 -y /tmp/kadr-test/aud.wav'])

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

// ---- 1. importFiles: the drag-and-drop backend ------------------------------
check('pathForFile bridge exists', await evalJs(`typeof window.kadr.pathForFile === 'function'`))

const imp = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  await ed.importFiles(['/tmp/kadr-test/ba.mp4', '/tmp/kadr-test/img.png', '/tmp/kadr-test/aud.wav'],
    { trackId: v1.id, at: 2 })
  const p = st().project
  const vClips = p.tracks.find(t => t.name === 'V1').clips
    .slice().sort((a, b) => a.start - b.start)
  const aClips = p.tracks.filter(t => t.kind === 'audio').flatMap(t => t.clips)
    .slice().sort((a, b) => a.start - b.start)
  return {
    assets: p.assets.length,
    undoLabel: st().past[st().past.length - 1]?.label,
    v: vClips.map(c => ({ start: c.start, dur: c.duration, linked: !!c.linkId })),
    a: aClips.map(c => ({ start: c.start, dur: c.duration, linked: !!c.linkId }))
  }
})()`)
const vOk = imp.v.length === 2 &&
  Math.abs(imp.v[0].start - 2) < 0.01 && Math.abs(imp.v[0].dur - 3) < 0.15 && imp.v[0].linked &&
  Math.abs(imp.v[1].start - (imp.v[0].start + imp.v[0].dur)) < 0.01 && Math.abs(imp.v[1].dur - 5) < 0.01
const audStart = imp.v[1].start + imp.v[1].dur
const aOk = imp.a.length === 2 && imp.a.some(c => c.linked) &&
  imp.a.some(c => !c.linked && Math.abs(c.start - audStart) < 0.01 && Math.abs(c.dur - 2) < 0.15)
check('importFiles adds 3 assets and lays clips back-to-back', imp.assets === 3 && vOk,
  JSON.stringify(imp.v))
check('audio file lands on an audio track after the image', aOk, JSON.stringify(imp.a))
check('placement is one undo entry', imp.undoLabel === 'hInsert', imp.undoLabel)

const dedup = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const before = st().project.assets.length
  await ed.importFiles(['/tmp/kadr-test/ba.mp4'], null)
  return { before, after: st().project.assets.length }
})()`)
check('re-importing the same path reuses the asset', dedup.after === dedup.before,
  JSON.stringify(dedup))

// ---- 2. media bin deletion --------------------------------------------------
const del = await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  const asset = st().project.assets.find(a => a.path.endsWith('ba.mp4'))
  // tile ✕ → confirm dialog (clips use this asset)
  const tile = [...document.querySelectorAll('.bin-item')]
    .find(el => el.title.endsWith('ba.mp4'))
  tile.querySelector('.bin-del').click()
  await new Promise(r => setTimeout(r, 200))
  const dialog = document.querySelector('.bin-confirm')
  const dialogText = dialog?.textContent ?? ''
  dialog?.querySelector('button.danger')?.click()
  await new Promise(r => setTimeout(r, 200))
  const p = st().project
  return {
    hadDialog: !!dialog,
    dialogText,
    assetGone: !p.assets.some(a => a.id === asset.id),
    othersKept: p.assets.length === 2,
    clipsGone: !p.tracks.some(t => t.clips.some(c => c.assetId === asset.id)),
    remainingClips: p.tracks.reduce((n, t) => n + t.clips.length, 0),
    undoLabel: st().past[st().past.length - 1]?.label
  }
})()`)
check('tile ✕ shows a confirm dialog and removes asset + its clips (linked twin too)',
  del.hadDialog && del.assetGone && del.othersKept && del.clipsGone && del.remainingClips === 2,
  JSON.stringify({ ...del, dialogText: undefined }))
check('deletion is one hDeleteMedia undo entry', del.undoLabel === 'hDeleteMedia', del.undoLabel)

const undo = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  st().undo()
  await new Promise(r => setTimeout(r, 100))
  const p = st().project
  return {
    assets: p.assets.length,
    clips: p.tracks.reduce((n, t) => n + t.clips.length, 0)
  }
})()`)
check('one undo restores the asset and all its clips', undo.assets === 3 && undo.clips === 4,
  JSON.stringify(undo))

const batch = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const tiles = [...document.querySelectorAll('.bin-item')]
  tiles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
  for (const el of tiles.slice(1)) {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
  }
  await new Promise(r => setTimeout(r, 150))
  const btn = document.querySelector('.bin-del-sel')
  const label = btn?.textContent?.trim()
  btn?.click()
  await new Promise(r => setTimeout(r, 200))
  document.querySelector('.bin-confirm button.danger')?.click()
  await new Promise(r => setTimeout(r, 200))
  const p = st().project
  return {
    label,
    assets: p.assets.length,
    clips: p.tracks.reduce((n, t) => n + t.clips.length, 0)
  }
})()`)
check('multi-select batch delete empties bin and timeline', batch.label === '✕ 3' &&
  batch.assets === 0 && batch.clips === 0, JSON.stringify(batch))

// ---- 3. unlimited speed + snap (real Ctrl-drag on the extend handle) --------
await evalJs(`(async () => {
  const ed = window.kadrEditor
  const st = () => ed.useEditor.getState()
  st().undo() // restore assets/clips from the batch delete for the speed test
  await new Promise(r => setTimeout(r, 100))
  st().setZoom(60)
  const v1 = st().project.tracks.find(t => t.name === 'V1')
  const clip = v1.clips.slice().sort((a, b) => a.start - b.start)[0] // ba.mp4, 3 s
  st().select([clip.id])
  window.__spd = { clipId: clip.id }
  await new Promise(r => setTimeout(r, 300))
  return true
})()`)

const ctrlDragTo = (dxExpr) => evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const clip = () => st().project.tracks.flatMap(t => t.clips)
    .find(c => c.id === window.__spd.clipId)
  st().select([window.__spd.clipId]) // undo() clears the selection
  await new Promise(r2 => setTimeout(r2, 150))
  const el = [...document.querySelectorAll('.clip.selected')][0]
  const h = el.querySelector('.extend-handle')
  const r = h.getBoundingClientRect()
  const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2
  const dx = ${dxExpr}
  const opts = { bubbles: true, pointerId: 9, isPrimary: true, button: 0, ctrlKey: true }
  h.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y0 }))
  window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x0 + dx, clientY: y0 }))
  await new Promise(r2 => setTimeout(r2, 120))
  const b = document.querySelector('.speed-badge')
  const badge = b ? { text: b.textContent, snapped: b.classList.contains('snapped') } : null
  window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x0 + dx, clientY: y0 }))
  await new Promise(r2 => setTimeout(r2, 150))
  const c = clip()
  return { speed: c.speed, dur: c.duration, badge, badgeGone: !document.querySelector('.speed-badge') }
})()`)

// srcSpan = 3 s @ zoom 60. Target nd = 0.36 s (raw ×8.33) → must snap to ×8.
const s1 = await ctrlDragTo('0.36 * 60 - (clip().duration * 60)')
check('speed drag snaps to the round ×8', Math.abs(s1.speed - 8) < 1e-6, `×${s1.speed}`)
check('drag shows the ×N badge, highlighted while snapped, gone after',
  s1.badge?.text === '×8.00' && s1.badge?.snapped === true && s1.badgeGone,
  JSON.stringify({ badge: s1.badge, gone: s1.badgeGone }))
await evalJs(`(window.kadrEditor.useEditor.getState().undo(), true)`)

// drag all the way in: nd floors at 0.05 s → far beyond the old ×4 clamp
const s2 = await ctrlDragTo('-clip().duration * 60')
check('speed is no longer capped at ×4', s2.speed > 30, `×${s2.speed}`)
await evalJs(`(window.kadrEditor.useEditor.getState().undo(), true)`)

// drag out to nd = 13 s (raw ×0.2308, no snap near) → below the old 0.25 floor
const s3 = await ctrlDragTo('(13 - clip().duration) * 60')
check('slowdown goes below the old ×0.25 floor', s3.speed < 0.24 && s3.speed > 0.2,
  `×${s3.speed.toFixed(4)}`)
check('badge is not highlighted off the snap ladder', s3.badge?.snapped === false,
  JSON.stringify(s3.badge))
await evalJs(`(window.kadrEditor.useEditor.getState().undo(), true)`)

// LEFT-edge drags: Ctrl = speed with the right edge anchored; plain = trim-in
const dragLeft = (dxExpr, ctrl) => evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const clip = () => st().project.tracks.flatMap(t => t.clips)
    .find(c => c.id === window.__spd.clipId)
  st().select([window.__spd.clipId])
  await new Promise(r2 => setTimeout(r2, 150))
  const el = [...document.querySelectorAll('.clip.selected')][0]
  const h = el.querySelector('.extend-handle.left')
  const r = h.getBoundingClientRect()
  const x0 = r.left + r.width / 2, y0 = r.top + r.height / 2
  const dx = ${dxExpr}
  const o = clip()
  const orig = { start: o.start, end: o.start + o.duration }
  const opts = { bubbles: true, pointerId: 13, isPrimary: true, button: 0, ctrlKey: ${ctrl} }
  h.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y0 }))
  window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x0 + dx, clientY: y0 }))
  window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x0 + dx, clientY: y0 }))
  await new Promise(r2 => setTimeout(r2, 150))
  const c = clip()
  return { orig, speed: c.speed, start: c.start, end: c.start + c.duration, inPoint: c.inPoint }
})()`)

// Ctrl+left: raw nd ≈ 1.6 s → snaps to ×2 (nd = dur/2); the END must not move
const s4 = await dragLeft('85', true)
check('LEFT-edge Ctrl-drag changes speed with the right edge anchored (snaps ×2)',
  Math.abs(s4.speed - 2) < 1e-6 && Math.abs(s4.end - s4.orig.end) < 1e-3 &&
  Math.abs(s4.start - (s4.orig.end - (s4.orig.end - s4.orig.start) / 2)) < 1e-3,
  JSON.stringify(s4))
await evalJs(`(window.kadrEditor.useEditor.getState().undo(), true)`)

// plain left drag: trim-in — start moves, content stays (inPoint grows)
const s5 = await dragLeft('30', false)
check('LEFT-edge plain drag trims in (start +0.5, inPoint +0.5, end fixed)',
  Math.abs(s5.start - (s5.orig.start + 0.5)) < 1e-3 && Math.abs(s5.inPoint - 0.5) < 1e-3 &&
  Math.abs(s5.end - s5.orig.end) < 1e-3 && Math.abs(s5.speed - 1) < 1e-6,
  JSON.stringify(s5))
await evalJs(`(window.kadrEditor.useEditor.getState().undo(), true)`)

// ---- 4. playback survives an extreme speed (playbackRate clamp) -------------
// an unclamped rate throws NotSupportedError inside the rAF tick, which the
// player logs as a throttled 'player tick failed' — count those while playing
const play = await evalJs(`(async () => {
  const st = () => window.kadrEditor.useEditor.getState()
  const clip = st().project.tracks.find(t => t.name === 'V1').clips
    .slice().sort((a, b) => a.start - b.start)[0]
  st().pushHistory('hSpeed')
  st().setClipSpeed(clip.id, 30, clip.duration * (clip.speed || 1) / 30)
  const orig = console.error
  let tickErrors = 0
  console.error = (...a) => {
    if (String(a[0]).includes('player tick failed')) tickErrors++
    orig(...a)
  }
  st().setPlayhead(Math.max(0, clip.start - 0.05))
  st().setPlaying(true)
  const t0 = st().playhead
  await new Promise(r => setTimeout(r, 700))
  const t1 = st().playhead
  st().setPlaying(false)
  console.error = orig
  st().undo()
  return { t0, t1, tickErrors, advanced: t1 > t0 + 0.3 }
})()`)
check('playback at ×30 runs without tick errors (playbackRate clamped)',
  play.advanced && play.tickErrors === 0, JSON.stringify(play))

// ---- 5. Claude panel: restore, drag, resize, persist -------------------------
let envBackup = null
let envWritten = false
try { envBackup = readFileSync(ENV_FILE, 'utf8') } catch { /* none */ }
// a leftover test override from a crashed run is NOT the user's config —
// restoring it would silently turn the user's Claude panel into plain bash
if (envBackup !== null && /"command"\s*:\s*"bash"/.test(envBackup)) envBackup = null
try {
  writeFileSync(ENV_FILE, JSON.stringify({ command: 'bash', args: [] }))
  envWritten = true

  const panel = await evalJs(`(async () => {
    localStorage.setItem('kadr.claudeRect', JSON.stringify({ x: 80, y: 90, w: 520, h: 400 }))
    const btn = document.querySelector('.claude-btn')
    btn.click()
    for (let i = 0; i < 20; i++) {
      if (document.querySelector('.claude-panel')) break
      await new Promise(r => setTimeout(r, 250))
    }
    const el = document.querySelector('.claude-panel')
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.top, w: r.width, h: r.height }
  })()`)
  check('panel opens at the persisted rect', Math.abs(panel.x - 80) < 2 &&
    Math.abs(panel.y - 90) < 2 && Math.abs(panel.w - 520) < 2 && Math.abs(panel.h - 400) < 2,
    JSON.stringify(panel))

  const moved = await evalJs(`(async () => {
    const head = document.querySelector('.claude-head')
    const r = head.getBoundingClientRect()
    const x0 = r.left + r.width / 2, y0 = r.top + 8
    const opts = { bubbles: true, pointerId: 11, isPrimary: true, button: 0 }
    head.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y0 }))
    window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x0 + 60, clientY: y0 + 40 }))
    window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x0 + 60, clientY: y0 + 40 }))
    await new Promise(r2 => setTimeout(r2, 150))
    const b = document.querySelector('.claude-panel').getBoundingClientRect()
    return { x: b.left, y: b.top, saved: JSON.parse(localStorage.getItem('kadr.claudeRect')) }
  })()`)
  check('header drag moves the panel and persists it', Math.abs(moved.x - 140) < 2 &&
    Math.abs(moved.y - 130) < 2 && Math.abs(moved.saved.x - 140) < 2,
    JSON.stringify(moved))

  const resized = await evalJs(`(async () => {
    const h = document.querySelector('.claude-rs.br')
    const r = h.getBoundingClientRect()
    const x0 = r.left + 4, y0 = r.top + 4
    const opts = { bubbles: true, pointerId: 12, isPrimary: true, button: 0 }
    h.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: x0, clientY: y0 }))
    window.dispatchEvent(new PointerEvent('pointermove', { ...opts, clientX: x0 + 50, clientY: y0 + 30 }))
    window.dispatchEvent(new PointerEvent('pointerup', { ...opts, clientX: x0 + 50, clientY: y0 + 30 }))
    await new Promise(r2 => setTimeout(r2, 150))
    const b = document.querySelector('.claude-panel').getBoundingClientRect()
    const saved = JSON.parse(localStorage.getItem('kadr.claudeRect'))
    document.querySelector('.claude-close').click()
    await new Promise(r2 => setTimeout(r2, 300))
    return { w: b.width, h: b.height, saved, closed: !document.querySelector('.claude-panel') }
  })()`)
  check('corner resize grows the panel and persists it', Math.abs(resized.w - 570) < 2 &&
    Math.abs(resized.h - 430) < 2 && Math.abs(resized.saved.w - 570) < 2 && resized.closed,
    JSON.stringify(resized))
} finally {
  if (envWritten) {
    if (envBackup !== null) writeFileSync(ENV_FILE, envBackup)
    else { try { unlinkSync(ENV_FILE) } catch { /* gone */ } }
  }
}

// ---- 6. browser-style drop: an image URL, no files --------------------------
// (an <img> dragged out of a browser carries text/uri-list — the app must
// download it and place a clip; a local http server stands in for the CDN)
const srv = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'image/png' })
  res.end(readFileSync('/tmp/kadr-test/img.png'))
})
await new Promise((r) => srv.listen(0, '127.0.0.1', r))
const picUrl = `http://127.0.0.1:${srv.address().port}/e2e31-drop.png`
const laneBox = await evalJs(`(() => {
  const el = document.querySelector('[data-lane]')
  const r = el.getBoundingClientRect()
  return { x: r.left + 130, y: r.top + r.height / 2 }
})()`)
const dragData = {
  items: [{ mimeType: 'text/uri-list', data: picUrl }],
  files: [],
  dragOperationsMask: 1
}
for (const type of ['dragEnter', 'dragOver', 'drop']) {
  await send('Input.dispatchDragEvent', { type, x: laneBox.x, y: laneBox.y, data: dragData })
}
let urlDrop = null
for (let i = 0; i < 24; i++) {
  await new Promise((r) => setTimeout(r, 500))
  urlDrop = await evalJs(`(() => {
    const p = window.kadrEditor.useEditor.getState().project
    const a = p.assets.find(x => x.name.endsWith('e2e31-drop.png'))
    if (!a) return null
    const clip = p.tracks.flatMap(t => t.clips).find(c => c.assetId === a.id)
    return { kind: a.kind, placed: !!clip }
  })()`)
  if (urlDrop) break
}
srv.close()
check('browser image URL drop downloads the file and places a clip',
  !!urlDrop && urlDrop.kind === 'image' && urlDrop.placed, JSON.stringify(urlDrop))

// ---- 7. Ctrl+V pastes an image from the OS clipboard ------------------------
// (photos can't be dragged out of Telegram Desktop at all — paste is the
// supported route; xclip stands in for «Копировать изображение»)
try {
  // xclip forks a daemon holding the selection — its inherited stdio must be
  // redirected or execFileSync waits for pipe EOF forever
  execFileSync('bash', ['-c',
    'DISPLAY=${DISPLAY:-:0} xclip -selection clipboard -t image/png ' +
    '-i /tmp/kadr-test/img.png >/dev/null 2>&1'])
  const pasted = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    const before = st().project.assets.length
    st().setPlayhead(30)
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyV', ctrlKey: true, bubbles: true }))
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 400))
      const p = st().project
      const a = p.assets.find(x => x.name.endsWith('clipboard.png'))
      if (a) {
        const clip = p.tracks.flatMap(t => t.clips).find(c => c.assetId === a.id)
        return { kind: a.kind, at: clip?.start ?? null, added: p.assets.length - before }
      }
    }
    return null
  })()`)
  check('Ctrl+V pastes a clipboard image at the playhead',
    !!pasted && pasted.kind === 'image' && Math.abs(pasted.at - 30) < 0.01,
    JSON.stringify(pasted))
} catch (err) {
  console.log('SKIP  clipboard paste check (xclip unavailable):', String(err).slice(0, 80))
}

ws.close()
console.log('e2e31 finished')
