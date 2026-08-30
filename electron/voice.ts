// Defect detector: drives python/ttsqc through scripts/ttsqc_run.py.
//
// Same shape as electron/transcribe.ts — NDJSON on stdout, errors on stderr
// plus a non-zero exit, one job at a time — because this one is heavier still:
// it loads whisper large-v3 AND a CTC aligner onto a 6 GB card, and two of them
// at once would simply run out of memory.
//
// The driver's path is listed in claude.ts's stale-process sweep: an orphan
// holds several GB of VRAM and the next run would OOM behind it.
import { app, ipcMain, BrowserWindow } from 'electron'
import { spawn, ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { join, basename, extname, dirname, resolve } from 'path'
import { createHash } from 'crypto'
import type {
  VoiceCheckRequest, VoiceCheckResult, VoicePhraseRequest, VoiceSelfTest,
  RawDefect, DefectPhrase, SpliceRequest, SpliceResult,
  VoiceVerdictsRequest, VoiceLearnResult, VoiceReindexRequest,
  VoiceVersionsRequest, VoiceVersionsResult
} from '@shared/types'
import { spliceForward, toAnalysisTime, type SpliceUnitMap } from '@shared/voiceMap'
import { FFMPEG, FFPROBE, audioCodecArgs } from './ffmpeg'
import { execFile } from 'child_process'
import { promisify } from 'util'

/** python 3.11+ with torch and faster-whisper. Distributions still ship 3.9
    as `python3`, which cannot even import the package (tomllib), and the wheels
    are usually in a venv — hence the setting (voice-over settings → «Python»)
    and KADR_TTSQC_PYTHON. This default is only the last resort. */
const DEFAULT_PYTHON = 'python3.11'
const CACHE_DAYS = 14

const driver = () => join(app.getAppPath(), 'scripts', 'ttsqc_run.py')
const pythonFor = (want?: string) =>
  (want && want.trim()) || process.env.KADR_TTSQC_PYTHON || DEFAULT_PYTHON

/** One run directory per (audio, script) pair, so two analyses never land on
    top of each other — the trap ttsqc's own _protect() exists for. */
function runDirFor(audioPath: string, scriptPath: string): string {
  const tag = createHash('sha1').update(`${audioPath}|${scriptPath}`).digest('hex').slice(0, 8)
  const stem = basename(audioPath, extname(audioPath)).replace(/[^\p{L}\p{N}._-]/gu, '') || 'voice'
  return join(app.getPath('userData'), 'ttsqc-runs', `${stem}-${tag}`)
}

let current: { py: ChildProcess | null; cancelled: boolean } | null = null

interface RunOpts {
  args: string[]
  onLine?: (msg: Record<string, unknown>) => void
  python?: string
  /** register with the cancellable job. Only the long check does: a phrase
      lookup that stole the slot would make Cancel kill the wrong process. */
  cancellable?: boolean
}

/** Spawn the driver and parse its NDJSON. Resolves with the last `done`-ish
    line's payload; rejects with stderr on a non-zero exit. */
function runDriver(opts: RunOpts): Promise<void> {
  return new Promise((resolve, reject) => {
    const py = spawn(pythonFor(opts.python), [driver(), ...opts.args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, KADR_TTSQC_HOME: join(app.getAppPath(), 'python') }
    })
    if (opts.cancellable && current) current.py = py
    let buf = ''
    let err = ''
    py.stdout.on('data', (c) => {
      buf += c
      const lines = buf.split('\n')
      buf = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          opts.onLine?.(JSON.parse(line))
        } catch { /* partial or non-json line */ }
      }
    })
    py.stderr.on('data', (c) => { err += c })
    py.on('error', reject)
    py.on('close', (code) => {
      if (opts.cancellable && current) current.py = null
      if (opts.cancellable && current?.cancelled) reject(new Error('cancelled'))
      else if (code === 0) resolve()
      else reject(new Error(err.slice(-800).trim() || `ttsqc_run.py exited ${code}`))
    })
  })
}

