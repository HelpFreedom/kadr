// Test: the training corpus (stage 4).
//
// Two halves. In the app: the user's verdicts reach disk in ttsqc's own format,
// and hand-placed marks land in a SEPARATE file. Outside it: the driver's learn
// command, including a demonstration of why that separation exists — an
// unmatched row inside verdicts.json makes ttsqc discard the whole round.
//
// Launch: npx electron-vite dev -- --remote-debugging-port=9777
import WebSocket from 'ws'
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'

const PORT = process.env.KADR_CDP_PORT || 9777
const ROOT = '/tmp/kadr-test/corpus'
const RUN = `${ROOT}/run-a`
const PY = process.env.KADR_TTSQC_PYTHON || 'python3.11'
const DRIVER = new URL('./ttsqc_run.py', import.meta.url).pathname

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
    ` catch (e) { window.__e2e.${key} = JSON.stringify({ err: String((e && e.message) || e) }) } })(); 0`)
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

/** A candidate shaped exactly like ttsqc writes them, with real-looking evidence. */
const candidate = (i) => ({
  id: `d${String(i).padStart(3, '0')}`,
  class: i % 3 === 0 ? 'corrupt' : 'insert',
  tier: 'must-review',
  confidence: 0.3 + (i % 7) / 10,
  words: [i * 3, i * 3 + 2],
  audio: [i * 2 + 1, i * 2 + 1.6],
  play: [i * 2, i * 2 + 3],
  text: `слово ${i}`,
  context_before: 'до',
  context_after: 'после',
  evidence: { 'звучит': `абра${i}`, 'сходство': 0.4, 'voiced': 0.8, 'star_s': 0.2,
              's1': 0.5, 's2_long': 0.1, 'каналов': 1, 'правило': 0.5,
              'опоздание': 0.0, 'похоже_на_текст': 0.3 }
})

function corpus(dir, audio, n, { verdicts = true, poison = 0 } = {}) {
  mkdirSync(dir, { recursive: true })
  const defects = Array.from({ length: n }, (_, i) => candidate(i))
  writeFileSync(`${dir}/defects.json`, JSON.stringify({
    audio, script: `${dir}/script.txt`, duration: n * 2 + 5, trust: 0.95,
    stats: {}, defects, suppressed: [], text_mismatches: []
  }))
  writeFileSync(`${dir}/script.txt`, 'сценарий\n')
  if (!verdicts) return
  const rows = defects.map((d, i) => ({
    id: d.id, t0: d.play[0], t1: d.play[1], a0: d.audio[0], a1: d.audio[1],
    verdict: i % 3 === 0 ? 'yes' : 'no', audio
  }))
  // строки без соответствующего флага: ttsqc выбрасывает ФАЙЛ ЦЕЛИКОМ, когда
  // доля сопоставленных падает НИЖЕ половины (train.py:134) — ровно половина
  // ещё проходит, поэтому порог проверяется с обеих сторон
  for (let i = 0; i < poison; i++) {
    rows.push({ id: `u${i}`, t0: 900 + i, t1: 901 + i, a0: 900 + i, a1: 900.5 + i,
                verdict: 'yes', audio })
  }
  writeFileSync(`${dir}/verdicts.json`, JSON.stringify(rows))
}

const learn = (runs, extra = []) => JSON.parse(
  execFileSync(PY, [DRIVER, 'learn', '--runs', runs, '--out', `${ROOT}/scorer.pkl`, '--dry', ...extra],
    { encoding: 'utf8' }).trim().split('\n').pop())

/** То же, но БЕЗ --dry: модель действительно пишется. Всегда в свой файл —
    рабочая модель общая с консольным ttsqc пользователя, тест её не трогает. */
const learnReal = (runs, out) => JSON.parse(
  execFileSync(PY, [DRIVER, 'learn', '--runs', runs, '--out', out],
    { encoding: 'utf8' }).trim().split('\n').pop())

