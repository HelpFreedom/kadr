// Test: audio defects of a voice-over (stage 2 — marks, regions, verdicts).
//
// Deliberately runs on a FAKE defect list instead of the real detector: the
// detector needs a GPU and minutes, and none of what is checked here depends on
// it. The detector itself is covered by scripts/check-phrases.py (phrase maths
// on synthetic audio) and by running it over a real voice-over by hand.
//
// Launch the app with `npx electron-vite dev -- --remote-debugging-port=9777`.
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'

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
  if (r.exceptionDetails) {
    throw new Error('JS exception: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text))
  }
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

// a project with `tracks` audio tracks, each holding one clip of the same
// voice-over asset, plus three defects on it
const BUILD = (tracks) => `(() => {
  const E = window.kadrEditor, st = () => E.useEditor.getState()
  const assetId = 'A1', runId = 'R1'
  const mkTrack = (i) => ({ id: 'T' + i, kind: 'audio', name: 'A' + i,
    muted: false, locked: false, gain: 1, clips: [] })
  const project = { ...st().project, width: 640, height: 360, fps: 30,
    tracks: Array.from({ length: ${tracks} }, (_, i) => mkTrack(i)),
    assets: [{ id: assetId, name: 'voice.wav', path: '/tmp/voice.wav', kind: 'audio',
      duration: 30, width: 0, height: 0, fps: 30, hasAudio: true }],
    texts: [], defects: [],
    voiceRuns: [{ id: runId, assetId, scriptPath: '/tmp/voice.script.txt', scriptHash: '',
      runDir: '${RUN}', duration: 30, tempo: 1.1, createdAt: Date.now() }] }
  st().setProject(project, null)
  const p = st().project
  p.tracks.forEach((tr, i) => tr.clips.push({ id: 'C' + i, assetId, kind: 'media',
    start: 0, duration: 30, inPoint: 0, label: 'voice', ...E.newClipDefaults() }))
  const mk = (i) => ({ id: 'd' + i, runId, assetId, origin: 'detector', cls: 'insert',
    confidence: 0.5 + i / 10, words: [i * 3, i * 3 + 2],
    play: [i * 8, i * 8 + 7], src: [i * 8 + 2, i * 8 + 3], state: 'proposed',
    phrase: { t0: i * 8 + 1, t1: i * 8 + 6, sentFrom: i, sentTo: i, wordFrom: i * 3,
      wordTo: i * 3 + 3, charFrom: 0, charTo: 10, text: 'фраза ' + i,
      cut: ['silence', 'silence'] } })
  st().applyCheckResult(runId, {}, [mk(0), mk(1), mk(2)])
  return { tracks: st().project.tracks.length, defects: st().project.defects.length }
})()`

// каталог разбора для ручных отметок: phrase-at считает фразу по нему и по
// копии звука, без моделей — значит подделать его можно целиком
const RUN = '/tmp/kadr-test/fakerun'
rmSync(RUN, { recursive: true, force: true })
mkdirSync(RUN, { recursive: true })
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi',
  '-i', 'sine=frequency=300:duration=30:sample_rate=48000', '-c:a', 'pcm_s16le', `${RUN}/voice.wav`])
{
  // пять «предложений» по три слова, между ними паузы — как у настоящего разбора
  const sents = []
  const wordTimes = {}
  const charRanges = []
  let t = 0.5
  let ch = 0
  for (let sn = 0; sn < 5; sn++) {
    for (let w = 0; w < 3; w++) {
      const i = sents.length
      sents.push(sn)
      wordTimes[i] = [Number(t.toFixed(3)), Number((t + 0.5).toFixed(3))]
      charRanges.push([ch, ch + 5])
      ch += 6
      t += w < 2 ? 0.7 : 1.2
    }
  }
  writeFileSync(`${RUN}/phrase-index.json`, JSON.stringify({
    duration: 30, audio: `${RUN}/voice.wav`, sents, charRanges, wordTimes, speechP: []
  }))
  writeFileSync(`${RUN}/script.txt`, 'слово '.repeat(15).trim())
  writeFileSync(`${RUN}/defects.json`, JSON.stringify({
    audio: `${RUN}/voice.wav`, script: `${RUN}/script.txt`, duration: 30, trust: 1,
    stats: {}, defects: [], suppressed: [], text_mismatches: []
  }))
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// «Скрыть отметки» живёт в localStorage и переживает перезапуск. Прерванный
// прогон однажды оставил его включённым — и весь набор потом падал на «полос
// нет», потому что их и правда не было. Снимаем на входе, возвращаем в finally.
const savedHidden = await evalJs(`(() => {
  const was = window.kadrEditor.useVoiceUi.getState().hidden
  window.kadrEditor.setDefectsHidden(false)
  return was
})()`)

try {
  // ---- 1. drawing: inside the lane, and visibly not a marker or a range
  const built = await evalJs(BUILD(4))
  await evalJs(`(async () => { window.kadrEditor.useEditor.getState().setZoom(20)
    await new Promise((r) => setTimeout(r, 400)); return 1 })()`)
  check('the fixture built', built.tracks === 4 && built.defects === 3, JSON.stringify(built))

  const dom = await evalJs(`(() => {
    const bands = [...document.querySelectorAll('.adefect')]
    const flags = [...document.querySelectorAll('.adefect-flag')]
    const edges = [...document.querySelectorAll('.adefect-edge')]
    const cs = bands[0] && getComputedStyle(bands[0])
    // every band must sit inside the lane of its own track — the classic bug
    // here is a few pixels of drift per row from a forgotten border
    let outside = 0, laneless = 0
    for (const b of bands) {
      const lane = b.closest('.lane')
      if (!lane) { laneless++; continue }
      const lr = lane.getBoundingClientRect(), br = b.getBoundingClientRect()
      if (br.top < lr.top - 0.5 || br.bottom > lr.bottom + 0.5) outside++
    }
    return { bands: bands.length, flags: flags.length, edges: edges.length,
             outside, laneless,
             pointer: cs && cs.pointerEvents, flagPointer: flags[0] && getComputedStyle(flags[0]).pointerEvents,
             markers: document.querySelectorAll('.tl-marker').length,
             ranges: document.querySelectorAll('.range-overlay').length }
  })()`)
  check('one band, one flag and four edge handles per visible defect',
        dom.bands === 12 && dom.flags === 12 && dom.edges === 48,
        `${dom.bands}/${dom.flags}/${dom.edges}`)
  check('every band stays inside its own track lane',
        dom.outside === 0 && dom.laneless === 0, `вне дорожки: ${dom.outside}, без дорожки: ${dom.laneless}`)
  check('bands are pointer-transparent so the clip stays draggable',
        dom.pointer === 'none' && dom.flagPointer === 'auto',
        `${dom.pointer} / ${dom.flagPointer}`)
  check('they are neither markers nor the range', dom.markers === 0 && dom.ranges === 0)

  // ---- 2. the same audio used twice draws twice, a trimmed-away part not at all
  const twice = await evalJs(`(() => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const placed = E.placeDefects(st().project)
    // clip 'C0' trimmed to the first 5 s hides defects 1 and 2 entirely
    st().updateClip('C0', { duration: 5 })
    const after = E.placeDefects(st().project)
    return { before: placed.length, onC0: after.filter((p) => p.clipId === 'C0').length,
             total: after.length }
  })()`)
  check('a defect draws once per clip that shows it', twice.before === 12, String(twice.before))
  check('trimming a clip hides the defects it no longer covers',
        twice.onC0 === 1 && twice.total === 10, JSON.stringify(twice))

  // ---- 3. speed and inPoint are honoured by the mapping
  const mapped = await evalJs(`(() => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().updateClip('C1', { speed: 2, inPoint: 4, start: 10, duration: 13 })
    const p = E.placeDefects(st().project).find((x) => x.clipId === 'C1' && x.defect.id === 'd1')
    // source 10..11 s at speed 2 from inPoint 4 → timeline 10 + (10-4)/2 = 13
    return p ? { start: p.src.start, end: p.src.end } : null
  })()`)
  check('source→timeline honours speed and inPoint',
        mapped && Math.abs(mapped.start - 13) < 1e-6 && Math.abs(mapped.end - 13.5) < 1e-6,
        JSON.stringify(mapped))

  // ---- 4. verdicts by mouse
  await evalJs(BUILD(1))
  await evalJs(`(async () => { await new Promise((r) => setTimeout(r, 300)); return 1 })()`)
  const verdicts = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    const states = () => { const s = {}
      for (const d of st().project.defects) s[d.state] = (s[d.state]||0)+1
      return s }
    const flags = () => [...document.querySelectorAll('.adefect-flag')]
    const bands = () => document.querySelectorAll('.adefect').length
    const settle = () => new Promise((r) => setTimeout(r, 250))
    const out = { flagsAtStart: flags().length }

    // 1) ЛКМ — дефект
    flags()[0].click()
    await settle()
    out.afterLeft = states()
    out.confirmedClass = flags()[0].className

    // 2) ПКМ — не дефект: отметка и выделение уходят с таймлайна
    flags()[1].dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
    await settle()
    out.afterRight = states()
    out.flagsAfterReject = flags().length
    out.bandsAfterReject = bands()

    // 3) отмена возвращает именно отклонение (последнее действие)
    st().undo()
    await settle()
    out.flagsAfterUndo = flags().length
    out.afterUndo = states()

    // 4) Alt+клик снимает решение с первого
    flags()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true }))
    await settle()
    out.afterAlt = states()
    return out
  })()`)
  check('left click marks a defect', verdicts.afterLeft.confirmed === 1, JSON.stringify(verdicts.afterLeft))
  check('a confirmed defect is visibly marked as such',
        /confirmed/.test(verdicts.confirmedClass), verdicts.confirmedClass)
  check('right click marks "not a defect"', verdicts.afterRight.rejected === 1,
        JSON.stringify(verdicts.afterRight))
  // «не дефект» убирает отметку и выделение — так просил пользователь; сама
  // запись остаётся в проекте, она нужна как обучающий пример
  check('"not a defect" removes the mark and its region from the timeline',
        verdicts.flagsAfterReject === verdicts.flagsAtStart - 1 && verdicts.bandsAfterReject === 2,
        `${verdicts.flagsAtStart}→${verdicts.flagsAfterReject} флажков, ${verdicts.bandsAfterReject} полос`)
  check('undo brings the removed mark back',
        verdicts.flagsAfterUndo === verdicts.flagsAtStart && !verdicts.afterUndo.rejected,
        `${verdicts.flagsAfterUndo} флажков, ${JSON.stringify(verdicts.afterUndo)}`)
  check('alt+click takes the verdict back',
        verdicts.afterAlt.proposed === 3, JSON.stringify(verdicts.afterAlt))

  // ---- 5. undo/redo, one entry per decision (own fixture: chaining onto the
  //         previous block's history made this test read the wrong steps once)
  await evalJs(BUILD(1))
  const hist = await evalJs(`(() => {
    const st = () => window.kadrEditor.useEditor.getState()
    const states = () => { const s = {}
      for (const d of st().project.defects) s[d.state] = (s[d.state]||0)+1
      return s }
    window.kadrEditor.setVerdict('d0', true)
    window.kadrEditor.setVerdict('d1', false)
    const both = states()
    st().undo(); const u1 = states()
    st().undo(); const u2 = states()
    st().undo(); const u3 = states()
    st().redo(); const r1 = states()
    st().redo(); const r2 = states()
    return { both, u1, u2, u3, r1, r2 }
  })()`)
  check('two verdicts, two undo steps',
        hist.both.confirmed === 1 && hist.both.rejected === 1 &&
        hist.u1.rejected === undefined && hist.u1.confirmed === 1 &&
        hist.u2.proposed === 3,
        JSON.stringify([hist.both, hist.u1, hist.u2]))
  check('one more undo removes the whole check result',
        Object.keys(hist.u3).length === 0, JSON.stringify(hist.u3))
  check('redo restores the findings, then the verdict',
        hist.r1.proposed === 3 && hist.r2.confirmed === 1,
        JSON.stringify([hist.r1, hist.r2]))

  // ---- 6. dragging a phrase edge cannot break the invariant
  await evalJs(BUILD(1))
  const edge = await evalJs(`(() => {
    const st = () => window.kadrEditor.useEditor.getState()
    const before = st().project.defects[0]
    // try to drag the left edge PAST the defect it must contain
    st().updateDefect('d0', { phrase: { ...before.phrase, t0: before.src[0] + 5 } })
    const raw = st().project.defects[0].phrase.t0
    // the sanitizer is the backstop the drag handler relies on
    st().setProject(JSON.parse(JSON.stringify(st().project)), null)
    const healed = st().project.defects[0]
    return { raw, t0: healed.phrase.t0, src0: healed.src[0], t1: healed.phrase.t1, src1: healed.src[1] }
  })()`)
  check('a phrase that lost its defect is healed on load',
        edge.t0 <= edge.src0 && edge.t1 >= edge.src1, JSON.stringify(edge))

  // ---- 7. sanitizeProject heals the rest
  const healed = await evalJs(`(() => {
    const st = () => window.kadrEditor.useEditor.getState()
    const p = JSON.parse(JSON.stringify(st().project))
    p.defects[0].state = 'какая-то дичь'
    p.defects[0].origin = 42
    p.defects[1].phrase = null
    p.defects[2].assetId = 'нет такого ассета'
    p.defects.push({ id: 'ghost', runId: 'нет такого прогона', assetId: 'A1',
                     origin: 'detector', src: [1, 2], state: 'proposed',
                     phrase: { t0: 0, t1: 3, cut: ['silence','silence'] } })
    st().setProject(p, null)
    const d = st().project.defects
    return { count: d.length, state0: d[0] && d[0].state, origin0: d[0] && d[0].origin,
             cut1: d[1] && d[1].phrase.cut, note1: !!(d[1] && d[1].note) }
  })()`)
  check('an unknown state falls back to proposed', healed.state0 === 'proposed', healed.state0)
  check('a bad origin falls back to detector', healed.origin0 === 'detector', String(healed.origin0))
  check('a lost phrase degrades and says so',
        healed.cut1 && healed.cut1[0] === 'fallback' && healed.note1, JSON.stringify(healed.cut1))
  check('defects of a missing asset or run are dropped', healed.count === 2, String(healed.count))

  // ---- 8. deleting the media takes its voice-over with it
  await evalJs(BUILD(1))
  const swept = await evalJs(`(() => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().removeAssets(['A1'])
    const p = st().project
    return { defects: (p.defects||[]).length, runs: (p.voiceRuns||[]).length,
             clips: p.tracks.reduce((n, t) => n + t.clips.length, 0) }
  })()`)
  check('removing the asset sweeps its defects, run and clips',
        swept.defects === 0 && swept.runs === 0 && swept.clips === 0, JSON.stringify(swept))

  // ---- 8a. Ctrl+drag over a voice-over clip marks a span
  await evalJs(BUILD(1))
  await evalJs(`(async () => { window.kadrEditor.useEditor.getState().setZoom(20)
    await new Promise((r) => setTimeout(r, 300)); return 1 })()`)
  const dragged = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    const el = document.querySelector('.clip')
    const box = el.getBoundingClientRect()
    const before = st().project.defects.length
    const px = (t) => box.left + t * st().zoom
    const ev = (type, x, extra = {}) => el.dispatchEvent(new PointerEvent(type,
      { bubbles: true, cancelable: true, clientX: x, clientY: box.top + 10,
        button: 0, ctrlKey: true, ...extra }))
    ev('pointerdown', px(5))
    window.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, clientX: px(7), clientY: box.top + 10, ctrlKey: true }))
    await new Promise((r) => setTimeout(r, 60))
    const previewWidth = document.querySelector('.adefect.marking')?.getBoundingClientRect().width ?? 0
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: px(7) }))
    for (let i = 0; i < 60 && st().project.defects.length === before; i++) {
      await new Promise((r) => setTimeout(r, 250))
    }
    const d = st().project.defects[st().project.defects.length - 1]
    return { previewWidth, added: st().project.defects.length - before,
             origin: d && d.origin, cls: d && d.cls, src: d && d.src,
             phrase: d && [d.phrase.t0, d.phrase.t1],
             gone: !document.querySelector('.adefect.marking') }
  })()`, { timeout: 60000 })
  check('Ctrl+drag over the clip previews the span', dragged.previewWidth > 20,
        String(dragged.previewWidth))
  check('and on release it becomes a mark of the user',
        dragged.added === 1 && dragged.origin === 'user', JSON.stringify(dragged))
  check('the mark covers what was dragged',
        Math.abs(dragged.src[0] - 5) < 0.2 && Math.abs(dragged.src[1] - 7) < 0.2,
        JSON.stringify(dragged.src))
  check('and a phrase was picked up around it',
        dragged.phrase[0] <= dragged.src[0] && dragged.phrase[1] >= dragged.src[1],
        JSON.stringify(dragged.phrase))
  check('the preview disappears afterwards', dragged.gone === true)

  // Ctrl+CLICK must still toggle the selection — the old gesture is not taken away
  const clicked = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().select([])
    const el = document.querySelector('.clip')
    const box = el.getBoundingClientRect()
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      clientX: box.left + 40, clientY: box.top + 10, button: 0, ctrlKey: true }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: box.left + 40 }))
    await new Promise((r) => setTimeout(r, 300))
    return { selected: st().selection.length, defects: st().project.defects.length }
  })()`)
  check('Ctrl+click still toggles the selection and marks nothing',
        clicked.selected === 1 && clicked.defects === 4, JSON.stringify(clicked))

  // ---- 8b. the bounds of the defect itself can be dragged
  const edged = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    const mine = st().project.defects.find((d) => d.origin === 'user')
    const before = [...mine.src]
    const h = document.querySelector(
      '.adefect[data-defect="' + mine.id + '"] .adefect-edge.src.right')
    if (!h) return { missing: true }
    const box = h.getBoundingClientRect()
    h.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true,
      clientX: box.left + 3, clientY: box.top + 5, button: 0 }))
    window.dispatchEvent(new PointerEvent('pointermove',
      { bubbles: true, clientX: box.left + 3 + 30 }))
    window.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 200))
    const after = st().project.defects.find((d) => d.id === mine.id)
    return { before, after: after.src, phrase: [after.phrase.t0, after.phrase.t1],
             label: st().past[st().past.length - 1]?.label }
  })()`)
  check('the defect has draggable bounds of its own', !edged.missing)
  check('dragging the right one widens the defect', edged.after[1] > edged.before[1] + 0.5,
        `${edged.before[1]} → ${edged.after[1]}`)
  check('and it can never leave its phrase',
        edged.after[1] <= edged.phrase[1] + 1e-6 && edged.after[0] >= edged.phrase[0] - 1e-6,
        JSON.stringify([edged.after, edged.phrase]))

  // ---- 8c. «just regenerate» never claims a defect
  const redo = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const run = st().project.voiceRuns[0]
    const id = await E.addUserDefect(run.assetId, 12, 12.4, 'redo')
    const d = st().project.defects.find((x) => x.id === id)
    await E.flushVerdicts(run.id)
    return { id, cls: d.cls, origin: d.origin, hasPhrase: d.phrase.t1 > d.phrase.t0 }
  })()`, { timeout: 60000 })
  check('a «regenerate» mark still gets a phrase', redo.hasPhrase && redo.origin === 'user',
        JSON.stringify(redo))
  const marksFile = JSON.parse(readFileSync(`${RUN}/user_marks.json`, 'utf8'))
  check('but it is kept out of the training corpus',
        redo.cls === 'redo' && marksFile.every((m) => m.a0 !== 12),
        `${marksFile.length} отметок в корпусе`)

  // …и это ВИДНО на таймлайне. Раньше «заново» рисовалось точно как отметка
  // дефекта, и по метке нельзя было понять, попадёт ли она в обучение.
  const look = await evalJs(`(async () => {
    await new Promise((r) => setTimeout(r, 300))
    const id = ${JSON.stringify('__ID__')}
    const band = document.querySelector('.adefect[data-defect="' + id + '"]')
    const other = [...document.querySelectorAll('.adefect')]
      .find((b) => b.dataset.defect !== id && !b.classList.contains('redo'))
    const flag = band && band.parentElement.querySelector('.adefect-flag')
    const otherFlag = other && other.parentElement.querySelector('.adefect-flag')
    const bg = (el) => el ? getComputedStyle(el).backgroundImage + getComputedStyle(el).backgroundColor : ''
    return {
      isRedo: !!band && band.classList.contains('redo'),
      flagRedo: !!flag && flag.classList.contains('redo'),
      glyph: flag && (flag.querySelector('svg')?.innerHTML ?? ''),
      otherGlyph: otherFlag && (otherFlag.querySelector('svg')?.innerHTML ?? ''),
      differsBand: !!other && bg(band) !== bg(other),
      differsFlag: !!otherFlag && bg(flag) !== bg(otherFlag),
      title: (flag && flag.title) || ''
    }
  })()`.replace('"__ID__"', JSON.stringify(redo.id)), { timeout: 30000 })
  check('a «regenerate» mark is drawn as its own kind',
        look.isRedo && look.flagRedo, JSON.stringify(look))
  check('its flag carries a different glyph from a defect',
        !!look.glyph && !!look.otherGlyph && look.glyph !== look.otherGlyph,
        `${String(look.glyph).slice(0, 40)} против ${String(look.otherGlyph).slice(0, 40)}`)
  check('and a different colour, band and flag alike',
        look.differsBand && look.differsFlag, JSON.stringify(look))
  check('the tooltip says outright that it does not train the detector',
        /НЕ идёт/.test(look.title), look.title.slice(0, 90))

  // ---- 8d. the marks can be hidden
  const hiding = await evalJs(`(async () => {
    const E = window.kadrEditor
    E.setDefectsHidden(true)
    await new Promise((r) => setTimeout(r, 250))
    const off = { bands: document.querySelectorAll('.adefect').length,
                  flags: document.querySelectorAll('.adefect-flag').length,
                  stored: localStorage.getItem('kadr.defectsHidden') }
    E.setDefectsHidden(false)
    await new Promise((r) => setTimeout(r, 250))
    const on = { bands: document.querySelectorAll('.adefect').length }
    return { off, on, kept: E.useEditor.getState().project.defects.length }
  })()`)
  check('hiding removes every mark from the timeline',
        hiding.off.bands === 0 && hiding.off.flags === 0, JSON.stringify(hiding.off))
  check('the choice is remembered', hiding.off.stored === '1', String(hiding.off.stored))
  check('showing brings them back, and nothing was deleted',
        hiding.on.bands > 0 && hiding.kept > 0, JSON.stringify(hiding))

  // ---- 9. a clip written by a script, without transform/mask/gain, must not
  //         take the whole editor down (it used to: ClipView read
  //         clip.transform.opacity.value directly, and one such clip from
  //         kadr_eval turned the window white)
  const badClip = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().setProject({ ...st().project, tracks: [
      { id: 'A', kind: 'audio', name: 'A1', muted: false, locked: false, gain: 1, clips: [] },
      { id: 'V', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [] }],
      assets: [], texts: [], defects: [], voiceRuns: [] }, null)
    const p = st().project
    p.tracks[1].clips.push({ id: 'BAD', kind: 'media', assetId: 'нет', start: 0,
                             duration: 5, inPoint: 0, label: 'кривой' })
    st().setPlayhead(1)
    await new Promise((r) => setTimeout(r, 800))
    return { alive: document.getElementById('root')?.childElementCount > 0,
             drawn: document.querySelectorAll('.clip').length }
  })()`)
  check('a clip with no transform/gain does not white-screen the editor',
        badClip.alive && badClip.drawn === 1, JSON.stringify(badClip))

  // ---- 10. a hand-placed mark needs a finished analysis
  await evalJs(BUILD(1))
  const needsRun = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    // a run that was never analysed has no runDir, and without it there is
    // nothing to compute the phrase from
    const p = JSON.parse(JSON.stringify(st().project))
    delete p.voiceRuns[0].runDir
    st().setProject(p, null)
    try { await E.addUserDefect('A1', 1, 2); return 'no error' }
    catch (e) { return String(e.message || e) }
  })()`)
  check('a hand-placed mark without an analysis is refused with a reason',
        /разбор/i.test(needsRun), needsRun)
} finally {
  await evalJs(`(() => { window.kadrEditor.setDefectsHidden(${JSON.stringify(savedHidden)}); return 1 })()`)
    .catch(() => { /* страница могла уйти */ })
  ws.close()
}
console.log('e2e37 finished')