async function selfTest(python?: string): Promise<VoiceSelfTest> {
  const box: { report: Record<string, unknown> | null } = { report: null }
  try {
    await runDriver({ args: ['--selftest'], python,
      onLine: (m) => { if (m.type === 'selftest') box.report = m } })
  } catch (e) {
    // exit code 2 is the documented "environment is not ready" answer, and the
    // report it printed on stdout is exactly what the user needs to see
    if (!box.report) {
      return { ok: false, python: pythonFor(python), problems: [String((e as Error).message)] }
    }
  }
  const r = (box.report ?? {}) as Record<string, unknown>
  return {
    ok: !!r.ok,
    python: String(r.executable ?? pythonFor(python)),
    problems: (r.problems as string[]) ?? [],
    cuda: r.cuda as VoiceSelfTest['cuda'],
    modules: r.modules as Record<string, string | null>,
    files: r.files as Record<string, boolean>,
    // какие именно файлы используются — в частности, ГДЕ лежит модель:
    // «переобучить» перезаписывает ровно её, и путь должен быть виден
    paths: r.paths as Record<string, string>,
    scorerMtime: r.scorerMtime as number | undefined
  }
}

async function check(win: BrowserWindow, req: VoiceCheckRequest): Promise<VoiceCheckResult> {
  if (current) throw new Error('разбор уже идёт')
  const job = { py: null as ChildProcess | null, cancelled: false }
  current = job
  const runDir = runDirFor(req.audioPath, req.scriptPath)
  const send = (progress: number, stage: string) =>
    win.webContents.send('voice:progress', { progress, stage })

  const defects: RawDefect[] = []
  let sentences: Array<[number, number, number]> = []
  const box: { done: Record<string, unknown> | null } = { done: null }
  try {
    send(0.01, 'start')
    await runDriver({
      python: req.python,
      cancellable: true,
      args: ['check',
        '--audio', req.audioPath,
        '--script', req.scriptPath,
        '--run-dir', runDir,
        '--device', req.device || 'cuda',
        '--max-flags', String(req.maxFlags ?? 40),
        '--min-confidence', String(req.minConfidence ?? 0),
        '--edge-words', String(req.edgeWords ?? 1)],
      onLine: (m) => {
        if (m.type === 'progress') send(Math.min(0.99, Number(m.p) || 0), String(m.stage || ''))
        else if (m.type === 'defect') defects.push(m as unknown as RawDefect)
        else if (m.type === 'sentences') sentences = (m.bounds as Array<[number, number, number]>) ?? []
        else if (m.type === 'done') box.done = m
      }
    })
    const done = box.done
    if (!done) throw new Error('разбор не сообщил о завершении')
    send(1, 'done')
    return {
      runDir,
      audio: String(done.audio ?? ''),
      duration: Number(done.duration) || 0,
      trust: Number(done.trust) || 0,
      stats: (done.stats as Record<string, unknown>) ?? {},
      defects,
      sentences
    }
  } finally {
    current = null
  }
}

async function phraseAt(req: VoicePhraseRequest):
  Promise<{ words: [number, number]; phrase: DefectPhrase }> {
  const box: { out: Record<string, unknown> | null } = { out: null }
  await runDriver({
    python: req.python,
    args: ['phrase-at', '--run-dir', req.runDir,
      '--start', String(req.start), '--end', String(req.end),
      '--edge-words', String(req.edgeWords ?? 1),
      // Страховка от рассинхрона: разбор описывает файл таким, каким он был в
      // момент проверки, а склейка его переписывает. Если reindex не отработал
      // (упал, приложение убили между склейкой и записью), отметка ушла бы в
      // координаты чужой версии — лучше громкий отказ, чем чужое предложение.
      ...(req.audioDuration ? ['--audio-duration', String(req.audioDuration)] : [])],
    onLine: (m) => { if (m.type === 'phrase') box.out = m }
  })
  const o = box.out
  if (!o) throw new Error('не удалось посчитать фразу')
  return { words: o.words as [number, number], phrase: o.phrase as DefectPhrase }
}

// ---------------------------------------------------------------------------
// splicing a regenerated phrase back in

const execFileP = promisify(execFile)
const afmt = (layout: 'mono' | 'stereo') =>
  `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=${layout}`

