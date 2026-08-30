// Test: regenerating a defective phrase and splicing it back (stage 3).
//
// Runs with KADR_TTS_MOCK=1 — the patch is synthesised locally, so the suite
// costs no ElevenLabs credits and needs no network. What it checks is the part
// that has nothing to do with the model: that the right stretch is replaced,
// that the timeline stays consistent, and that one undo puts it all back.
//
// Launch: KADR_TTS_MOCK=1 npx electron-vite dev -- --remote-debugging-port=9777
import WebSocket from 'ws'
import { execFileSync, spawnSync } from 'child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'fs'
import { readdirSync, rmSync, existsSync } from 'fs'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-test/regen'
const VOICE = `${DIR}/voice.wav`
const SCRIPT = `${DIR}/voice.script.txt`

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
async function evalJs(expression, { timeout = 180000 } = {}) {
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
/** zero crossings — for a pure tone this is the frequency, exactly */
function toneAt(file, from, dur = 0.3) {
  const buf = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(from), '-t', String(dur),
    '-i', file, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 1 << 26 })
  let cross = 0
  let prev = buf.readInt16LE(0)
  for (let i = 1; i < buf.length / 2; i++) {
    const v = buf.readInt16LE(i * 2)
    if ((prev < 0 && v >= 0) || (prev > 0 && v <= 0)) cross++
    prev = v
  }
  return Math.round(cross / 2 / dur)
}

const chans = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
  '-show_entries', 'stream=channels', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()

