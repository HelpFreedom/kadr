// Test: the ElevenLabs voice-over module (stage 1 — synthesis).
//
// Runs against KADR_TTS_MOCK=1, which makes the main process synthesise speech
// locally with ffmpeg instead of calling the API. That is not a convenience:
// without it every run of this suite would spend the user's ElevenLabs credits
// and need the network.
//
// Launch the app with:
//   KADR_TTS_MOCK=1 npx electron-vite dev -- --remote-debugging-port=9777
import WebSocket from 'ws'
import { createHash } from 'crypto'
import { readFileSync, existsSync, mkdirSync, rmSync, statSync } from 'fs'
import { execFileSync } from 'child_process'

const PORT = process.env.KADR_CDP_PORT || 9777
const DIR = '/tmp/kadr-test/tts'

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
    await new Promise((r) => setTimeout(r, 400))
  }
}
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  (' + extra + ')' : ''}`)
  if (!cond) process.exitCode = 1
}

rmSync(DIR, { recursive: true, force: true })
mkdirSync(DIR, { recursive: true })

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

// the settings store is user data shared with the user's own sessions — snapshot
// it and put it back at the end, the discipline e2e15/e2e20 had to learn
// NB the wrapper object: a bare JSON.stringify(null) comes back as the STRING
// "null", which is truthy — restoring that wrote a null settings object and
// white-screened the editor on the next dialog open. Found by this suite.
const saved = await evalJs(`(async () => JSON.stringify(
  { v: await window.kadr.readUserStore('tts-settings') }))()`)