async function probeChannels(path: string): Promise<number> {
  const { stdout } = await execFileP(FFPROBE, ['-v', 'error', '-select_streams', 'a:0',
    '-show_entries', 'stream=channels', '-of', 'csv=p=0', path])
  return parseInt(stdout.trim(), 10) || 2
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await execFileP(FFPROBE, ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'csv=p=0', path])
  return parseFloat(stdout.trim()) || 0
}

type Piece = { kind: 'orig'; a: number; b: number } | { kind: 'patch'; i: number }

/** The output is head + patch + survivor + patch + … + tail, each joint an
    equal-power crossfade. Pieces that would be shorter than their own fades are
    a caller bug (units too close) — say so instead of producing a click. */
function plan(units: SpliceRequest['units'], duration: number):
  { pieces: Piece[]; fades: number[] } {
  const pieces: Piece[] = []
  const fades: number[] = []
  const sorted = [...units].sort((x, y) => x.cut0 - y.cut0)
  for (let i = 0; i < sorted.length; i++) {
    const u = sorted[i]
    const prev = sorted[i - 1]
    const a = prev ? prev.cut1 - prev.fade : 0
    const b = u.cut0 + u.fade
    const need = (prev ? prev.fade : 0) + u.fade
    if (b - a > need + 0.005) {
      pieces.push({ kind: 'orig', a, b })
      fades.push(u.fade)
    } else if (i > 0) {
      throw new Error(`фразы ${i} и ${i + 1} слишком близко (${(b - a).toFixed(3)} с) — ` +
        'их нужно было объединить в одну')
    }
    // cut0 at the very start of the file leaves no head to fade from: the
    // patch simply begins the output
    pieces.push({ kind: 'patch', i: units.indexOf(u) })
    const last = sorted[i + 1] ? null : u
    if (last) {
      const ta = last.cut1 - last.fade
      if (duration - ta > last.fade + 0.005) {
        fades.push(last.fade)
        pieces.push({ kind: 'orig', a: ta, b: duration })
      }
    } else {
      fades.push(u.fade)
    }
  }
  return { pieces, fades }
}