rmSync(ROOT, { recursive: true, force: true })
mkdirSync(RUN, { recursive: true })
// прогону нужна «своя копия звука» — на неё ссылается каждая строка корпуса
writeFileSync(`${RUN}/voice.abc123.wav`, '')
writeFileSync(`${RUN}/defects.json`, JSON.stringify({
  audio: `${RUN}/voice.abc123.wav`, script: `${RUN}/script.txt`, duration: 60,
  trust: 0.9, stats: {}, defects: [candidate(1), candidate(2), candidate(3)],
  suppressed: [], text_mismatches: []
}))

ws = new WebSocket(await getPageWs())
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })

try {
  // ---- 1. verdicts reach disk in ttsqc's format
  await evalJs(`(() => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().setProject({ ...st().project,
      tracks: [{ id: 'T', kind: 'audio', name: 'A1', muted: false, locked: false, gain: 1, clips: [] }],
      assets: [{ id: 'VA', name: 'v.wav', path: '/tmp/kadr-test/corpus/live.wav', kind: 'audio',
                 duration: 60, width: 0, height: 0, fps: 30, hasAudio: true }],
      texts: [], defects: [],
      voiceRuns: [{ id: 'VR', assetId: 'VA', scriptPath: '${RUN}/script.txt', scriptHash: '',
        runDir: '${RUN}', duration: 60, tempo: 1, createdAt: Date.now() }] }, null)
    const p = st().project
    p.tracks[0].clips.push({ id: 'CV', assetId: 'VA', kind: 'media', start: 0, duration: 60,
      inPoint: 0, label: 'v', ...E.newClipDefaults() })
    const mk = (i, state) => ({ id: 'k' + i, runId: 'VR', assetId: 'VA', origin: 'detector',
      detectorId: 'd00' + i, cls: 'insert', confidence: 0.5,
      play: [i * 2, i * 2 + 3], src: [i * 2 + 1, i * 2 + 1.6], state,
      phrase: { t0: i * 2 - 0.5, t1: i * 2 + 3.5, sentFrom: i, sentTo: i, wordFrom: 0, wordTo: 2,
        charFrom: 0, charTo: 5, text: 'ф', cut: ['silence', 'silence'] } })
    st().applyCheckResult('VR', {}, [mk(1, 'confirmed'), mk(2, 'rejected'), mk(3, 'proposed')])
    return 1
  })()`)
  const flushed = await evalJs(`window.kadrEditor.flushVerdicts('VR')`)
  check('the flush reports what it wrote', flushed && flushed.verdicts === 2 && flushed.marks === 0,
        JSON.stringify(flushed))

  const rows = JSON.parse(readFileSync(`${RUN}/verdicts.json`, 'utf8'))
  check('only decided defects are written', rows.length === 2, String(rows.length))
  check('confirmed becomes yes, rejected becomes no',
        rows.find((r) => r.id === 'd001')?.verdict === 'yes' &&
        rows.find((r) => r.id === 'd002')?.verdict === 'no', JSON.stringify(rows.map((r) => r.verdict)))
  check('t0/t1 are the play span the detector reported, not our phrase',
        rows[0].t0 === 2 && rows[0].t1 === 5, `${rows[0].t0}..${rows[0].t1}`)
  check('a0/a1 are the defect span', rows[0].a0 === 3 && rows[0].a1 === 3.6,
        `${rows[0].a0}..${rows[0].a1}`)
  check('audio points at the own copy of the run, not the timeline asset',
        rows.every((r) => r.audio === `${RUN}/voice.abc123.wav`), rows[0].audio)

  // ---- 2. a hand-placed mark NEVER goes into verdicts.json
  await evalJs(`(() => {
    const E = window.kadrEditor, st = () => E.useEditor.getState()
    st().addUserDefect({ id: 'mine', runId: 'VR', assetId: 'VA', origin: 'user', cls: 'user',
      words: [7, 9], src: [40, 40.4], state: 'proposed',
      phrase: { t0: 39, t1: 42, sentFrom: 9, sentTo: 9, wordFrom: 7, wordTo: 9,
        charFrom: 0, charTo: 5, text: 'ф', cut: ['silence', 'silence'] } })
    return 1
  })()`)
  const flushed2 = await evalJs(`window.kadrEditor.flushVerdicts('VR')`)
  const rows2 = JSON.parse(readFileSync(`${RUN}/verdicts.json`, 'utf8'))
  const marks = JSON.parse(readFileSync(`${RUN}/user_marks.json`, 'utf8'))
  check('the mark is counted separately', flushed2.marks === 1 && flushed2.verdicts === 2,
        JSON.stringify(flushed2))
  check('and it is NOT in verdicts.json', !rows2.some((r) => r.id === 'mine'),
        rows2.map((r) => r.id).join(','))
  check('it is in user_marks.json with its own span',
        marks.length === 1 && marks[0].a0 === 40 && marks[0].a1 === 40.4, JSON.stringify(marks))

  // ---- 3. a verdict flushes on its own shortly after the click
  rmSync(`${RUN}/verdicts.json`, { force: true })
  await evalJs(`(async () => {
    window.kadrEditor.setVerdict('k3', true)
    await new Promise((r) => setTimeout(r, 2500))
    return 1
  })()`)
  check('a verdict reaches the corpus without anyone asking', existsSync(`${RUN}/verdicts.json`) &&
        JSON.parse(readFileSync(`${RUN}/verdicts.json`, 'utf8')).length === 3,
        existsSync(`${RUN}/verdicts.json`) ? 'есть' : 'нет файла')

  // ---- 4. the status report is well formed
  // NB здесь НЕЛЬЗЯ ждать «данных мало»: корпус в userData общий с работой
  // пользователя и растёт от его же разметки. Проверяем инвариант, а сам отказ
  // ниже порога — на изолированном корпусе (см. часть 7).
  const status = await evalJs(`window.kadrEditor.learnStatus()`, { timeout: 120000 })
  check('the status report comes back with numbers',
        typeof status?.examples === 'number' && typeof status?.files === 'number' &&
        typeof status?.userMatched === 'number', JSON.stringify(status))
  check('a refusal always carries its reason, and a readiness never does',
        status.ok ? !status.problem : /не меньше/.test(status.problem || ''),
        `ok=${status.ok} problem=${status.problem ?? '—'}`)
  check('a readiness comes with cross-validation numbers',
        status.ok ? !!status.crossVal : true, JSON.stringify(status.crossVal))

  // ---- 4b. окно обучения обязано объяснять, что происходит
  const panel = await evalJs(`(async () => {
    const E = window.kadrEditor
    E.useDefectsUi.getState().setOpen(true)
    // самопроверка детектора поднимает python с torch — это секунды
    const line = () => [...document.querySelectorAll('.modal .hint-inline')]
      .map((d) => d.textContent)
    for (let i = 0; i < 200; i++) {
      await new Promise((r) => setTimeout(r, 250))
      if (line().some((x) => /Модель:/.test(x))) break
    }
    const texts = line()
    return {
      steps: [...document.querySelectorAll('.modal .df-step')].map((d) => d.textContent.trim()),
      explains: texts.some((x) => /число примеров то же/.test(x)),
      legend: texts.some((x) => /«просто перегенерировать»/.test(x)),
      splits: texts.some((x) => /Подтверждено к перегенерации/.test(x)),
      model: texts.find((x) => /Модель:/.test(x)) || '',
      env: await window.kadrEditor.selfTestDetector()
        .then((r) => (r.paths || {}).SCORER || '').catch(() => '')
    }
  })()`, { timeout: 120000 })
  check('the dialog is laid out as numbered steps', panel.steps.length === 5,
        panel.steps.join(' | '))
  check('it says outright why the example count does not move', panel.explains)
  check('it explains what the three kinds of mark mean', panel.legend)
  check('and how many of the confirmed ones will teach the detector', panel.splits)
  check('and names the model file with the moment it was written',
        /Модель:/.test(panel.model) && /записана|ещё не обучалась/.test(panel.model),
        panel.model.slice(0, 120))

  // Настоящее переобучение ЧЕРЕЗ КНОПКУ — только когда модель перенаправлена
  // в сторону: рабочая общая с консольным ttsqc пользователя, и тест не имеет
  // права её переписывать (эти наборы уже уничтожали его данные четырежды).
  if (panel.env && !panel.env.includes('/python/models/')) {
    const trained = await evalJs(`(async () => {
      const was = [...document.querySelectorAll('.modal .hint-inline')]
        .map((d) => d.textContent).find((x) => /Модель:/.test(x)) || ''
      const btn = () => [...document.querySelectorAll('.modal button')]
        .find((b) => /Переобучить модель/.test(b.textContent))
      // «Переобучить» доступна только когда корпус посчитан: это python с
      // numpy/sklearn поверх всех прогонов — десятки секунд
      for (let i = 0; i < 480 && (!btn() || btn().disabled); i++) {
        await new Promise((r) => setTimeout(r, 250))
      }
      if (!btn()) return { skipped: 'кнопки нет' }
      if (btn().disabled) return { skipped: 'кнопка так и осталась выключенной: ' + btn().title }
      btn().click()
      for (let i = 0; i < 400; i++) {
        await new Promise((r) => setTimeout(r, 250))
        if (document.querySelector('.modal .ln-done')) break
      }
      const done = document.querySelector('.modal .ln-done')
      // время файла модели обновляется отдельным перечитыванием самопроверки
      let now = was
      for (let i = 0; i < 120 && now === was; i++) {
        await new Promise((r) => setTimeout(r, 250))
        now = [...document.querySelectorAll('.modal .hint-inline')]
          .map((d) => d.textContent).find((x) => /Модель:/.test(x)) || ''
      }
      return { was, now, text: done ? done.textContent : '' }
    })()`, { timeout: 600000 })
    check('the button reports the rebuild, with the time',
          /Модель пересобрана/.test(trained.text) && /\d\d?:\d\d/.test(trained.text),
          trained.text || JSON.stringify(trained))
    check('and the model line now shows a newer file',
          !!trained.now && trained.now !== trained.was,
          `${String(trained.was).slice(-40)} → ${String(trained.now).slice(-40)}`)
  } else {
    console.log('SKIP  переобучение через окно — запустите приложение с ' +
                'KADR_TTSQC_SCORER=/tmp/kadr-test/scorer-test.pkl, иначе тест ' +
                'перезаписал бы рабочую модель пользователя')
  }
  await evalJs(`(() => { window.kadrEditor.useDefectsUi.getState().setOpen(false); return 1 })()`)
} finally {
  ws.close()
}