/** средний уровень в коротком окне — им проверяем, что рез попал в тишину */
function levelAt(file, at, dur = 0.03) {
  const r = spawnSync('ffmpeg', ['-v', 'info', '-nostats', '-ss', String(at), '-t', String(dur),
    '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
  return parseFloat(/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr || '')?.[1] ?? 'NaN')
}

/** Разбор фикстуры: то, что настоящий `check` кладёт рядом с прогоном.
 *  Ручная отметка считает фразу ИМЕННО по нему, моделей для этого не нужно. */
function writeIndex() {
  const text = readFileSync(SCRIPT, 'utf8')
  const sents = []
  const charRanges = []
  const wordTimes = {}
  // пять предложений по три слова: [0,1] [1.4,2.4] [2.8,3.8] [4.2,5.2] [5.6,6.6]
  const re = /[^\s.]+/g
  let m
  let sn = 0
  let seen = 0
  while ((m = re.exec(text))) {
    const i = sents.length
    sents.push(sn)
    charRanges.push([m.index, m.index + m[0].length])
    const t0 = sn * 1.4 + seen * 0.34
    wordTimes[i] = [+t0.toFixed(3), +(t0 + 0.3).toFixed(3)]
    seen++
    if (seen === 3) { seen = 0; sn++ }
  }
  writeFileSync(`${DIR}/script.txt`, text)
  writeFileSync(`${DIR}/phrase-index.json`, JSON.stringify({
    duration: 6.6, audio: VOICE, sents, charRanges, wordTimes, speechP: []
  }))
  writeFileSync(`${DIR}/defects.json`, JSON.stringify({
    audio: VOICE, script: `${DIR}/script.txt`, duration: 6.6, trust: 1,
    stats: {}, defects: [], suppressed: [], text_mismatches: []
  }))
  // переносы прошлых прогонов — не наследство, а мусор
  rmSync(`${DIR}/phrase-index.cur.json`, { force: true })
  rmSync(`${DIR}/phrase-audio.wav`, { force: true })
  rmSync(`${DIR}/user_marks.json`, { force: true })
}

// один клип озвучки на A1 и ещё один клип правее — по нему видно сдвиг
const BUILD = (opts = {}) => `(async () => {
  const E = window.kadrEditor, st = () => E.useEditor.getState()
  const { asset } = await window.kadr.probeMedia(${JSON.stringify(VOICE)})
  const assetId = 'VA', runId = 'VR'
  st().setProject({ ...st().project, width: 640, height: 360, fps: 30,
    tracks: [{ id: 'T0', kind: 'audio', name: 'A1', muted: false, locked: false, gain: 1, clips: [] },
             { id: 'T1', kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [] }],
    assets: [{ id: assetId, ...asset }], texts: [], defects: [],
    voiceRuns: [{ id: runId, assetId, scriptPath: ${JSON.stringify(SCRIPT)}, scriptHash: '',
      runDir: ${JSON.stringify(DIR)}, duration: asset.duration, tempo: ${opts.tempo ?? 1},
      createdAt: Date.now() }] }, null)
  const p = st().project
  const base = { kind: 'media', ...E.newClipDefaults() }
  p.tracks[0].clips.push({ id: 'CV', assetId, start: 0, duration: ${opts.clipDur ?? 'asset.duration'},
    inPoint: ${opts.inPoint ?? 0}, label: 'voice', ...base })
  // сосед справа на той же дорожке и клип на видеодорожке — оба должны сдвинуться
  p.tracks[0].clips.push({ id: 'CNEXT', assetId, start: 20, duration: 2, inPoint: 0, label: 'next', ...base })
  p.tracks[1].clips.push({ id: 'CVID', assetId, start: 30, duration: 2, inPoint: 0, label: 'vid', ...base })
  // дефект в третьем «предложении»: рез по серединам соседних пауз
  const d = { id: 'dfx', runId, assetId, origin: 'detector', cls: 'insert', confidence: 0.9,
    words: [4, 6], play: [2.6, 4.0], src: [3.0, 3.2], state: 'proposed',
    phrase: { t0: 2.6, t1: 4.0, sentFrom: 2, sentTo: 2, wordFrom: 4, wordTo: 6,
      charFrom: 51, charTo: 77, text: 'Третье предложение теста.', cut: ['silence', 'silence'] } }
  // и ещё один, ПОСЛЕ реза — он должен уехать вместе со звуком
  const d2 = { id: 'dlater', runId, assetId, origin: 'detector', cls: 'corrupt', confidence: 0.7,
    words: [8, 9], play: [5.4, 6.6], src: [5.8, 6.0], state: 'proposed',
    phrase: { t0: 5.4, t1: 6.6, sentFrom: 4, sentTo: 4, wordFrom: 8, wordTo: 10,
      charFrom: 103, charTo: 129, text: 'Пятое предложение теста.', cut: ['silence', 'fileEnd'] } }
  st().applyCheckResult(runId, {}, [d, d2])
  return { duration: asset.duration, clips: p.tracks[0].clips.length }
})()`

/** Всё своё медиа набор делает сам: пять «предложений» разными тонами с
    паузами 0.4 с, чтобы точки реза попадали в заведомо известную тишину. */
function makeMedia() {
  mkdirSync(DIR, { recursive: true })
  const args = ['-y', '-v', 'error']
  const parts = []
  let n = 0
  for (const hz of [400, 500, 600, 700, 800]) {
    args.push('-f', 'lavfi', '-i', `sine=frequency=${hz}:duration=1:sample_rate=48000`)
    parts.push(`[${n++}:a]`)
    if (hz !== 800) {
      args.push('-f', 'lavfi', '-t', '0.4', '-i', 'anullsrc=r=48000:cl=mono')
      parts.push(`[${n++}:a]`)
    }
  }
  const chain = `${parts.join('')}concat=n=${n}:v=0:a=1`
  execFileSync('ffmpeg', [...args, '-filter_complex',
    `${chain},aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[o]`,
    '-map', '[o]', '-c:a', 'pcm_s16le', VOICE])
  writeFileSync(SCRIPT, 'Первое предложение теста. Второе предложение теста. ' +
    'Третье предложение теста. Четвёртое предложение теста. Пятое предложение теста.\n')
  // моно-вариант и заплатка к нему — для проверки, что раскладка каналов цела
  execFileSync('ffmpeg', [...args, '-filter_complex', `${chain},aformat=channel_layouts=mono[o]`,
    '-map', '[o]', '-ac', '1', '-c:a', 'pcm_s16le', `${DIR}/mono.wav`])
  // заплатка ИМЕННО такая, какую отдаёт speakPhrase: с тишиной по краям.
  // Голый тон был бы нечестной фикстурой — кроссфейд сшивал бы тишину с полной
  // амплитудой, и «разрыв» на шве оказался бы собственной крутизной синусоиды
  execFileSync('ffmpeg', ['-y', '-v', 'error',
    '-f', 'lavfi', '-t', '0.05', '-i', 'anullsrc=r=48000:cl=mono',
    '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=1.4:sample_rate=48000',
    '-f', 'lavfi', '-t', '0.05', '-i', 'anullsrc=r=48000:cl=mono',
    '-filter_complex', '[0:a][1:a][2:a]concat=n=3:v=0:a=1,' +
      'aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[o]',
    '-map', '[o]', '-c:a', 'pcm_s16le', `${DIR}/mono-patch.wav`])
  // та же заплатка в МОНО: именно такую теперь отдаёт синтез (API отвечает моно)
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', `${DIR}/mono-patch.wav`,
    '-ac', '1', '-c:a', 'pcm_s16le', `${DIR}/mono-patch1.wav`])
}

makeMedia()
writeIndex()      // разбор фикстуры: без него ручные отметки некуда класть

// прошлые прогоны оставляют voice.fixN.wav — они не затираются намеренно
for (const f of readdirSync(DIR)) {
  if (/^voice((\.fix\d+)+|\.patch\d+)\.(wav|flac)$/.test(f)) rmSync(`${DIR}/${f}`, { force: true })
  if (/^other\.fix\d+\.(wav|flac)$/.test(f)) rmSync(`${DIR}/${f}`, { force: true })
}

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// Настройки озвучки — РЕАЛЬНЫЕ данные пользователя, общие с его рабочими
// сессиями. Этот набор их меняет (проверяет, что берётся темп прогона, а не
// настройки), поэтому снимок в начале и возврат в finally — обязательны.
// Без этого он один раз уже оставил у пользователя tempo=1 при включённой
// галочке, и ускорение перестало работать.
const savedSettings = await evalJs(`(async () => JSON.stringify(
  { v: await window.kadr.readUserStore('tts-settings') }))()`)