async function splice(req: SpliceRequest): Promise<SpliceResult> {
  if (!req.units.length) throw new Error('нечего вставлять')
  const duration = await probeDuration(req.src)
  if (!duration) throw new Error('исходный файл озвучки не читается')
  const { pieces, fades } = plan(req.units, duration)

  // Раскладку каналов берём У ИСХОДНИКА, а не навязываем стерео. Моно, поднятое
  // в стерео, ffmpeg умножает на 0.7071 (энергосохраняющая матрица) — измерено
  // ровно −3.01 дБ. В миксе экспорта это компенсируется, а в превью моно-озвучка
  // после склейки просто стала бы тише.
  const channels = await probeChannels(req.src)
  const layout: 'mono' | 'stereo' = channels === 1 ? 'mono' : 'stereo'
  // Заплатку приводим к раскладке ИСХОДНИКА копированием канала, а не матрицей
  // сведения: mono→stereo у ffmpeg умножает на 0.7071 (измерено ровно
  // −3.01 дБ), и свежая фраза легла бы тише той, которую заменяет. Синтез
  // теперь отдаёт моно (как и сам API), а в проекте могут лежать старые
  // стереофайлы — значит расходятся обе раскладки, и обе надо свести честно.
  const patchCh = await Promise.all(req.units.map((u) => probeChannels(u.patchPath)))
  const patchFmt = (ch: number) => {
    const pan = layout === 'mono' ? 'pan=mono|c0=c0'
      : ch === 1 ? 'pan=stereo|c0=c0|c1=c0' : 'pan=stereo|c0=c0|c1=c1'
    return `aformat=sample_fmts=fltp:sample_rates=48000,${pan}`
  }

  const args = ['-y', '-v', 'error', '-i', req.src]
  for (const u of req.units) args.push('-i', u.patchPath)

  const filters: string[] = []
  const origCount = pieces.filter((p) => p.kind === 'orig').length
  if (origCount > 0) filters.push(`[0:a]${afmt(layout)},asplit=${origCount}` +
    Array.from({ length: origCount }, (_, i) => `[o${i}]`).join(''))

  const labels: string[] = []
  let oi = 0
  pieces.forEach((p, k) => {
    const out = `p${k}`
    if (p.kind === 'orig') {
      // asetpts after EVERY atrim: without it the piece keeps the source's
      // timestamps and acrossfade joins at the wrong place
      filters.push(`[o${oi++}]atrim=start=${p.a.toFixed(4)}:end=${p.b.toFixed(4)},` +
        `asetpts=N/SR/TB[${out}]`)
    } else {
      const u = req.units[p.i]
      const gain = Math.abs(u.gainDb) > 0.01 ? `volume=${u.gainDb.toFixed(2)}dB,` : ''
      filters.push(`[${p.i + 1}:a]${patchFmt(patchCh[p.i])},${gain}asetpts=N/SR/TB[${out}]`)
    }
    labels.push(out)
  })

  let cur = labels[0]
  for (let k = 1; k < labels.length; k++) {
    const d = fades[k - 1] ?? 0.02
    const out = k === labels.length - 1 ? 'out' : `x${k}`
    filters.push(`[${cur}][${labels[k]}]acrossfade=d=${d.toFixed(4)}:c1=qsin:c2=qsin[${out}]`)
    cur = out
  }
  if (labels.length === 1) filters.push(`[${cur}]anull[out]`)

  args.push('-filter_complex', filters.join(';'), '-map', '[out]',
    '-ar', '48000', '-ac', String(layout === 'mono' ? 1 : 2),
    ...audioCodecArgs(req.out), req.out)
  await new Promise<void>((resolve, reject) => {
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve()
      : reject(new Error(`склейка не удалась: ${err.slice(-400)}`)))
  })

  // measured, never computed: resampling, atempo and mp3 padding move it by ms
  const outDur = await probeDuration(req.out)
  if (!outDur) throw new Error('склейка дала пустой файл')

  // where each joint ended up, and how big a level step it left
  const seams: SpliceResult['seams'] = []
  let acc = 0
  for (let k = 0; k < labels.length; k++) {
    const p = pieces[k]
    const len = p.kind === 'orig' ? p.b - p.a : await probeDuration(req.units[p.i].patchPath)
    if (k === 0) { acc = len; continue }
    const d = fades[k - 1] ?? 0.02
    const at = acc - d / 2
    const here = await windowStats(req.out, at, 0.02)
    const around = await windowStats(req.out, at, 1.0)
    // Щелчок — это когда стык стал худшим разрывом в своей секунде. Но там, где
    // вокруг тишина, других разрывов просто нет, и один этот критерий даёт
    // ложную тревогу; поэтому разрыв, который на 26 дБ тише окружающего
    // сигнала, считается замаскированным.
    const masked = here.step < around.peak * 0.05
    seams.push({ at: Math.round(at * 1000) / 1000, jumpDb: await seamJump(req.out, at),
                 step: here.step, stepAround: around.step, peakAround: around.peak,
                 clean: here.step < around.step || masked })
    acc = acc + len - d
  }
  return { path: req.out, duration: outDur, seams }
}

/**
 * Is this joint audible?
 *
 * NOT the level step: a seam sits at a sentence boundary, where the level
 * legitimately swings 20 dB and more — measured on a real voice-over, a
 * perfectly clean seam reported 9.5 dB and the untouched original showed the
 * same. What is actually heard is a DISCONTINUITY, so the test is whether the
 * biggest sample-to-sample jump at the joint is worse than the worst jump in
 * the second around it.
 */
