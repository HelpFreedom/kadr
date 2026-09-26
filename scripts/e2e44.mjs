// Test: music beats as snap-able markers, the sound under a fragment baked into
// it, and the bundled sound library — the three things taken over from /brag.
//
//   1. the library: 260 effects (228 with /brag's analysis), 5 music beds, and
//      the search orders gentlest first and «без резких» drops the sharp ones
//   2. a library track lands on the timeline WITH its beats, and those beats are
//      librosa's: compared with resources/music/cues (librosa 0.11 at 44.1 kHz)
//      — here through the whole WYSIWYG path, mixdown included
//   3. beats are snap targets (and stop being when the magnet is off); a new
//      grid replaces the old beats and never the user's own markers
//   4. a sound effect goes on a FREE audio track — never over the music — and
//      one undo takes exactly it back
//   5. a fragment hears the music: audio.json has one value per composition
//      frame and the beats in composition seconds; moving the clip makes the
//      bake stale and refreshStaleBakes() makes it fresh again; a composition
//      that imports ./audio really renders through Remotion
//   6. the two dialogs open from their toolbar buttons and show what they should
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
// Needs no media: it uses the bundled library. It REFUSES to run over an open
// project that has clips (it replaces the project), restores the snap setting,
// deletes the fragment it creates and the render it makes.
import WebSocket from 'ws'
import { readFileSync, existsSync, unlinkSync, mkdirSync, copyFileSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const PORT = process.env.KADR_CDP_PORT || 9777
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const TRACK = 'happy-beats-business-moves-vol-10-by-ende-dot-app.mp3'
const CUES = join(root, 'resources', 'music', 'cues', TRACK.replace(/\.mp3$/, '.music-cues.json'))

async function targets() {
  for (let i = 0; i < 30; i++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
    } catch { await new Promise((r) => setTimeout(r, 1000)) }
  }
  throw new Error('CDP not answering')
}

function connect(url) {
  const sock = new WebSocket(url)
  let id = 0
  const ready = new Promise((res, rej) => { sock.on('open', res); sock.on('error', rej) })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const msgId = ++id
    const onMsg = (raw) => {
      const msg = JSON.parse(raw)
      if (msg.id !== msgId) return
      sock.off('message', onMsg)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
    }
    sock.on('message', onMsg)
    sock.send(JSON.stringify({ id: msgId, method, params }))
  })
  const rawEval = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) {
      throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
    }
    return r.result.value
  }
  // async evals park their result in a global and are polled (awaitPromise is flaky under GC)
  const evalJs = async (expression, { timeout = 90000 } = {}) => {
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
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  return { sock, ready, rawEval, evalJs }
}

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const page = (await targets()).find((x) => x.type === 'page' && x.url.includes('localhost'))
if (!page) throw new Error('editor page not found')
const { ready, rawEval, evalJs, sock } = connect(page.webSocketDebuggerUrl)
await ready

const clipsOpen = await rawEval(`window.kadrEditor.useEditor.getState().project.tracks.reduce((n, t) => n + t.clips.length, 0)`)
if (clipsOpen > 0 && !process.env.KADR_E2E_FORCE) {
  console.log(`SKIP  e2e44 replaces the open project, and it has ${clipsOpen} clip(s) — save it and open an empty project (or set KADR_E2E_FORCE=1)`)
  process.exit(0)
}

const savedSnap = await rawEval(`localStorage.getItem('kadr.snapBeats')`)
let fragmentId = null
let renderPath = null