// ---- 5. the driver: a clean corpus trains, a poisoned one does not
const CLEAN = `${ROOT}/clean`
corpus(`${CLEAN}/r1`, `${CLEAN}/v1.wav`, 20)
corpus(`${CLEAN}/r2`, `${CLEAN}/v2.wav`, 20)
const clean = learn(CLEAN)
check('a clean corpus of two files is trainable', clean.ok === true && clean.files === 2,
      JSON.stringify({ ok: clean.ok, examples: clean.examples, files: clean.files }))

// вот зачем нужен отдельный файл. Ровно половина чужих строк ещё проходит —
// а одна лишняя уже выбрасывает ФАЙЛ ЦЕЛИКОМ, вместе с настоящими метками.
// В сессии, где пользователь много отмечает сам и мало отклоняет, это норма.
const EDGE = `${ROOT}/edge`
corpus(`${EDGE}/r1`, `${EDGE}/v1.wav`, 20, { poison: 20 })
corpus(`${EDGE}/r2`, `${EDGE}/v2.wav`, 20, { poison: 20 })
const edge = learn(EDGE)
check('exactly half unmatched still passes', edge.examples === clean.examples,
      `${edge.examples} против ${clean.examples}`)

const DIRTY = `${ROOT}/dirty`
corpus(`${DIRTY}/r1`, `${DIRTY}/v1.wav`, 20, { poison: 21 })
corpus(`${DIRTY}/r2`, `${DIRTY}/v2.wav`, 20, { poison: 21 })
const dirty = learn(DIRTY)
check('one unmatched row past half discards the whole file, real labels included',
      dirty.examples === 0 && clean.examples > 0,
      `чисто ${clean.examples}, ровно половина ${edge.examples}, на одну больше ${dirty.examples}`)