async function seamJump(file: string, at: number): Promise<number> {
  const mean = async (from: number, dur: number) => {
    const out = await new Promise<string>((resolve) => {
      const child = spawn(FFMPEG, ['-v', 'info', '-nostats', '-ss', from.toFixed(3),
        '-t', dur.toFixed(3), '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
        { stdio: ['ignore', 'ignore', 'pipe'] })
      let err = ''
      child.stderr.on('data', (c) => { err += c })
      child.on('close', () => resolve(err))
      child.on('error', () => resolve(''))
    })
    const m = /mean_volume:\s*(-?[\d.]+)/.exec(out)
    return m ? parseFloat(m[1]) : -91
  }
  const before = await mean(Math.max(0, at - 0.03), 0.03)
  const after = await mean(at, 0.03)
  return Math.round(Math.abs(before - after) * 10) / 10
}

/**
 * The silence run that contains `at`, in absolute seconds.
 *
 * A patch has to carry the same pause at its edges that the audio it replaces
 * had, or the rhythm at the joint changes: measured on a real voice-over, the
 * pause at a sentence boundary was only 76 ms, and a patch that ended right
 * after its last word ate most of it.
 */
async function silenceAt(path: string, at: number, window = 1.5):
  Promise<{ from: number; to: number }> {
  const from = Math.max(0, at - window)
  const err = await new Promise<string>((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'info', '-nostats', '-ss', from.toFixed(3),
      '-t', (window * 2).toFixed(3), '-i', path,
      '-af', 'silencedetect=n=-45dB:d=0.02', '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'] })
    let out = ''
    child.stderr.on('data', (c) => { out += c })
    child.on('close', () => resolve(out))
    child.on('error', () => resolve(''))
  })
  const starts = [...err.matchAll(/silence_start:\s*(-?[\d.]+)/g)].map((m) => from + parseFloat(m[1]))
  const ends = [...err.matchAll(/silence_end:\s*([\d.]+)/g)].map((m) => from + parseFloat(m[1]))
  for (let i = 0; i < starts.length; i++) {
    const a = starts[i]
    const b = ends[i] ?? (from + window * 2)
    if (at >= a - 1e-3 && at <= b + 1e-3) return { from: a, to: b }
  }
  return { from: at, to: at }          // тишины нет — рез идёт через звук
}

/** Biggest jump between neighbouring samples in a window, and the window's own
    peak — a discontinuity far below the signal around it is masked. */
async function windowStats(file: string, at: number, dur: number):
  Promise<{ step: number; peak: number }> {
  const from = Math.max(0, at - dur / 2)
  const buf = await new Promise<Buffer>((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-ss', from.toFixed(4), '-t', dur.toFixed(4),
      '-i', file, '-f', 's16le', '-ac', '1', '-ar', '48000', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    const parts: Buffer[] = []
    child.stdout.on('data', (c) => parts.push(c))
    child.on('close', () => resolve(Buffer.concat(parts)))
    child.on('error', () => resolve(Buffer.alloc(0)))
  })
  let step = 0
  let peak = 0
  for (let i = 2; i + 1 < buf.length; i += 2) {
    const v = buf.readInt16LE(i)
    step = Math.max(step, Math.abs(v - buf.readInt16LE(i - 2)))
    peak = Math.max(peak, Math.abs(v))
  }
  return { step, peak }
}

// ---------------------------------------------------------------------------
// the training corpus

/**
 * Write the user's decisions next to the run they belong to.
 *
 * The `audio` field of every row is stamped here from the run's own
 * defects.json — never from the timeline asset. ttsqc groups training rows by
 * audio file and re-reads it; pointing at the live clip would mean retraining
 * on sound that a splice has since changed. Its report/html.py learnt that the
 * hard way, which is why cmd_check has a _protect() at all.
 */
/** Whole file or nothing: a half-written index is worse than a stale one. */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = path + '.part'
  await fs.writeFile(tmp, JSON.stringify(data), 'utf8')
  await fs.rename(tmp, path)
}

const VAD_HOP = 512 / 16000
/** разбор в том виде, в каком его посчитали модели — НИКОГДА не переписывается */
const BASE_INDEX = 'phrase-index.json'
/** он же, перенесённый на текущую версию файла склейками */
const CUR_INDEX = 'phrase-index.cur.json'

interface PhraseIndex {
  duration: number
  audio: string
  sents: number[]
  charRanges: number[][]
  wordTimes: Record<string, [number, number]>
  speechP?: number[]
  splices?: SpliceUnitMap[][]
}

async function readIndex(runDir: string, name: string): Promise<PhraseIndex | null> {
  try {
    return JSON.parse(await fs.readFile(join(runDir, name), 'utf8')) as PhraseIndex
  } catch {
    return null
  }
}