try {
  await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().setProject({ ...st().project, name: 'e2e44', tracks: [], assets: [], markers: [], texts: [] }, null)
    st().addTrack('video')
    st().addTrack('audio')
    st().setPlayhead(0)
    E.useSettings.getState().setSnapBeats(true)
    return 1
  })()`)

  // ---- 1. the library -------------------------------------------------------
  const lib = await evalJs(`(async () => {
    const E = window.kadrEditor
    const L = await E.loadSoundLibrary()
    const soft = E.findSfx(L.sfx, { soft: true })
    const all = E.findSfx(L.sfx, {})
    const rank = { low: 0, medium: 1, high: 2 }
    let ordered = true
    for (let i = 1; i < all.length; i++)
      if (rank[all[i].hfRisk || 'medium'] < rank[all[i - 1].hfRisk || 'medium']) ordered = false
    const bundled = L.sfx.filter((s) => s.origin === 'bundled')
    return {
      sfx: bundled.length, analysed: bundled.filter((s) => s.labelledBy === 'brag').length, music: L.music.length,
      all: L.sfx.length, keyboardLabelled: bundled.filter((s) => s.family === 'keyboard' && s.hfRisk).length,
      hits: bundled.filter((s) => s.hit > 0.05).length,
      soft: soft.length, softHasHigh: soft.some((s) => s.hfRisk === 'high'), high: L.sfx.filter((s) => s.hfRisk === 'high').length,
      ordered, first: all[0].hfRisk,
      typing: E.findSfx(L.sfx, { use: 'typing' }).filter((s) => s.origin === 'bundled').length,
      reveal: E.findSfx(L.sfx, { use: 'major reveal', limit: 3 }).map((s) => s.id)
    }
  })()`)
  check('library: 260 bundled effects, 228 labelled by /brag, 5 music beds',
    lib.sfx === 260 && lib.analysed === 228 && lib.music === 5, `${lib.sfx}/${lib.analysed}/${lib.music}`)
  check('the 32 keypresses /brag skipped are labelled by Kadr', lib.keyboardLabelled === 32)
  check('bundled sounds carry their hit time (dozens land later than 50 ms)', lib.hits > 50, `${lib.hits}`)
  check('search: gentlest first (hfRisk never goes back down the list)', lib.ordered && lib.first === 'low')
  check('«без резких» drops exactly the high-risk ones', !lib.softHasHigh && lib.soft === lib.all - lib.high,
    `${lib.soft} = ${lib.all} − ${lib.high}`)
  check('the bundled keyboard set answers to "typing"', lib.typing === 32, String(lib.typing))
  check('"major reveal" finds the soft impacts first', lib.reveal.length === 3 && lib.reveal.every((id) => id.startsWith('impact/')),
    lib.reveal.join(', '))

  // ---- 2. music with its beats ------------------------------------------------
  const music = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const r = await E.addSound(${JSON.stringify(TRACK)}, { at: 0 })
    const p = st().project
    const tr = p.tracks.find((t) => t.id === r.trackId)
    return { r, trackKind: tr.kind, clipStart: tr.clips.find((c) => c.id === r.clipId).start,
      beats: E.beatTimes(p), strong: E.beatTimes(p, { strongOnly: true }).length }
  })()`, { timeout: 120000 })
  check('music lands on an audio track at the playhead', music.trackKind === 'audio' && music.clipStart === 0)
  check('…with its beats marked in the same step', music.r.beatMarkers > 50 && music.beats.length === music.r.beatMarkers,
    `${music.r.beatMarkers} markers`)
  const cues = JSON.parse(readFileSync(CUES, 'utf8'))
  check('tempo equals librosa\'s', Math.abs(music.r.tempo - cues.tempo) < 0.05, `${music.r.tempo} vs ${cues.tempo}`)
  const ref = cues.beats.map((b) => b.time)
  const near = (xs, ys, tol) => xs.filter((x) => ys.some((y) => Math.abs(x - y) <= tol)).length / Math.max(1, xs.length)
  const recall = near(ref, music.beats, 0.025)
  const precision = near(music.beats, ref, 0.025)
  // mixdown at 48 kHz → 44.1 kHz for the analysis vs librosa's own mp3 decode:
  // a different resampling chain, so allow a handful of beats to differ
  check('beats match librosa within 25 ms (through the export mixdown)', recall >= 0.95 && precision >= 0.95,
    `recall ${(recall * 100).toFixed(1)} %, precision ${(precision * 100).toFixed(1)} %`)
  const errs = ref.map((r) => Math.min(...music.beats.map((b) => Math.abs(b - r)))).filter((d) => d <= 0.025).sort((a, b) => a - b)
  check('median beat offset vs librosa under 1 ms', errs[errs.length >> 1] < 0.001, `${(errs[errs.length >> 1] * 1000).toFixed(2)} ms`)
  check('some beats are accents, not all', music.strong > 0 && music.strong < music.beats.length, `${music.strong}`)

  // ---- 3. snapping, and a new grid replacing the old beats --------------------
  const snap = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const snapPoints = E.snapPoints
    const beats = E.beatTimes(st().project)
    const userId = st().addMarker(12.345)
    const on = snapPoints(st().project, '', 0)
    E.useSettings.getState().setSnapBeats(false)
    const off = snapPoints(st().project, '', 0)
    E.useSettings.getState().setSnapBeats(true)
    const self = snapPoints(st().project, userId, 0)
    const before = beats.length
    const bar = await E.detectBeats({ clipIds: [st().project.tracks.find((t) => t.kind === 'audio').clips[0].id], grid: 'bar' })
    const after = E.beatTimes(st().project)
    const user = (st().project.markers || []).filter((m) => m.kind !== 'beat')
    return {
      beatsInOn: beats.every((b) => on.includes(b)), beatsInOff: beats.some((b) => off.includes(b)),
      userInOff: off.includes(12.345), selfExcluded: !self.includes(12.345),
      before, after: after.length, placed: bar.placed, user: user.map((m) => [m.time, m.label])
    }
  })()`, { timeout: 120000 })
  check('every beat is a snap target', snap.beatsInOn)
  check('the magnet off takes the beats out — and only them', !snap.beatsInOff && snap.userInOff)
  check('a dragged marker does not snap to its own old place', snap.selfExcluded)
  check('a "bar" grid REPLACES the beats (about a quarter remain)',
    snap.after === snap.placed && Math.abs(snap.after - snap.before / 4) <= 2, `${snap.before} → ${snap.after}`)
  check('the user\'s own marker survives the re-detection', snap.user.length === 1 && snap.user[0][0] === 12.345 && snap.user[0][1] === '1',
    JSON.stringify(snap.user))

  // ---- 4. a sound effect never lands on top of the music ---------------------
  const sfx = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const musicTrack = st().project.tracks.find((t) => t.kind === 'audio').id
    const a = await E.addSound('impact/impactSoft_medium_001.ogg', { at: 5, gain: 0.7 })
    const b = await E.addSound('impact/impactSoft_medium_002.ogg', { at: 5.05 })
    const c = await E.addSound('interface/click_003.ogg', { at: 20 })
    const p = st().project
    const audio = p.tracks.filter((t) => t.kind === 'audio')
    let overlap = false
    for (const t of audio) for (const x of t.clips) for (const y of t.clips)
      if (x !== y && x.start < y.start + y.duration && y.start < x.start + x.duration) overlap = true
    const clipA = p.tracks.flatMap((t) => t.clips).find((x) => x.id === a.clipId)
    const nClips = p.tracks.reduce((n, t) => n + t.clips.length, 0)
    st().undo()
    const q = st().project
    return {
      tracks: [a.trackId, b.trackId, c.trackId].map((id) => audio.findIndex((t) => t.id === id)),
      musicTrackIdx: audio.findIndex((t) => t.id === musicTrack), audioTracks: audio.length, overlap,
      gain: clipA.gain.value, label: clipA.label,
      undone: q.tracks.reduce((n, t) => n + t.clips.length, 0) === nClips - 1 &&
        !q.tracks.some((t) => t.clips.some((x) => x.id === c.clipId)) &&
        q.tracks.some((t) => t.clips.some((x) => x.id === b.clipId))
    }
  })()`)
  check('no two clips overlap on any audio track', !sfx.overlap)
  check('the first effect gets a NEW track (the music track is busy)', sfx.tracks[0] !== sfx.musicTrackIdx && sfx.tracks[0] >= 0,
    JSON.stringify(sfx.tracks))
  check('an effect overlapping the first one gets yet another track', sfx.tracks[1] !== sfx.tracks[0] && sfx.tracks[1] !== sfx.musicTrackIdx)
  check('a later effect reuses a track that is free by then', sfx.tracks[2] === sfx.tracks[0], JSON.stringify(sfx.tracks))
  check('gain and label as asked', sfx.gain === 0.7 && sfx.label === 'impactSoft_medium_001', `${sfx.gain} ${sfx.label}`)
  check('one undo takes back exactly the last effect', sfx.undone)

  // ---- 4b. the HIT lands on the time asked for; the user's own folder ---------
  const hit = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const L = await E.loadSoundLibrary()
    const fan = L.sfx.find((s) => s.id === 'casino/card-fan-2.ogg')
    const a = await E.addSound('casino/card-fan-2.ogg', { at: 30 })
    const b = await E.addSound('casino/card-fan-2.ogg', { at: 40, alignHit: false })
    const c = await E.addSound('casino/card-fan-2.ogg', { at: 0.2 })
    const clip = (id) => st().project.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
    return { hit: fan.hit, a: [a.start, a.hitAt, clip(a.clipId).start], b: [b.start, b.hitAt], c: [c.start, c.hitAt] }
  })()`)
  check('an effect\'s HIT lands on `at` (the clip starts hit seconds earlier)',
    hit.hit > 0.9 && Math.abs(hit.a[1] - 30) < 1e-9 && Math.abs(hit.a[2] - (30 - hit.hit)) < 1e-9, JSON.stringify(hit))
  check('alignHit:false starts the file at `at`', hit.b[0] === 40)
  check('a lead-in that would start before 0 is clamped, and says where the hit really is',
    hit.c[0] === 0 && Math.abs(hit.c[1] - hit.hit) < 1e-9, JSON.stringify(hit.c))

  // a family of the test's own in the user folder — never the user's files
  const USERDIR = join(process.env.HOME, '.config', 'kadr', 'sfx', 'e2e44-tmp')
  mkdirSync(USERDIR, { recursive: true })
  copyFileSync(join(root, 'resources', 'sfx', 'impact', 'impactSoft_medium_001.ogg'), join(USERDIR, 'thump.ogg'))
  copyFileSync(join(root, 'resources', 'sfx', 'keyboard', 'keypress-001.wav'), join(USERDIR, 'key.wav'))
  try {
    const user = await evalJs(`(async () => {
      const E = window.kadrEditor
      const L = await E.loadSoundLibrary(true)
      const mine = L.sfx.filter((s) => s.family === 'e2e44-tmp')
      const thump = mine.find((s) => s.id === 'user:e2e44-tmp/thump.ogg')
      const bundled = L.sfx.find((s) => s.id === 'impact/impactSoft_medium_001.ogg')
      const described = await E.setSoundMeta('user:e2e44-tmp/thump.ogg', { uses: ['major reveal', 'major reveal', ' Logo Payoff '], note: 'тест' })
      const again = (await E.loadSoundLibrary(true)).sfx.find((s) => s.id === 'user:e2e44-tmp/thump.ogg')
      let refused = ''
      try { await E.setSoundMeta('impact/impactSoft_medium_001.ogg', { note: 'x' }) } catch (e) { refused = String(e.message || e) }
      const found = E.findSfx(L.sfx, { family: 'e2e44-tmp' }).length
      return { n: mine.length, origin: thump && thump.origin, by: thump && thump.labelledBy,
        same: thump && bundled && thump.brightness === bundled.brightness && thump.hfRisk === bundled.hfRisk,
        uses: described.uses, note: again.note, againUses: again.uses, refused, found,
        families: E.sfxFamilies(L.sfx).slice(-3) }
    })()`, { timeout: 120000 })
    check('a new file in the user folder is found and labelled by Kadr', user.n === 2 && user.origin === 'user' && user.by === 'kadr',
      `${user.n} ${user.origin} ${user.by}`)
    check('…the same way as its bundled twin', user.same)
    check('…and its folder becomes a family', user.found === 2 && user.families.includes('e2e44-tmp'))
    check('uses are de-duplicated and normalised', JSON.stringify(user.uses) === JSON.stringify(['major reveal', 'logo payoff']),
      JSON.stringify(user.uses))
    check('the description survives a rescan', user.note === 'тест' && user.againUses.length === 2)
    check('a bundled sound cannot be re-described', /only the user/.test(user.refused), user.refused)
  } finally {
    rmSync(USERDIR, { recursive: true, force: true })
    await evalJs(`window.kadrEditor.loadSoundLibrary(true).then(() => 1)`, { timeout: 120000 })
  }

  // ---- 5. a fragment that hears the music ------------------------------------
  const frag = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const f = await E.createFragment({ name: 'e2e44-react', start: 2, end: 6, transparent: true })
    const b = await E.bakeAudio(f.clipId)
    const clip = st().project.tracks.flatMap((t) => t.clips).find((c) => c.id === f.clipId)
    const json = JSON.parse(await window.kadr.readTextFile(b.files[0]))
    const ts = await window.kadr.readTextFile(b.files[1])
    const fresh = E.bakeState(st().project, clip)
    st().pushHistory('hMove')
    st().updateClip(f.clipId, { start: 3 })
    const moved = st().project.tracks.flatMap((t) => t.clips).find((c) => c.id === f.clipId)
    const stale = E.bakeState(st().project, moved)
    const n = await E.refreshStaleBakes(st().project)
    const again = st().project.tracks.flatMap((t) => t.clips).find((c) => c.id === f.clipId)
    const json2 = JSON.parse(await window.kadr.readTextFile(b.files[0]))
    return {
      id: f.id, entry: f.entry, clipId: f.clipId, frames: f.meta.durationInFrames, fps: f.meta.fps,
      json: { frames: json.frames, level: json.level.length, bass: json.bass.length,
        maxLevel: Math.max(...json.level), beats: json.beats.map((x) => x[0]), bpm: json.bpm,
        timeline: json.timeline },
      tsHasHook: ts.includes('export function useAudio') && ts.includes("import data from './audio.json'"),
      fresh, stale, refreshed: n, after: E.bakeState(st().project, again), timeline2: json2.timeline,
      beats2: json2.beats.map((x) => x[0])
    }
  })()`, { timeout: 180000 })
  fragmentId = frag.id
  check('audio.json: one value per composition frame for every band',
    frag.json.frames === frag.frames && frag.json.level === frag.frames && frag.json.bass === frag.frames,
    `${frag.json.level}/${frag.frames}`)
  check('…and the music is in it', frag.json.maxLevel > 0.3 && frag.json.bpm > 100, `max ${frag.json.maxLevel}, ${frag.json.bpm} BPM`)
  // Reference: librosa's own beats of this track. The music starts at 0, so its
  // source seconds ARE timeline seconds. (The timeline's beat markers are no use
  // here — step 3 left only the every-4th grid on it.)
  const refIn = (a, b) => ref.filter((t) => t >= a && t <= b)
  const ref26 = refIn(2, 6)
  const onGrid = frag.json.beats.filter((b) => ref26.some((t) => Math.abs(t - 2 - b) < 0.03)).length
  check('beats in COMPOSITION seconds = librosa\'s beats − clip start',
    onGrid === frag.json.beats.length && frag.json.beats.length === ref26.length,
    `${onGrid}/${frag.json.beats.length} on the grid, librosa has ${ref26.length}`)
  check('audio.ts is the reader (useAudio, imports audio.json)', frag.tsHasHook)
  check('fresh after baking, STALE after moving the clip', frag.fresh === 'fresh' && frag.stale === 'stale')
  check('refreshStaleBakes() re-bakes it for the new place', frag.refreshed === 1 && frag.after === 'fresh' &&
    frag.timeline2.start === 3, JSON.stringify(frag.timeline2))
  // after the move composition second 0 is timeline 3
  const ref37 = refIn(3, 7)
  const onGrid2 = frag.beats2.filter((b) => ref37.some((t) => Math.abs(t - 3 - b) < 0.03)).length
  check('…and the beats moved with it', onGrid2 === frag.beats2.length && frag.beats2.length === ref37.length,
    `${onGrid2}/${frag.beats2.length} on the new grid, librosa has ${ref37.length}`)

  // a composition that really uses the reader must go through Remotion's bundler
  const tsx = `import React from 'react'
import { AbsoluteFill } from 'remotion'
import meta from './meta.json'
import { useAudio, beats } from './audio'

const Comp: React.FC = () => {
  const a = useAudio()
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ width: 200 + 200 * a.bass, height: 200, background: 'rgb(255,0,255)', opacity: 0.4 + 0.6 * a.beat }} />
      <div style={{ position: 'absolute', bottom: 20, color: 'white', fontSize: 40 }}>{beats.length}</div>
    </AbsoluteFill>
  )
}
export const fragment = { component: Comp, meta }
`
  const render = await evalJs(`(async () => {
    await window.kadr.writeTextFile(${JSON.stringify(frag.entry)}, ${JSON.stringify(tsx)})
    const r = await window.kadr.fragmentRender(${JSON.stringify(frag.id)}, { transparent: true })
    const { asset } = await window.kadr.probeMedia(r.path)
    return { path: r.path, duration: asset.duration, w: asset.width, h: asset.height }
  })()`, { timeout: 600000 })
  renderPath = render.path
  check('a composition importing ./audio renders through Remotion', render.duration > 3.5 && render.w > 0,
    `${render.duration.toFixed(2)} s ${render.w}×${render.h}`)

  // ---- 6. the dialogs ---------------------------------------------------------
  const ui = await evalJs(`(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms))
    document.querySelector('[data-act="sounds"]').click()
    await wait(100)
    // the dialog remembers its tab and filters between openings (that is for the
    // user) — so put them in a known state instead of assuming a fresh one
    document.querySelector('[data-act="sounds-tab-sfx"]').click()
    for (let i = 0; i < 50 && !document.querySelector('[data-sounds-list] .snd-row'); i++) await wait(100)
    const softBox = [...document.querySelectorAll('.sounds-dialog label')]
      .find((l) => l.textContent.includes('${'Без резких'}') || l.textContent.includes('No sharp')).querySelector('input')
    if (softBox.checked) { softBox.click(); await wait(200) }
    const rows = document.querySelectorAll('[data-sounds-list] .snd-row').length
    softBox.click()
    await wait(200)
    const softRows = document.querySelectorAll('[data-sounds-list] .snd-row').length
    softBox.click() // leave it as a fresh dialog has it
    document.querySelector('[data-act="sounds-tab-music"]').click()
    await wait(200)
    const musicRows = document.querySelectorAll('.sounds-dialog .snd-row.music').length
    const bpm = document.querySelector('.sounds-dialog .snd-row.music .snd-tag')?.textContent
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    document.querySelector('.sounds-dialog')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(200)
    const soundsClosed = !document.querySelector('.sounds-dialog')
    document.querySelector('[data-act="beats"]').click()
    await wait(200)
    const radios = document.querySelectorAll('input[name="beats-source"]').length
    const grids = document.querySelectorAll('input[name="beats-grid"]').length
    const snapBtn = !!document.querySelector('[data-act="beat-snap"][aria-pressed="true"]')
    const lines = document.querySelectorAll('.tl-beat').length
    const flags = document.querySelectorAll('.tl-marker-flag').length
    document.querySelector('.modal [data-act="beats-run"]')?.closest('.modal')
      ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await wait(200)
    return { rows, softRows, musicRows, bpm, soundsClosed, radios, grids, snapBtn, lines, flags,
      beatsClosed: !document.querySelector('input[name="beats-source"]') }
  })()`)
  check('«Звуки» lists every effect, the user\'s own included', ui.rows === lib.all, `${ui.rows} of ${lib.all}`)
  check('…«Без резких» narrows it to the soft ones', ui.softRows === lib.soft, `${ui.softRows}`)
  check('…the music tab shows 5 beds with their tempo', ui.musicRows === 5 && /BPM/.test(ui.bpm || ''), ui.bpm)
  check('…and Escape closes it', ui.soundsClosed)
  check('«Биты» dialog: sources and the four grids', ui.radios >= 2 && ui.grids === 4, `${ui.radios} sources`)
  check('the beat magnet is shown, pressed', ui.snapBtn)
  check('beats are drawn as lines, the user marker as the only flag', ui.lines > 0 && ui.flags === 1, `${ui.lines} lines, ${ui.flags} flag`)
  check('…and Escape closes the beats dialog', ui.beatsClosed)
} catch (err) {
  check('suite ran to the end', false, String(err?.message || err))
} finally {
  // put everything back
  try {
    await evalJs(`(async () => {
      const E = window.kadrEditor
      if (${JSON.stringify(fragmentId)}) await E.deleteFragment(${JSON.stringify(fragmentId)})
      const st = E.useEditor.getState()
      st.setProject({ ...st.project, name: 'Untitled', tracks: [], assets: [], markers: [], texts: [] }, null)
      E.useSoundsUi.getState().setOpen(false)
      E.useBeatsUi.getState().setOpen(false)
      return 1
    })()`)
    await rawEval(savedSnap === null ? `localStorage.removeItem('kadr.snapBeats')` : `localStorage.setItem('kadr.snapBeats', ${JSON.stringify(savedSnap)})`)
    await rawEval(`window.kadrEditor.useSettings.setState({ snapBeats: localStorage.getItem('kadr.snapBeats') !== '0' })`)
    if (renderPath && existsSync(renderPath)) unlinkSync(renderPath)
  } catch (e) {
    console.log('WARN  cleanup:', e.message)
  }
  sock.close()
}