try {
  // NOT ttsHasKey — see the note in e2e36: it is true with a real key stored.
  const mock = await evalJs('window.kadr.ttsIsMock()')
  check('the app really is in mock mode', mock === true, mock ? '' : 'запустите с KADR_TTS_MOCK=1')
  if (!mock) throw new Error('mock mode is off — this suite would spend real credits')

  const built = await evalJs(BUILD())
  check('the voice-over fixture is built', Math.abs(built.duration - 6.6) < 0.02, String(built.duration))
  check('the original has the third sentence at 600 Hz', toneAt(VOICE, 3.3) === 600,
        String(toneAt(VOICE, 3.3)))

  // ---- 1. regenerate one confirmed phrase
  const before = await evalJs(`(() => {
    const p = window.kadrEditor.useEditor.getState().project
    const c = (id) => p.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
    return { voice: { start: c('CV').start, duration: c('CV').duration },
             next: c('CNEXT').start, vid: c('CVID').start,
             later: p.defects.find((d) => d.id === 'dlater').src }
  })()`)
  const r = await evalJs(`(async () => {
    window.kadrEditor.setVerdict('dfx', true)
    const r = await window.kadrEditor.regenerateDefects({ ripple: true, rippleAllTracks: true })
    const p = window.kadrEditor.useEditor.getState().project
    const c = (id) => p.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
    const asset = p.assets.find((a) => a.id === r.newAssetId)
    return { r, path: asset && asset.path, newDur: asset && asset.duration,
             voice: { start: c('CV').start, duration: c('CV').duration, assetId: c('CV').assetId },
             next: c('CNEXT').start, vid: c('CVID').start,
             fixed: p.defects.find((d) => d.id === 'dfx'),
             later: p.defects.find((d) => d.id === 'dlater'),
             runAsset: p.voiceRuns[0].assetId, runDur: p.voiceRuns[0].duration }
  })()`)
  const delta = r.r.delta
  check('one phrase was regenerated', r.r.units === 1, JSON.stringify(r.r.units))
  check('a new audio file was produced, without overwriting the take',
        !!r.path && /\.fix\d+\.flac$/.test(r.path), r.path)
  check('the measured duration matches the reported change',
        Math.abs(r.newDur - (built.duration + delta)) < 0.02,
        `${r.newDur} против ${(built.duration + delta).toFixed(3)}`)
  check('the clip was retargeted to the new file', r.voice.assetId === r.r.newAssetId)
  check('the voice clip grew by exactly the delta',
        Math.abs(r.voice.duration - (before.voice.duration + delta)) < 0.02,
        `${r.voice.duration} против ${(before.voice.duration + delta).toFixed(3)}`)
  check('the clip after it shifted by the delta',
        Math.abs(r.next - (before.next + delta)) < 1e-6, `${before.next} → ${r.next}`)
  check('the clip on the OTHER track shifted too (sync kept)',
        Math.abs(r.vid - (before.vid + delta)) < 1e-6, `${before.vid} → ${r.vid}`)
  check('the fixed defect is marked done', r.fixed.state === 'done' && r.fixed.attempts === 1,
        `${r.fixed.state}/${r.fixed.attempts}`)
  check('the later defect moved with the audio',
        Math.abs(r.later.src[0] - (before.later[0] + delta)) < 0.01,
        `${before.later[0]} → ${r.later.src[0]}`)
  check('the run points at the new file', r.runAsset === r.r.newAssetId &&
        Math.abs(r.runDur - r.newDur) < 0.02)

  // ---- 2. the audio around the splice is intact and the middle is new
  check('the sentence BEFORE the splice is untouched (500 Hz)', toneAt(r.path, 1.9) === 498 ||
        toneAt(r.path, 1.9) === 500, String(toneAt(r.path, 1.9)))
  const after = toneAt(r.path, 6.6 + delta - 0.5)
  check('the last sentence is still there after the shift (800 Hz)',
        Math.abs(after - 800) <= 4, String(after))
  const mid = toneAt(r.path, 3.2)
  check('the replaced stretch is NOT the old tone any more', mid !== 600, `${mid} Гц`)

  // ---- 3. one undo puts everything back
  const undone = await evalJs(`(() => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().undo()
    const p = st().project
    const c = (id) => p.tracks.flatMap((t) => t.clips).find((x) => x.id === id)
    return { voice: { start: c('CV').start, duration: c('CV').duration, assetId: c('CV').assetId },
             next: c('CNEXT').start, vid: c('CVID').start,
             state: p.defects.find((d) => d.id === 'dfx').state,
             later: p.defects.find((d) => d.id === 'dlater').src,
             assets: p.assets.length }
  })()`)
  check('one undo restores the clip, its length and its asset',
        undone.voice.assetId === 'VA' &&
        Math.abs(undone.voice.duration - before.voice.duration) < 1e-6, JSON.stringify(undone.voice))
  check('and every shifted clip goes back',
        undone.next === before.next && undone.vid === before.vid,
        `${undone.next}/${undone.vid}`)
  check('and the verdict returns to confirmed', undone.state === 'confirmed', undone.state)
  check('and the later defect is back where it was',
        Math.abs(undone.later[0] - before.later[0]) < 1e-9)

  // ---- 4. the run's own tempo is used, not the current setting
  await evalJs(BUILD({ tempo: 2 }))
  const sped = await evalJs(`(async () => {
    window.kadrEditor.useTtsSettings.getState().update({ tempoEnabled: false, tempo: 1 })
    window.kadrEditor.setVerdict('dfx', true)
    const r = await window.kadrEditor.regenerateDefects({ ripple: false })
    return { delta: r.delta }
  })()`)
  check('a file recorded at tempo 2 gets a patch at tempo 2 (shorter than at 1)',
        sped.delta < delta - 0.2, `Δ ${sped.delta.toFixed(2)} против ${delta.toFixed(2)} при tempo 1`)

  // ---- 5. a clip cut inside the phrase is refused, and nothing is touched
  await evalJs(BUILD({ clipDur: 3.5 }))       // клип кончается на 3.5 с — внутри фразы 2.6–4.0
  const refused = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    window.kadrEditor.setVerdict('dfx', true)
    const snapshot = JSON.stringify(st().project.tracks)
    let err = 'no error'
    try { await window.kadrEditor.regenerateDefects({}) } catch (e) { err = String(e.message || e) }
    return { err, unchanged: JSON.stringify(st().project.tracks) === snapshot,
             assets: st().project.assets.length }
  })()`)
  check('a clip cut inside the replaced phrase is refused with a reason',
        /разрезан внутри/.test(refused.err), refused.err)
  check('and the project is left exactly as it was',
        refused.unchanged && refused.assets === 1, JSON.stringify(refused))

  // ---- 5b. несколько дефектов в ОДНОЙ фразе
  // Раньше здесь всё разъезжалось: неподтверждённый сосед превращался в отметку
  // на всю новую фразу, и свежая запись оказывалась целиком помечена дефектом.
  await evalJs(BUILD())
  const pair = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    // второй дефект в том же предложении, с той же фразой
    const first = st().project.defects.find((d) => d.id === 'dfx')
    st().addUserDefect({ id: 'dfx2', runId: first.runId, assetId: first.assetId,
      origin: 'detector', cls: 'corrupt', confidence: 0.6, words: [6, 7],
      play: first.play, src: [3.4, 3.6], state: 'proposed',
      phrase: { ...first.phrase } })
    E.setVerdict('dfx', true)                 // подтверждён только первый
    const r = await E.regenerateDefects({ ripple: true })
    const p = st().project
    return { units: r.units, warnings: r.warnings,
             ids: p.defects.map((d) => d.id + ':' + d.state),
             spans: p.defects.map((d) => d.src) }
  })()`)
  check('two defects in one sentence are regenerated as ONE phrase', pair.units === 1,
        String(pair.units))
  check('the confirmed one is marked done', pair.ids.includes('dfx:done'), pair.ids.join(', '))
  check('the undecided neighbour is removed, not turned into a whole-phrase defect',
        !pair.ids.some((x) => x.startsWith('dfx2')), pair.ids.join(', '))
  check('and the removal is reported', pair.warnings.some((w) => /снят/.test(w)),
        pair.warnings.join(' | '))
  check('no defect now covers the whole new phrase',
        pair.spans.every(([a, b]) => b - a < 3), JSON.stringify(pair.spans))

  // подтверждены оба — обе отметки закрываются, одна фраза
  await evalJs(BUILD())
  const both = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const first = st().project.defects.find((d) => d.id === 'dfx')
    st().addUserDefect({ id: 'dfx2', runId: first.runId, assetId: first.assetId,
      origin: 'detector', cls: 'corrupt', confidence: 0.6, words: [6, 7],
      play: first.play, src: [3.4, 3.6], state: 'proposed', phrase: { ...first.phrase } })
    E.setVerdict(['dfx', 'dfx2'], true)
    const r = await E.regenerateDefects({ ripple: true })
    const p = st().project
    return { units: r.units, states: p.defects.map((d) => d.id + ':' + d.state) }
  })()`)
  check('both confirmed → one phrase, both closed',
        both.units === 1 && both.states.includes('dfx:done') && both.states.includes('dfx2:done'),
        `${both.units} фраз, ${both.states.join(', ')}`)

  // ---- 5c. ПОВТОРНАЯ перегенерация той же фразы
  // Раньше починенный дефект сохранял границы ДО склейки: вторая попытка резала
  // уже не там, третья ещё дальше, и дорожка портилась. Проверяем на трёх
  // подряд — соседние предложения обязаны остаться нетронутыми.
  await evalJs(BUILD())
  const again = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const out = []
    for (let i = 0; i < 3; i++) {
      E.setVerdict('dfx', true)                    // «не понравилось, ещё раз»
      const r = await E.regenerateDefects({ ripple: true, rippleAllTracks: true })
      const d = st().project.defects.find((x) => x.id === 'dfx')
      const a = st().project.assets.find((x) => x.id === r.newAssetId)
      out.push({ delta: +r.delta.toFixed(4), phrase: [d.phrase.t0, d.phrase.t1],
                 src: d.src, state: d.state, attempts: d.attempts,
                 duration: a.duration, path: a.path })
    }
    return out
  })()`, { timeout: 240000 })
  check('the first attempt changes the length', Math.abs(again[0].delta) > 0.05,
        String(again[0].delta))
  // после первой замены фраза РАВНА вставке, значит следующая замена той же
  // длины и длительность файла больше не меняется
  check('a repeat replaces exactly what was inserted, so nothing drifts',
        Math.abs(again[1].delta) < 0.01 && Math.abs(again[2].delta) < 0.01,
        `Δ ${again[1].delta} и ${again[2].delta}`)
  check('the phrase bounds follow the audio every time',
        again.every((a, i) => Math.abs((a.phrase[1] - a.phrase[0]) -
          (i === 0 ? (a.phrase[1] - a.phrase[0]) : (again[0].phrase[1] - again[0].phrase[0]))) < 0.01),
        JSON.stringify(again.map((a) => [ +a.phrase[0].toFixed(3), +a.phrase[1].toFixed(3) ])))
  check('and the file length stops moving after the first attempt',
        Math.abs(again[1].duration - again[0].duration) < 0.01 &&
        Math.abs(again[2].duration - again[0].duration) < 0.01,
        JSON.stringify(again.map((a) => a.duration)))
  check('every attempt is counted', again.map((a) => a.attempts).join(',') === '1,2,3',
        again.map((a) => a.attempts).join(','))

  // самое важное: соседние предложения не тронуты ни разу
  const neighbours = {
    before: toneAt(again[2].path, 1.9),
    after: toneAt(again[2].path, 4.7 + again[0].delta),
    last: toneAt(again[2].path, 6.1 + again[0].delta)
  }
  check('the sentence before the phrase survived three regenerations',
        Math.abs(neighbours.before - 500) <= 4, String(neighbours.before))
  check('and the two after it as well',
        Math.abs(neighbours.after - 700) <= 4 && Math.abs(neighbours.last - 800) <= 4,
        JSON.stringify(neighbours))

  // ---- 5d. разбор обязан переезжать на новый файл вместе со звуком
  //
  // Баг пользователя: он смонтировал, в конце сам отметил дефект — но отметка
  // встала «будто бы не верно», перегенерация вырезала не тот кусок и испортила
  // дорожку. Причина: phrase-index.json описывает файл ТАКИМ, КАКИМ ЕГО РАЗОБРАЛИ,
  // а до этого уже были склейки, сдвинувшие звук. Ручная отметка искала фразу в
  // координатах старой версии и подхватывала чужое предложение.
  writeIndex()
  await evalJs(BUILD())
  const moved = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    E.setVerdict('dfx', true)
    const r = await E.regenerateDefects({ ripple: true, rippleAllTracks: true })
    const a = st().project.assets.find((x) => x.id === r.newAssetId)
    return { delta: r.delta, path: a.path, duration: a.duration, warnings: r.warnings,
             runDir: st().project.voiceRuns[0].runDir,
             runDuration: st().project.voiceRuns[0].duration }
  })()`, { timeout: 120000 })
  const D = moved.delta
  check('the reindex did not complain', !moved.warnings.some((w) => /разбор не удалось/.test(w)),
        moved.warnings.join(' | '))
  check('the analysis was carried over to the new file', existsSync(`${DIR}/phrase-index.cur.json`))
  const baseIdx = JSON.parse(readFileSync(`${DIR}/phrase-index.json`, 'utf8'))
  const curIdx = existsSync(`${DIR}/phrase-index.cur.json`)
    ? JSON.parse(readFileSync(`${DIR}/phrase-index.cur.json`, 'utf8'))
    : { wordTimes: { 0: [0, 0], 3: [0, 0], 12: [0, 0] } }
  check('the original analysis is left untouched — it is the training corpus',
        Math.abs(baseIdx.duration - 6.6) < 0.02 && baseIdx.audio === VOICE &&
        Math.abs(baseIdx.wordTimes['12'][0] - 5.6) < 1e-6, String(baseIdx.duration))
  check('the carried-over one matches the new file',
        Math.abs(curIdx.duration - moved.duration) < 0.02 &&
        curIdx.audio === `${DIR}/phrase-audio.wav`, `${curIdx.duration} / ${curIdx.audio}`)
  check('words BEFORE the splice keep their times',
        Math.abs(curIdx.wordTimes['0'][0] - 0) < 1e-6 &&
        Math.abs(curIdx.wordTimes['3'][0] - 1.4) < 1e-6, JSON.stringify(curIdx.wordTimes['3']))
  check('words AFTER it moved by exactly the delta',
        Math.abs(curIdx.wordTimes['12'][0] - (5.6 + D)) < 0.002,
        `${curIdx.wordTimes['12'][0]} против ${(5.6 + D).toFixed(3)}`)

  // И главное — ручная отметка. Один и тот же момент речи, отмеченный на
  // исходном файле и на склеенном, обязан дать ОДНУ И ТУ ЖЕ фразу, просто
  // сдвинутую на Δ. Раньше вторая отметка считалась по старому разбору и
  // подхватывала соседнее предложение.
  const at = 6.1 + D
  const hand = await evalJs(`(async () => ({
    base: await window.kadr.voicePhraseAt({ runDir: ${JSON.stringify(DIR)},
      start: 6.1, end: 6.2, audioDuration: 6.6 }),
    cur: await window.kadr.voicePhraseAt({ runDir: ${JSON.stringify(DIR)},
      start: ${at}, end: ${at + 0.1}, audioDuration: ${moved.runDuration} })
  }))()`, { timeout: 60000 })
  check('the untouched analysis still answers for the original file',
        Math.abs(hand.base.phrase.t0 - 3.998) < 0.08 &&
        Math.abs(hand.base.phrase.t1 - 6.6) < 0.05,
        `${hand.base.phrase.t0} / ${hand.base.phrase.t1}`)
  check('a hand mark after a splice picks the SAME sentences',
        hand.cur.phrase.wordFrom === hand.base.phrase.wordFrom &&
        hand.cur.phrase.wordTo === hand.base.phrase.wordTo,
        `${hand.cur.phrase.wordFrom}..${hand.cur.phrase.wordTo} против ` +
        `${hand.base.phrase.wordFrom}..${hand.base.phrase.wordTo}`)
  check('and its phrase is in the coordinates of the file on the timeline',
        Math.abs(hand.cur.phrase.t0 - (hand.base.phrase.t0 + D)) < 0.03 &&
        Math.abs(hand.cur.phrase.t1 - moved.duration) < 0.05,
        `${hand.cur.phrase.t0} / ${hand.cur.phrase.t1} при Δ ${D.toFixed(3)}`)
  check('the cut really lands in silence of the NEW file',
        levelAt(moved.path, hand.cur.phrase.t0 - 0.01) < -45,
        `${levelAt(moved.path, hand.cur.phrase.t0 - 0.01)} дБ на ${hand.cur.phrase.t0}`)
  check('and the sentence behind the cut is the one the mark was in (700 Hz)',
        Math.abs(toneAt(moved.path, hand.cur.phrase.t0 + 0.3, 0.25) - 700) <= 6,
        String(toneAt(moved.path, hand.cur.phrase.t0 + 0.3, 0.25)))

  // корпус обучения продолжает описывать РАЗОБРАННЫЙ звук
  const corpus = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const run = st().project.voiceRuns[0]
    const id = await E.addUserDefect(run.assetId, ${at}, ${at + 0.2})
    const res = await E.flushVerdicts(run.id)
    return { res, src: st().project.defects.find((d) => d.id === id).src }
  })()`, { timeout: 60000 })
  const marks = existsSync(`${DIR}/user_marks.json`)
    ? JSON.parse(readFileSync(`${DIR}/user_marks.json`, 'utf8')) : []
  check('the mark is stored on the timeline in current-file seconds',
        Math.abs(corpus.src[0] - at) < 1e-6, JSON.stringify(corpus.src))
  check('but reaches the corpus in the coordinates of the ANALYSED audio',
        marks.length === 1 && Math.abs(marks[0].a0 - 6.1) < 0.01,
        JSON.stringify(marks.map((m) => m.a0)))

  // отметка внутри уже заменённого куска обучению не годится: того дубля в
  // разобранном звуке просто нет, и придумывать ей координату нельзя
  const inside = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    const run = st().project.voiceRuns[0]
    const mid = ${'3.2'} + ${D} * 0.3
    const id = await E.addUserDefect(run.assetId, mid, mid + 0.1)
    const res = await E.flushVerdicts(run.id)
    st().removeDefects([id])
    return res
  })()`, { timeout: 60000 })
  check('a mark inside the replaced stretch is kept out of the corpus, and counted',
        inside.droppedMarks === 1, JSON.stringify(inside))

  // версия, которой разбор никогда не видел
  const stale = await evalJs(`(async () => {
    try {
      await window.kadr.voicePhraseAt({ runDir: ${JSON.stringify(DIR)},
        start: 1, end: 1.2, audioDuration: 99 })
      return 'no error'
    } catch (e) { return String(e.message || e) }
  })()`, { timeout: 60000 })
  check('a mark on a version the analysis never saw is refused, not guessed',
        /другой версии/.test(stale), stale)

  // ---- 6. a mono voice-over must stay mono
  // (forcing stereo multiplies mono by 0.7071 — measured exactly -3.01 dB —
  //  and the preview of an imported mono voice-over would just get quieter)
  const mono = await evalJs(`(async () => {
    const src = '/tmp/kadr-test/regen/mono.wav'
    const patch = '/tmp/kadr-test/regen/mono-patch.wav'
    const out = '/tmp/kadr-test/regen/mono-out.wav'
    // уровень выравнивается так же, как в рабочем пути: заплатка приходит
    // стерео (каждый канал в 0.7071 от моно), и без поправки шов даст ступеньку
    const a = await window.kadr.meanVolume(src, 2.8, 1)
    const b = await window.kadr.meanVolume(patch, 0.1, 1)
    const r = await window.kadr.voiceSplice({ src, out,
      units: [{ cut0: 2.6, cut1: 4.0, patchPath: patch,
                gainDb: a.mean - b.mean, fade: 0.02 }] })
    const probe = await window.kadr.probeMedia(out)
    return { duration: r.duration, seams: r.seams, path: out, name: probe.asset.name }
  })()`)
  check('a mono source produces a mono result', chans('/tmp/kadr-test/regen/mono-out.wav') === '1',
        chans('/tmp/kadr-test/regen/mono-out.wav'))
  // volumedetect печатает в stderr, поэтому spawnSync, а не execFileSync
  const lvl = (f, at) => {
    const r = spawnSync('ffmpeg', ['-v', 'info', '-nostats', '-ss', String(at), '-t', '0.5',
      '-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' })
    return parseFloat(/mean_volume:\s*(-?[\d.]+)/.exec(r.stderr || '')?.[1] ?? 'NaN')
  }
  check('and keeps its level (no 3 dB mono→stereo loss)',
        Math.abs(lvl('/tmp/kadr-test/regen/mono.wav', 0.3) -
                 lvl('/tmp/kadr-test/regen/mono-out.wav', 0.3)) < 0.5,
        `${lvl('/tmp/kadr-test/regen/mono.wav', 0.3)} → ${lvl('/tmp/kadr-test/regen/mono-out.wav', 0.3)}`)
  check('and its seams are clean', mono.seams.every((s) => s.clean),
        JSON.stringify(mono.seams.map((s) => [s.step, s.stepAround])))

  // ---- 6b. СТЕРЕО исходник и МОНО заплатка — новая пара после того, как
  // синтез перестал раздувать моно до стерео. Приведение раскладки обязано
  // быть копированием канала: матрица сведения ffmpeg тише ровно на 3.01 дБ,
  // и свежая фраза села бы тише той, которую заменяет.
  const s2m = await evalJs(`(async () => {
    const r = await window.kadr.voiceSplice({
      src: ${JSON.stringify(VOICE)}, out: ${JSON.stringify(DIR + '/stereo-out.wav')},
      units: [{ cut0: 2.6, cut1: 4.0, patchPath: ${JSON.stringify(DIR + '/mono-patch1.wav')},
                gainDb: 0, fade: 0.02 }] })
    return { duration: r.duration }
  })()`)
  check('a stereo voice-over stays stereo', chans(`${DIR}/stereo-out.wav`) === '2',
        chans(`${DIR}/stereo-out.wav`))
  const patchLvl = levelAt(`${DIR}/mono-patch1.wav`, 0.2, 0.8)
  const inFile = levelAt(`${DIR}/stereo-out.wav`, 2.8, 0.8)
  check('and a mono patch keeps its level (copied, never downmixed)',
        Math.abs(inFile - patchLvl) < 0.4, `${patchLvl} → ${inFile} дБ`)
  check('the spliced length is measured, not guessed', s2m.duration > 6, String(s2m.duration))

  // ---- 7. nothing confirmed → a clear message, not a silent no-op
  const none = await evalJs(`(async () => {
    window.kadrEditor.clearVerdict(['dfx'])
    try { await window.kadrEditor.regenerateDefects({}); return 'no error' }
    catch (e) { return String(e.message || e) }
  })()`)
  check('with nothing confirmed it says so', /подтверждённых/.test(none), none)

  // ---- 8. уборка промежуточных версий
  // Каждая перегенерация оставляет прежний файл — за один рабочий день у
  // пользователя набралось 4.3 ГБ. Что удалять, решает MAIN: рендерер называет
  // только те пути, которые проекту НУЖНЫ, назвать файл на удаление он не может.
  writeFileSync(`${DIR}/other.fix1.wav`, readFileSync(`${DIR}/mono.wav`))   // чужая цепочка
  const cur = await evalJs(`window.kadrEditor.useEditor.getState().project.assets.map((a) => a.path)`)
  const vv = await evalJs(`window.kadrEditor.scanVoiceVersions()`)
  check('the scan finds the versions left behind', vv.files.length >= 2,
        `${vv.files.length} файлов, ${(vv.bytes / 1e6).toFixed(1)} МБ`)
  check('every one of them is a version of this voice-over',
        vv.files.every((f) => /^voice(\.fix\d+)+\.(wav|flac)$/.test(f.name)),
        vv.files.map((f) => f.name).join(', ').slice(0, 160))
  check('nothing the project still uses is listed',
        vv.files.every((f) => !cur.includes(f.path)), cur.join(', '))
  check('the original take is never listed',
        !vv.files.some((f) => f.name === 'voice.wav'))
  check('and a file of another chain is left alone',
        !vv.files.some((f) => f.name === 'other.fix1.wav'))

  const gone = vv.files.map((f) => f.path)

  // убираем ЧЕРЕЗ ОКНО, а не через API: кнопка, подтверждение и предупреждение —
  // часть защиты, удаление файлов отменить нечем
  const ui = await evalJs(`(async () => {
    const E = window.kadrEditor
    const click = (text) => {
      const b = [...document.querySelectorAll('.modal button')]
        .find((x) => x.textContent.trim() === text)
      if (!b) return false
      b.click()
      return true
    }
    E.useDefectsUi.getState().setOpen(true)
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 150))
      if ([...document.querySelectorAll('.modal button')]
          .some((b) => b.textContent.includes('Убрать старые версии'))) break
    }
    const btn = [...document.querySelectorAll('.modal button')]
      .find((b) => b.textContent.includes('Убрать старые версии'))
    const line = [...document.querySelectorAll('.modal .hint-inline')]
      .map((d) => d.textContent).find((x) => /Промежуточных версий/.test(x)) || ''
    const opened = !!btn && !btn.disabled
    if (!opened) return { opened, line }
    btn.click()
    await new Promise((r) => setTimeout(r, 200))
    const listed = document.querySelectorAll('.modal .vv-list div').length
    const warned = !!document.querySelector('.modal .vv-list .tr-error')
    const clicked = click('Удалить безвозвратно')
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 150))
      const still = [...document.querySelectorAll('.modal button')]
        .find((b) => b.textContent.includes('Удалить безвозвратно'))
      if (!still) break
    }
    const after = [...document.querySelectorAll('.modal .hint-inline')]
      .map((d) => d.textContent).find((x) => /Промежуточных версий/.test(x)) || ''
    E.useDefectsUi.getState().setOpen(false)
    return { opened, line, listed, warned, clicked, after }
  })()`, { timeout: 60000 })
  check('the dialog offers the cleanup with a count', ui.opened &&
        /Промежуточных версий: \d+/.test(ui.line), JSON.stringify(ui.line))
  check('the first click only asks, listing the files and the warning',
        ui.listed > 0 && ui.warned, `${ui.listed} строк, предупреждение ${ui.warned}`)
  check('and confirming actually deletes them',
        ui.clicked && gone.every((p) => !existsSync(p)), JSON.stringify(ui.after))
  // строка обязана пересчитаться: «версий: 8» сразу после удаления восьми —
  // враньё, и пользователь нажал бы ещё раз
  check('the dialog then reports what it freed and finds nothing more',
        /Удалено файлов: 8/.test(ui.after) && /нет/.test(ui.after), JSON.stringify(ui.after))
  check('the original and the file on the timeline survive',
        existsSync(VOICE) && cur.every((p) => existsSync(p)), cur.join(', '))
  check('and so does the unrelated chain', existsSync(`${DIR}/other.fix1.wav`))
  const leftover = await evalJs(`window.kadrEditor.scanVoiceVersions()`)
  check('a second run finds nothing left to clean', leftover.files.length === 0,
        String(leftover.files.length))
  rmSync(`${DIR}/other.fix1.wav`, { force: true })
} finally {
  await evalJs(`(async () => {
    const { v } = JSON.parse(${JSON.stringify('PLACEHOLDER')})
    const E = window.kadrEditor
    const settings = E.sanitizeTtsSettings(v)
    await window.kadr.writeUserStore('tts-settings', settings)
    E.useTtsSettings.setState({ settings })
    try { localStorage.setItem('kadr.ttsSettings', JSON.stringify(settings)) } catch {}
    return 1
  })()`.replace('"PLACEHOLDER"', JSON.stringify(savedSettings))).catch(() => { /* best effort */ })
  ws.close()
}
console.log('e2e38 finished')