/**
 * Карты склеек для файла ТАКОЙ длительности, или null — «эта версия звука
 * разбору неизвестна».
 *
 * Обе версии живут рядом намеренно: отмена перегенерации возвращает проект к
 * исходному файлу, а индекс на диске откатить некому. Держим базовый и текущий
 * — и по длительности узнаём, о котором идёт речь.
 */
async function chainFor(runDir: string, duration?: number):
  Promise<SpliceUnitMap[][] | null> {
  const cur = await readIndex(runDir, CUR_INDEX)
  const base = await readIndex(runDir, BASE_INDEX)
  // Разбора рядом нет вовсе (старый прогон, до появления индекса) — значит и
  // склеек по нему не делали: координаты и есть разобранные. Отличать надо
  // именно случай «разбор ЕСТЬ, но описывает другую версию».
  if (!cur && !base) return []
  const fits = (i: PhraseIndex | null) =>
    !!i && (!duration || Math.abs(i.duration - duration) <= 0.05)
  if (fits(cur)) return cur!.splices ?? []
  if (fits(base)) return []
  return null
}

/**
 * Перенести разбор на файл, который только что получился из склейки.
 *
 * Что меняется, а что нет:
 *  * времена слов сдвигаются по той же карте, что и весь остальной проект;
 *    внутри заменённого участка — линейно: там тот же текст, другой дубль;
 *  * `speechP` пересобирается по той же карте, а на заменённых участках
 *    остаётся нулевым: этого дубля Silero не слышал, и врать за него нельзя —
 *    ноль просто означает «решает один порог RMS»;
 *  * рядом кладётся моно-копия 16 кГц НОВОГО файла: точка реза обязана
 *    попадать в тишину того звука, который и будут резать;
 *  * `defects.json`, его копия звука и базовый индекс НЕ трогаются — это корпус
 *    обучения, он должен продолжать описывать разобранную версию (ловушка
 *    _protect в самом ttsqc);
 *  * применённые карты копятся в `splices`, чтобы координаты ручных отметок
 *    можно было перевести обратно в разобранное время при выгрузке вердиктов.
 */
async function reindex(req: VoiceReindexRequest): Promise<{ duration: number; splices: number }> {
  const idx = (await readIndex(req.runDir, CUR_INDEX)) ?? (await readIndex(req.runDir, BASE_INDEX))
  if (!idx) throw new Error('в прогоне нет разбора — переразберите озвучку')
  const units: SpliceUnitMap[] = req.units.map((u) => ({
    cut0: u.cut0, cut1: u.cut1, patchDur: u.patchDur
  }))

  const audio = join(req.runDir, 'phrase-audio.wav')
  const tmp = audio + '.part'
  // -f wav обязателен: имя кончается на .part, и по расширению формат не
  // выводится («Unable to find a suitable output format»)
  await execFileP(FFMPEG, ['-y', '-v', 'error', '-i', req.audio,
    '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', '-f', 'wav', tmp])
  await fs.rename(tmp, audio)

  const wordTimes: Record<string, [number, number]> = {}
  for (const [k, v] of Object.entries(idx.wordTimes ?? {})) {
    const a = spliceForward(units, Number(v[0]))
    const b = spliceForward(units, Number(v[1]))
    wordTimes[k] = [Math.round(a * 1e4) / 1e4, Math.round(Math.max(a, b) * 1e4) / 1e4]
  }

  let speechP: number[] = []
  const old = idx.speechP ?? []
  if (old.length) {
    const n = Math.ceil(req.duration / VAD_HOP)
    speechP = new Array(n).fill(0)
    for (let i = 0; i < n; i++) {
      const backTo = toAnalysisTime([units], (i + 0.5) * VAD_HOP)
      if (backTo === null) continue
      const j = Math.floor(backTo / VAD_HOP)
      if (j >= 0 && j < old.length) speechP[i] = old[j]
    }
  }

  const splices = [...(idx.splices ?? []), units]
  await writeJsonAtomic(join(req.runDir, CUR_INDEX), {
    ...idx, audio, duration: Math.round(req.duration * 1e3) / 1e3, wordTimes, speechP, splices
  })
  return { duration: req.duration, splices: splices.length }
}