// ---- 6. hand-placed marks are counted, and only the matchable ones train
const MARKS = `${ROOT}/marks`
corpus(`${MARKS}/r1`, `${MARKS}/v1.wav`, 20)
corpus(`${MARKS}/r2`, `${MARKS}/v2.wav`, 20)
const hit = candidate(5).audio
writeFileSync(`${MARKS}/r1/user_marks.json`, JSON.stringify([
  { id: 'u-hit', a0: hit[0] + 0.05, a1: hit[1] - 0.05, audio: `${MARKS}/v1.wav` },
  { id: 'u-miss', a0: 500, a1: 500.5, audio: `${MARKS}/v1.wav` }
]))
const withMarks = learn(MARKS)
check('a mark on a candidate the generator made becomes a training row',
      withMarks.userMatched === 1, String(withMarks.userMatched))
check('a mark the generator never proposed is counted, not invented',
      withMarks.userUnmatched === 1 && withMarks.examples === clean.examples + 1,
      `${withMarks.userUnmatched} / ${withMarks.examples} против ${clean.examples}`)
check('and the model file was NOT written by a dry run', !existsSync(`${ROOT}/scorer.pkl`))

// ---- 7. отказ ниже порога — на своём корпусе, независимо от того, сколько
//         накопил пользователь
const TINY = `${ROOT}/tiny`
corpus(`${TINY}/r1`, `${TINY}/v1.wav`, 3)
const tiny = learn(TINY)
check('below the threshold training is refused with a reason',
      tiny.ok === false && /не меньше 30/.test(tiny.problem || ''), tiny.problem)
