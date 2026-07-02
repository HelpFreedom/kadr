// Test: project sanitizing — a script-written project with scalar Anim
// values (gain: 0.5 instead of {value: 0.5}) must load healed, play through
// the corrupt clip without freezing the playhead or throwing into WebAudio,
// and keep playing after a seek back (the old failure killed the session).
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { writeFileSync } from 'fs'

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
const exceptions = []
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

// media: a tone and a color clip
execFileSync('bash', ['-c',
  'mkdir -p /tmp/kadr-test/san && ' +
  'ffmpeg -v error -f lavfi -i "sine=frequency=330:duration=6" -y /tmp/kadr-test/san/tone.wav && ' +
  'ffmpeg -v error -f lavfi -i "color=c=blue:s=320x240:d=6:r=30" -c:v libx264 -pix_fmt yuv420p -y /tmp/kadr-test/san/blue.mp4'])

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
ws.on('message', (raw) => {
  try {
    const m = JSON.parse(raw)
    if (m.method === 'Runtime.exceptionThrown')
      exceptions.push((m.params.exceptionDetails.exception?.description || '').slice(0, 120))
  } catch { /* partial */ }
})

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
await send('Runtime.enable')

// a corrupt project the way a script would write it: scalar gains, a broken
// keyframe, a missing transform slot
const corrupt = {
  name: 'sanitize-test', width: 320, height: 240, fps: 30,
  tracks: [
    { id: 'tv', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [
      { id: 'cv', kind: 'media', assetId: 'av', start: 0, duration: 5, inPoint: 0, speed: 1,
        gain: 0.8, muted: true,
        transform: { x: 0.1, scale: { value: 'oops' } }, effects: undefined }
    ] },
    { id: 'ta', kind: 'audio', name: 'A1', muted: false, locked: false, gain: 1, clips: [
      { id: 'c1', kind: 'media', assetId: 'aa', start: 0, duration: 2, inPoint: 0, speed: 1,
        gain: { value: 1, keyframes: [{ time: 0, value: 1 }, { time: null, value: 0.5 }] },
        muted: false, transform: null, effects: [] },
      // the killer from the field: gain as a bare number
      { id: 'c2', kind: 'media', assetId: 'aa', start: 2, duration: 2.5, inPoint: 2, speed: 1,
        gain: 0.5, muted: false, transform: null, effects: [] }
    ] }
  ],
  assets: [
    { id: 'av', path: '/tmp/kadr-test/san/blue.mp4', name: 'blue.mp4', kind: 'video',
      duration: 6, width: 320, height: 240, fps: 30, hasAudio: false },
    { id: 'aa', path: '/tmp/kadr-test/san/tone.wav', name: 'tone.wav', kind: 'audio',
      duration: 6, width: 0, height: 0, fps: 30, hasAudio: true }
  ]
}
writeFileSync('/tmp/kadr-test/san/corrupt.kadr', JSON.stringify(corrupt))

const healed = await evalJs(`(async () => {
  const p = await window.kadr.readProject('/tmp/kadr-test/san/corrupt.kadr')
  window.kadrEditor.useEditor.getState().setProject(p, null)
  const q = window.kadrEditor.useEditor.getState().project
  const cv = q.tracks[0].clips[0]
  const c1 = q.tracks[1].clips[0]
  const c2 = q.tracks[1].clips[1]
  return {
    c2gain: c2.gain, cvGain: cv.gain, cvX: cv.transform.x, cvScale: cv.transform.scale,
    cvOpacity: cv.transform.opacity, kfs: c1.gain.keyframes?.length ?? 0, fx: Array.isArray(cv.effects)
  }
})()`)
check('scalar gain healed to Anim', healed.c2gain?.value === 0.5 && healed.cvGain?.value === 0.8,
  JSON.stringify({ c2: healed.c2gain, cv: healed.cvGain }))
check('transform healed (scalar x, junk scale, missing slots)',
  healed.cvX?.value === 0.1 && Number.isFinite(healed.cvScale?.value) &&
  healed.cvOpacity?.value === 1 && healed.fx === true,
  JSON.stringify({ x: healed.cvX, scale: healed.cvScale, o: healed.cvOpacity }))
check('broken keyframe dropped', healed.kfs === 1, `kfs=${healed.kfs}`)

// play across the c1→c2 joint (t=2, where the old bug froze the session)
await evalJs(`(async () => {
  const s = window.kadrEditor.useEditor.getState()
  s.setPlayhead(1.5)
  await new Promise(r => setTimeout(r, 800))
  s.setPlaying(true)
  return true
})()`)
const samples = []
for (let i = 0; i < 8; i++) {
  await new Promise((r) => setTimeout(r, 400))
  samples.push(await evalJs('(async () => window.kadrEditor.useEditor.getState().playhead)()'))
}
await evalJs('(async () => { window.kadrEditor.useEditor.getState().setPlaying(false); return 1 })()')
const advanced = samples[samples.length - 1] - samples[0]
check('playback flows through the once-fatal joint', samples[samples.length - 1] > 2.4 && advanced > 1.5,
  samples.map((v) => v.toFixed(2)).join(' '))

// seek back and play again — the session must still be alive
await evalJs(`(async () => {
  const s = window.kadrEditor.useEditor.getState()
  s.setPlayhead(0.2)
  await new Promise(r => setTimeout(r, 500))
  s.setPlaying(true)
  return true
})()`)
await new Promise((r) => setTimeout(r, 1200))
const after = await evalJs('(async () => window.kadrEditor.useEditor.getState().playhead)()')
await evalJs('(async () => { window.kadrEditor.useEditor.getState().setPlaying(false); return 1 })()')
check('session still plays after seeking back', after > 0.5, `playhead=${after.toFixed(2)}`)

const fatal = exceptions.filter((e) => e.includes('non-finite') || e.includes('AudioParam'))
check('no WebAudio exceptions', fatal.length === 0, fatal.join(' | '))

ws.close()
console.log('e2e29 finished')