async function writeVerdicts(req: VoiceVerdictsRequest):
  Promise<{ verdicts: number; marks: number; droppedMarks: number }> {
  const dir = req.runDir
  const payload = JSON.parse(await fs.readFile(join(dir, 'defects.json'), 'utf8'))
  const audio = String(payload.audio || '')
  if (!audio) throw new Error('в разборе нет копии звука — переразберите озвучку')

  // Строка корпуса указывает на КОПИЮ РАЗОБРАННОГО звука, а времена в проекте
  // живут в координатах текущего файла. После каждой склейки они расходятся,
  // поэтому здесь их переводят обратно — иначе детектор учился бы по другому
  // месту записи, чем показал пользователь.
  const chain = await chainFor(dir, req.audioDuration)
  const back = (t: number) => (chain ? toAnalysisTime(chain, t) : null)

  const rows = req.verdicts.map((v) => {
    // t0/t1 — это `play` детектора verbatim, он уже в координатах разбора и
    // никогда не переписывается; a0/a1 справочные, но врать и им незачем
    const a0 = back(v.a0)
    const a1 = back(v.a1)
    return {
      id: v.id, t0: v.t0, t1: v.t1,
      a0: a0 ?? v.t0, a1: a1 ?? v.t1, verdict: v.verdict, audio
    }
  })
  let droppedMarks = 0
  const marks: Array<{ id: string; a0: number; a1: number
                       words?: [number, number]; audio: string }> = []
  for (const m of req.marks) {
    const a0 = back(m.a0)
    const a1 = back(m.a1)
    // отметка внутри уже заменённого куска: в разобранном звуке этого дубля
    // просто нет. Придумать ей координату значит отравить обучение.
    if (a0 === null || a1 === null) { droppedMarks++; continue }
    marks.push({ id: m.id, a0, a1, words: m.words, audio })
  }
  const write = async (name: string, data: unknown) => {
    const tmp = join(dir, name + '.part')
    await fs.writeFile(tmp, JSON.stringify(data, null, 1), 'utf8')
    await fs.rename(tmp, join(dir, name))     // целиком или никак
  }
  await write('verdicts.json', rows)
  await write('user_marks.json', marks)
  return { verdicts: rows.length, marks: marks.length, droppedMarks }
}

/** `text.2.fix1.fix1.flac` → `text.2`; `text.2.wav` → `text.2`. */
function chainBase(file: string): string | null {
  const name = basename(file)
  const m = /^(.+?)((?:\.fix(?:\d+))+)?\.(wav|flac)$/i.exec(name)
  return m ? m[1] : null
}

/**
 * Промежуточные версии озвучки: посчитать или убрать.
 *
 * Удаляется только `<base>(.fixN)+.(wav|flac)` рядом с файлом, который проект
 * использует, и только если сам он проекту не нужен. Оригинал под шаблон не
 * подходит и остаётся всегда. Список путей на удаление рендерер не присылает —
 * он их и не мог бы прислать: правило целиком здесь.
 */