check('and one file is never enough, however many examples',
      (() => {
        const ONE = `${ROOT}/onefile`
        corpus(`${ONE}/r1`, `${ONE}/v1.wav`, 40)
        const r = learn(ONE)
        return r.ok === false && />=2/.test(r.problem || '')
      })(), 'перекрёстная проверка идёт по файлам')

// ---- 8. переобучение: что именно меняется
// Жалоба пользователя: «непонятно, точно ли переобучается — число примеров
// осталось прежним». Оно и не должно меняться: корпус тот же, пересобирается
// модель. Значит доказательством обязан быть ФАЙЛ, а не счётчик.
const REAL = `${ROOT}/real`
corpus(`${REAL}/r1`, `${REAL}/v1.wav`, 20)
corpus(`${REAL}/r2`, `${REAL}/v2.wav`, 20)
const OUT = `${ROOT}/real-scorer.pkl`
const dry = learn(REAL)
const first = learnReal(REAL, OUT)
check('a real retrain writes the model',
      first.ok === true && first.saved === OUT && existsSync(OUT), JSON.stringify(first.problem || ''))
check('and reports when and how big, so «done» is provable',
      first.savedAt > 0 && Math.abs(first.savedAt - statSync(OUT).mtimeMs) < 1500 &&
      first.savedSize === statSync(OUT).size,
      `${first.savedAt} / ${first.savedSize}`)
check('the example count is NOT what changes — the corpus is the same',
      first.examples === dry.examples && first.files === dry.files,
      `${dry.examples} → ${first.examples}`)
const before = readFileSync(OUT)
const second = learnReal(REAL, OUT)
check('a second retrain copies the previous model aside first',
      !!second.backup && existsSync(second.backup) &&
      Buffer.compare(readFileSync(second.backup), before) === 0, String(second.backup))

console.log('e2e39 finished')