try {
  // NOT ttsHasKey: that is true whenever a real key is stored, so the guard
  // was decorative and this suite once went out to the live API under it.
  const mock = await evalJs(`window.kadr.ttsIsMock()`)
  check('the app really is in mock mode', mock === true,
        mock ? '' : 'запустите приложение с KADR_TTS_MOCK=1')
  if (!mock) throw new Error('mock mode is off — the rest of the suite would call the real API')
  check('and a key still reads as present, which is why the guard cannot be ttsHasKey',
        (await evalJs(`window.kadr.ttsHasKey()`)) === true)

  // ---- 1. the key never comes back out of main
  const keyLeak = await evalJs(`(async () => {
    const names = Object.keys(window.kadr).filter((k) => /key/i.test(k))
    const results = {}
    // ВЫЗЫВАЕМ ТОЛЬКО ЧИТАЮЩИЕ. Раньше здесь вызывалось всё подряд, и
    // ttsSetKey() без аргумента стёр настоящий ключ пользователя — сейчас он
    // на такой вызов отвечает ошибкой, но испытывать это на живом ключе
    // всё равно нельзя.
    const READ_ONLY = ['ttsHasKey']
    for (const n of names) {
      if (!READ_ONLY.includes(n)) { results[n] = 'не вызывали: метод пишет' ; continue }
      try { results[n] = await window.kadr[n]() } catch (e) { results[n] = 'threw' }
    }
    // and nothing key-shaped hides in the settings the page can read
    const st = await window.kadr.readUserStore('tts-settings')
    return { names, results, settingsKeys: st ? Object.keys(st) : [] }
  })()`)
  check('the only key-related calls are has/set', keyLeak.names.sort().join(',') === 'ttsHasKey,ttsSetKey',
        keyLeak.names.join(','))
  check('ttsHasKey answers with a boolean, never the key',
        typeof keyLeak.results.ttsHasKey === 'boolean')

  // защита от повторения истории: ключ нельзя стереть случайным вызовом
  const guard = await evalJs(`(async () => {
    try { await window.kadr.ttsSetKey(); return 'no error' }
    catch (e) { return String(e.message || e) }
  })()`)
  check('ttsSetKey refuses a call with no argument instead of clearing the key',
        /ждёт строку/.test(guard), guard)
  check('the settings store holds no key field',
        !keyLeak.settingsKeys.some((k) => /key|secret|token/i.test(k)), keyLeak.settingsKeys.join(','))

  // ---- 2. settings round-trip through the userData file
  await evalJs(`(async () => {
    window.kadrEditor.useTtsSettings.getState().update({
      voiceId: 'mock-voice-1', modelId: 'eleven_multilingual_v2',
      stability: 0.42, similarityBoost: 0.66, tempo: 1.25, tempoEnabled: false })
    await new Promise((r) => setTimeout(r, 300))
    return 1
  })()`)
  const persisted = await evalJs(`window.kadr.readUserStore('tts-settings')`)
  check('settings reach the userData file', persisted?.stability === 0.42 && persisted?.voiceId === 'mock-voice-1',
        JSON.stringify({ s: persisted?.stability, v: persisted?.voiceId }))

  // ---- 3. an empty project with no audio track still gets the clip
  const SCRIPT = 'Первое предложение теста. Второе предложение чуть длиннее первого! Третье?'
  const one = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().setProject({ ...st().project, width: 640, height: 360, fps: 30,
                      tracks: [], assets: [], texts: [], voiceRuns: [] }, null)
    st().setPlayhead(2)
    const r = await E.speakText({ text: ${JSON.stringify(SCRIPT)}, dir: ${JSON.stringify(DIR)} })
    const p = st().project
    const track = p.tracks.find((t) => t.clips.some((c) => c.id === r.clipId))
    const clip = track && track.clips.find((c) => c.id === r.clipId)
    return { r, tracks: p.tracks.length, trackKind: track && track.kind,
             clipStart: clip && clip.start, clipDuration: clip && clip.duration,
             assets: p.assets.length, runs: (p.voiceRuns || []).length,
             texts: (p.texts || []).map((t) => t.path),
             selected: st().selection }
  })()`)
  check('an audio track is created when the project has none',
        one.tracks === 1 && one.trackKind === 'audio', `${one.tracks} дорожек, ${one.trackKind}`)
  check('the clip lands at the playhead', Math.abs(one.clipStart - 2) < 1e-6, String(one.clipStart))
  check('the clip is as long as the audio', Math.abs(one.clipDuration - one.r.duration) < 0.01,
        `${one.clipDuration} против ${one.r.duration}`)
  check('the asset and the run record are both registered',
        one.assets === 1 && one.runs === 1, `${one.assets}/${one.runs}`)
  check('the new clip is selected', one.selected.length === 1 && one.selected[0] === one.r.clipId)

  // Раскладка каналов. ElevenLabs отдаёт МОНО, а wav писался стерео — канал
  // просто дублировался: файл весил вдвое больше ни за что (12 минут речи —
  // 142 МБ вместо 71) и по дороге терял 3.01 дБ на энергосохраняющей матрице
  // ffmpeg. Проверяем и раскладку, и размер: он обязан быть ровно
  // «длительность × 48000 × 2 байта».
  const chansOf = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()
  check('the voice-over is mono, as the synthesis sent it', chansOf(one.r.path) === '1',
        `${chansOf(one.r.path)} канала`)
  const codecOf = (f) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', f], { encoding: 'utf8' }).trim()
  check('and it is written as FLAC, not raw PCM',
        one.r.path.endsWith('.flac') && codecOf(one.r.path) === 'flac',
        `${one.r.path.slice(-24)} / ${codecOf(one.r.path)}`)
  const bytes = statSync(one.r.path).size
  const pcm = one.r.duration * 48000 * 2                  // столько занял бы моно-PCM
  check('so the file is a fraction of the PCM it replaces',
        bytes > 1000 && bytes < pcm * 0.8,
        `${(bytes / 1e6).toFixed(2)} МБ против ${(pcm / 1e6).toFixed(2)} МБ PCM`)
  // сжатие БЕЗ ПОТЕРЬ — на этом стоит посемпловая точность склейки
  const rawOf = (f) => execFileSync('ffmpeg', ['-v', 'error', '-i', f,
    '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { maxBuffer: 1 << 28 })
  const viaWav = `${DIR}/roundtrip.wav`
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', one.r.path, '-c:a', 'pcm_s16le', viaWav])
  check('and decoding it gives back the very same samples',
        Buffer.compare(rawOf(one.r.path), rawOf(viaWav)) === 0)
  check('the script lands beside it without the audio extension in the name',
        one.r.scriptPath.endsWith('.script.txt') && !/\.flac\.script/.test(one.r.scriptPath),
        one.r.scriptPath)

  // превью читает файл через kadr:// — формат обязан проигрываться элементом,
  // иначе озвучка молча не звучала бы (Content-Type схема не отдаёт вовсе)
  const playable = await evalJs(`(async () => {
    const el = document.createElement('video')
    el.crossOrigin = 'anonymous'
    el.preload = 'metadata'
    el.src = window.kadr.fileUrl(${JSON.stringify('__PATH__')})
    return await new Promise((res) => {
      const done = (ok) => res({ ok, duration: el.duration, err: el.error && el.error.code })
      el.onloadedmetadata = () => done(true)
      el.onerror = () => done(false)
      setTimeout(() => done(false), 8000)
    })
  })()`.replace('"__PATH__"', JSON.stringify(one.r.path)), { timeout: 30000 })
  check('and a media element can actually open it',
        playable.ok && Math.abs(playable.duration - one.r.duration) < 0.05,
        JSON.stringify(playable))
  const wf = await evalJs(`(() => {
    const a = window.kadrEditor.useEditor.getState().project.assets[0]
    return { has: !!(a && a.waveform), rate: a && a.waveform && a.waveform.rate }
  })()`)
  check('and the timeline waveform was read from it as well', wf.has, JSON.stringify(wf))

  // ---- 4. the script on disk is exactly what was synthesised
  const scriptOnDisk = existsSync(one.r.scriptPath) ? readFileSync(one.r.scriptPath, 'utf8') : null
  check('a .script.txt is written next to the audio', scriptOnDisk !== null, one.r.scriptPath)
  check('it holds the normalised script verbatim', scriptOnDisk === SCRIPT + '\n',
        JSON.stringify(String(scriptOnDisk).slice(0, 40)))
  const hash = scriptOnDisk === null ? '' : createHash('sha1').update(scriptOnDisk, 'utf8').digest('hex')
  const run = await evalJs(`window.kadrEditor.useEditor.getState().project.voiceRuns[0]`)
  check('the run stores the sha1 of that exact file', run.scriptHash === hash,
        `${String(run.scriptHash).slice(0, 12)} против ${hash.slice(0, 12)}`)
  check('the script is registered as a project text', one.texts.includes(one.r.scriptPath))
  check('the run remembers no speed-up when the option is off', run.tempo === 1, String(run.tempo))
  check('the run remembers the voice and model it used',
        run.tts?.voiceId === 'mock-voice-1' && run.tts?.modelId === 'eleven_multilingual_v2')

  // ---- 5. undo takes the whole landing back in one step
  const undone = await evalJs(`(async () => {
    const st = () => window.kadrEditor.useEditor.getState()
    st().undo()
    const p = st().project
    return { assets: p.assets.length, runs: (p.voiceRuns || []).length,
             texts: (p.texts || []).length,
             clips: p.tracks.reduce((n, t) => n + t.clips.length, 0) }
  })()`)
  check('one undo removes clip, asset, script doc and run together',
        undone.assets === 0 && undone.runs === 0 && undone.texts === 0 && undone.clips === 0,
        JSON.stringify(undone))
  await evalJs(`(() => { window.kadrEditor.useEditor.getState().redo(); return 1 })()`)

  // ---- 6. the speed-up: same text, shorter file, factor recorded on the run
  const sped = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().setPlayhead(0)
    const r = await E.speakText({ text: ${JSON.stringify(SCRIPT)}, dir: ${JSON.stringify(DIR)}, tempo: 1.25 })
    const run = st().project.voiceRuns.find((v) => v.id === r.runId)
    return { duration: r.duration, tempo: run.tempo, path: r.path }
  })()`)
  check('the sped-up take is 1.25x shorter',
        Math.abs(sped.duration - one.r.duration / 1.25) < 0.05,
        `${sped.duration.toFixed(3)} против ${(one.r.duration / 1.25).toFixed(3)}`)
  check('the factor is stored on the run, not just in the settings', sped.tempo === 1.25, String(sped.tempo))
  check('the second take did not overwrite the first', sped.path !== one.r.path,
        `${sped.path.split('/').pop()} / ${one.r.path.split('/').pop()}`)

  // ---- 6b. ускорение берётся из ГАЛОЧКИ, а не только из явного параметра
  // (у пользователя оказалось tempoEnabled=true при tempo=1 — галочка стояла,
  //  а ускорения не было; заодно ловим и такое сочетание)
  const fromSettings = await evalJs(`(async () => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    E.useTtsSettings.getState().update({ tempoEnabled: true, tempo: 1.2 })
    st().setPlayhead(0)
    const withBox = await E.speakText({ text: ${JSON.stringify(SCRIPT)}, dir: ${JSON.stringify(DIR)} })
    const run1 = st().project.voiceRuns.find((v) => v.id === withBox.runId)
    E.useTtsSettings.getState().update({ tempoEnabled: false })
    const without = await E.speakText({ text: ${JSON.stringify(SCRIPT)}, dir: ${JSON.stringify(DIR)} })
    const run2 = st().project.voiceRuns.find((v) => v.id === without.runId)
    return { on: withBox.duration, onTempo: run1.tempo,
             off: without.duration, offTempo: run2.tempo }
  })()`)
  check('the checkbox alone speeds the take up',
        Math.abs(fromSettings.on - fromSettings.off / 1.2) < 0.05 &&
        fromSettings.onTempo === 1.2 && fromSettings.offTempo === 1,
        JSON.stringify(fromSettings))

  // ---- 7. length tracks the text, so chunk-sized scripts are not silently truncated
  const long = await evalJs(`(async () => {
    const E = window.kadrEditor
    const text = Array.from({ length: 40 }, (_, i) =>
      'Предложение номер ' + i + ', достаточно длинное для проверки объёма.').join(' ')
    const r = await E.speakText({ text, dir: ${JSON.stringify(DIR)}, at: 60 })
    return { duration: r.duration, chars: text.length }
  })()`)
  check('a long script produces proportionally long audio',
        long.duration > one.r.duration * 8, `${long.duration.toFixed(1)} с на ${long.chars} символов`)

  // ---- 8. corrupt settings must not white-screen the editor
  // (a null written by a careless restore did exactly that; same class as the
  // scalar-Anim bug sanitizeProject exists for)
  const survived = await evalJs(`(async () => {
    const E = window.kadrEditor
    const before = E.useTtsSettings.getState().settings
    for (const junk of [null, 42, 'nonsense', [], { stability: 'высокая', tempo: NaN }]) {
      E.useTtsSettings.setState({ settings: junk })
      E.useTtsUi.getState().openSettings()
      await new Promise((r) => setTimeout(r, 150))
      const alive = document.getElementById('root')?.childElementCount > 0
      const shown = !!document.querySelector('.modal')
      E.useTtsUi.getState().closeSettings()
      await new Promise((r) => setTimeout(r, 80))
      if (!alive || !shown) return { ok: false, junk: JSON.stringify(junk) }
    }
    E.useTtsSettings.setState({ settings: before })
    return { ok: true }
  })()`)
  check('corrupt settings do not take the editor down', survived.ok === true,
        survived.ok ? '' : 'упало на ' + survived.junk)

  const healed = await evalJs(`(() => {
    const s = window.kadrEditor.sanitizeTtsSettings({ stability: 'высокая', tempo: NaN, style: 99 })
    return { stability: s.stability, tempo: s.tempo, style: s.style, model: s.modelId }
  })()`)
  check('the sanitizer replaces nonsense with usable numbers',
        healed.stability === 0.5 && healed.tempo === 1.1 && healed.style === 1 && !!healed.model,
        JSON.stringify(healed))

  // ---- 9. a refusal inside main must not wedge the module
  // (the busy flag used to go up before the last validation, so one rejected
  // call made every later synthesis fail with "синтез уже идёт")
  const wedge = await evalJs(`(async () => {
    let first = 'no error'
    try {
      await window.kadr.ttsSpeak({ text: '   ', outPath: ${JSON.stringify(DIR + '/wedge.wav')},
                                   params: window.kadrEditor.ttsParams(), tempo: 1 })
    } catch (e) { first = String(e.message || e) }
    let second = 'ok'
    try {
      await window.kadrEditor.speakText({ text: 'Проверка после отказа.', dir: ${JSON.stringify(DIR)} })
    } catch (e) { second = String(e.message || e) }
    return { first, second }
  })()`)
  check('main refuses an empty script', /пуст/i.test(wedge.first), wedge.first)
  check('and a refusal leaves the module usable', wedge.second === 'ok', wedge.second)

  // ---- 10. empty input is refused before any file is touched
  const empty = await evalJs(`(async () => {
    try { await window.kadrEditor.speakText({ text: '   ', dir: ${JSON.stringify(DIR)} }); return 'no error' }
    catch (e) { return String(e.message || e) }
  })()`)
  check('empty text is refused', /пуст/i.test(empty), empty)
} finally {
  await evalJs(`(async () => {
    const { v } = JSON.parse(${JSON.stringify(saved)})
    const E = window.kadrEditor
    // no store before the suite ran → put back sane defaults, never null
    const settings = E.sanitizeTtsSettings(v)
    await window.kadr.writeUserStore('tts-settings', settings)
    E.useTtsSettings.setState({ settings })
    try { localStorage.setItem('kadr.ttsSettings', JSON.stringify(settings)) } catch {}
    return 1
  })()`).catch(() => { /* best effort */ })
  ws.close()
}
console.log('e2e36 finished')