async function voiceVersions(req: VoiceVersionsRequest): Promise<VoiceVersionsResult> {
  const keep = new Set((req.keep || []).map((p) => resolve(p)))
  // папка → базовые имена цепочек, которые в ней используются
  const bases = new Map<string, Set<string>>()
  for (const p of keep) {
    const base = chainBase(p)
    if (!base) continue
    const dir = dirname(p)
    let set = bases.get(dir)
    if (!set) bases.set(dir, set = new Set())
    set.add(base)
  }

  const files: VoiceVersionsResult['files'] = []
  for (const [dir, set] of bases) {
    let names: string[]
    try {
      names = await fs.readdir(dir)
    } catch {
      continue                       // папку унесли — не наша забота
    }
    for (const name of names) {
      const m = /^(.+?)((?:\.fix(?:\d+))+)\.(wav|flac)$/i.exec(name)
      if (!m || !set.has(m[1])) continue
      const full = resolve(join(dir, name))
      if (keep.has(full)) continue   // версия всё ещё на таймлайне
      try {
        const st = await fs.stat(full)
        if (st.isFile()) files.push({ path: full, name, size: st.size, mtime: st.mtimeMs })
      } catch { /* исчез между readdir и stat */ }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const bytes = files.reduce((n, f) => n + f.size, 0)
  if (!req.apply) return { files, bytes }

  let removed = 0
  for (const f of files) {
    try {
      await fs.unlink(f.path)
      removed++
    } catch { /* уже нет — считаем как не удалённый, но и не ошибка */ }
  }
  return { files, bytes, removed }
}

async function learn(dry: boolean, python?: string): Promise<VoiceLearnResult> {
  const box: { r: Record<string, unknown> | null } = { r: null }
  // Куда писать модель. KADR_TTSQC_SCORER уже управляет тем, откуда её ЧИТАЕТ
  // анализ (python/ttsqc/paths.py) — писать надо туда же, иначе переобучение
  // молча обновляло бы не тот файл. Тестам это заодно даёт способ проверить
  // весь путь целиком, не трогая рабочую модель пользователя: она общая с его
  // консольным ttsqc.
  const scorer = process.env.KADR_TTSQC_SCORER ||
    join(app.getAppPath(), 'python', 'models', 'scorer.pkl')
  const args = ['learn',
    '--runs', join(app.getPath('userData'), 'ttsqc-runs'),
    '--out', scorer]
  if (dry) args.push('--dry')
  await runDriver({ args, python, onLine: (m) => { if (m.type === 'learn') box.r = m } })
  const r = box.r
  if (!r) throw new Error('обучение не вернуло отчёт')
  return {
    ok: !!r.ok,
    examples: Number(r.examples) || 0,
    positives: Number(r.positives) || 0,
    files: Number(r.files) || 0,
    userMatched: Number(r.userMatched) || 0,
    userUnmatched: Number(r.userUnmatched) || 0,
    runs: Number(r.runs) || 0,
    crossVal: r.crossVal as Record<string, number> | undefined,
    problem: r.problem as string | undefined,
    saved: r.saved as string | undefined,
    savedAt: r.savedAt as number | undefined,
    savedSize: r.savedSize as number | undefined,
    backup: r.backup as string | undefined
  }
}

/** The decoded-audio cache grows ~3.8 MB per minute of 16 kHz audio and this
    machine has little room to spare; entries are content-keyed, so dropping old
    ones only costs one re-decode. */
export async function pruneTtsqcCache(): Promise<void> {
  const dir = process.env.KADR_TTSQC_CACHE || join(app.getPath('home'), '.cache', 'kadr', 'ttsqc')
  const cutoff = Date.now() - CACHE_DAYS * 86400_000
  try {
    for (const name of await fs.readdir(dir)) {
      const p = join(dir, name)
      const st = await fs.stat(p).catch(() => null)
      if (st && st.isFile() && st.mtimeMs < cutoff) await fs.unlink(p).catch(() => { /* raced */ })
    }
  } catch { /* no cache yet */ }
}

export function registerVoiceIpc(getWin: () => BrowserWindow | null) {
  ipcMain.handle('voice:selftest', (_e, python?: string) => selfTest(python))
  ipcMain.handle('voice:check', (_e, req: VoiceCheckRequest) => {
    const win = getWin()
    if (!win) throw new Error('no window')
    return check(win, req)
  })
  ipcMain.handle('voice:cancel', () => {
    if (!current) return
    current.cancelled = true
    current.py?.kill('SIGKILL')
  })
  ipcMain.handle('voice:phrase-at', (_e, req: VoicePhraseRequest) => phraseAt(req))
  ipcMain.handle('voice:splice', (_e, req: SpliceRequest) => splice(req))
  ipcMain.handle('voice:silence-at', (_e, path: string, at: number) => silenceAt(path, at))
  ipcMain.handle('voice:verdicts', (_e, req: VoiceVerdictsRequest) => writeVerdicts(req))
  ipcMain.handle('voice:reindex', (_e, req: VoiceReindexRequest) => reindex(req))
  ipcMain.handle('voice:versions', (_e, req: VoiceVersionsRequest) => voiceVersions(req))
  ipcMain.handle('voice:learn', (_e, req?: { dry?: boolean; python?: string }) =>
    learn(!!req?.dry, req?.python))
  void pruneTtsqcCache()
}
