// ElevenLabs speech synthesis, main process only.
//
// The API key never reaches the renderer: the page is scriptable through
// kadr_eval, so a key held there would be readable by anything that can run JS
// in it. It lives in <userData>/elevenlabs-key.json (0600), and the renderer
// can only set it or ask whether one exists.
//
// Outbound requests go through Chromium's network stack, not Node's: node's
// own fetch ignores proxy environment variables entirely and would simply hang
// where the API is only reachable through a proxy.
import { app, ipcMain, session, BrowserWindow, Session } from 'electron'
import { spawn, execFile } from 'child_process'
import { promisify } from 'util'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createHash } from 'crypto'
import { FFMPEG, FFPROBE, atempoChain, audioCodecArgs } from './ffmpeg'
import type {
  TtsParams, TtsRequest, TtsResult, TtsVoice, PhraseSynthRequest, PhraseSynthResult
} from '@shared/types'
import { normalizeScript, chunkText, sentenceEnds } from '@shared/ttsText'
import { apiProxy, proxyRules } from '@shared/proxy'

const execFileP = promisify(execFile)
const API = 'https://api.elevenlabs.io'
const MOCK = process.env.KADR_TTS_MOCK === '1'

/** Per-request character caps. Beyond these the API rejects the call, so the
    text is cut at sentence ends and the pieces are stitched with
    previous_text/next_text. Unknown models get the conservative 10k. */
const MODEL_CHAR_LIMIT: Record<string, number> = {
  eleven_flash_v2_5: 40000,
  eleven_turbo_v2_5: 40000,
  eleven_multilingual_v2: 10000,
  eleven_monolingual_v1: 10000,
  eleven_v3: 3000
}
const CONTEXT_CHARS = 400

const keyPath = () => join(app.getPath('userData'), 'elevenlabs-key.json')

async function readKey(): Promise<string> {
  try {
    const raw = JSON.parse(await fs.readFile(keyPath(), 'utf8'))
    return typeof raw?.key === 'string' ? raw.key : ''
  } catch {
    return ''
  }
}

async function writeKey(key: string): Promise<void> {
  const p = keyPath()
  if (!key) {
    await fs.unlink(p).catch(() => { /* nothing to clear */ })
    return
  }
  // mode on the open(), not a chmod afterwards: between the two the file would
  // briefly be world-readable, and it already holds the secret by then
  await fs.writeFile(p, JSON.stringify({ key }), { encoding: 'utf8', mode: 0o600 })
}

// ---------------------------------------------------------------------------
// network

let job: { cancelled: boolean; abort: AbortController | null; ff: ReturnType<typeof spawn> | null } | null = null

function proxyNote(explicit?: string): string {
  const p = apiProxy(explicit, process.env)
  return p ? ` (через прокси ${p})` : ' (без прокси)'
}

/**
 * A session of our own for the API calls.
 *
 * net.fetch() always uses the DEFAULT session, whose proxy Chromium resolves on
 * its own — and it may pick HTTP_PROXY when only HTTPS_PROXY can reach the API,
 * turning a «503 Forwarding failure» page into «Unexpected token '<'». Guessing
 * is not acceptable for a paid API, so the proxy is set explicitly here and the
 * request goes through ses.fetch().
 */
let apiSes: Session | null = null
let apiSesProxy: string | null = null

async function apiSession(explicit?: string): Promise<Session> {
  const want = apiProxy(explicit, process.env)
  if (!apiSes) apiSes = session.fromPartition('kadr-tts')
  if (apiSesProxy !== want) {
    await apiSes.setProxy(want
      ? { proxyRules: proxyRules(want), proxyBypassRules: '<local>' }
      : { mode: 'direct' })
    apiSesProxy = want
  }
  return apiSes
}

async function callApi(path: string,
                       init: RequestInit & { key: string; proxy?: string; expect?: 'json' | 'audio' }
): Promise<Response> {
  const { key, proxy, expect, ...rest } = init
  const headers = { 'xi-api-key': key, ...(rest.headers as Record<string, string> | undefined) }
  let resp: Response
  try {
    const ses = await apiSession(proxy)
    resp = await ses.fetch(API + path, { ...rest, headers })
  } catch (e) {
    // never let the key reach a message: only the transport failure does
    throw new Error(`ElevenLabs недоступен${proxyNote(proxy)}: ${(e as Error).message}`)
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '')
    let detail = body.slice(0, 400)
    try {
      const j = JSON.parse(body)
      detail = typeof j?.detail === 'string' ? j.detail
        : j?.detail?.message ? String(j.detail.message) : detail
    } catch { /* not json */ }
    throw new Error(`ElevenLabs HTTP ${resp.status}${proxyNote(proxy)}: ${detail}`)
  }
  // A proxy that cannot reach the API answers with its own HTML page, sometimes
  // with a 2xx. Parsing that as JSON produced «Unexpected token '<'», which says
  // nothing about the real problem — so the type is checked here instead.
  const type = (resp.headers.get('content-type') || '').toLowerCase()
  const wantJson = expect === 'json'
  const bad = wantJson ? !type.includes('json')
    : expect === 'audio' ? type.includes('html') || type.includes('xml')
    : false
  if (bad) {
    const head = (await resp.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160)
    throw new Error(`вместо ответа ElevenLabs пришло «${type || 'без типа'}»${proxyNote(proxy)}. ` +
      `Похоже, запрос перехватил прокси. Начало ответа: ${head}`)
  }
  return resp
}

async function listVoices(proxy?: string): Promise<TtsVoice[]> {
  if (MOCK) {
    return [{ id: 'mock-voice-1', name: 'Мок-голос 1', category: 'mock' },
            { id: 'mock-voice-2', name: 'Мок-голос 2', category: 'mock' }]
  }
  const key = await readKey()
  if (!key) throw new Error('API-ключ не задан')
  const resp = await callApi('/v1/voices', { key, method: 'GET', proxy, expect: 'json' })
  const data = await resp.json() as { voices?: Array<Record<string, unknown>> }
  return (data.voices ?? []).map((v) => ({
    id: String(v.voice_id ?? ''),
    name: String(v.name ?? ''),
    category: v.category ? String(v.category) : undefined,
    previewUrl: v.preview_url ? String(v.preview_url) : undefined,
    labels: (v.labels as Record<string, string> | undefined) ?? undefined
  })).filter((v) => v.id)
}

/** One chunk → encoded audio bytes plus the request id (for stitching). */
interface Alignment { chars: string[]; t0: number[]; t1: number[] }

async function synthChunk(key: string, params: TtsParams, text: string,
                          prevText: string, nextText: string, prevIds: string[],
                          signal: AbortSignal,
                          opts: { timestamps?: boolean; seed?: number; proxy?: string } = {}
): Promise<{ audio: Buffer; requestId: string; alignment?: Alignment }> {
  const fmt = params.outputFormat || 'mp3_44100_128'
  const settings: Record<string, unknown> = {
    stability: params.stability,
    similarity_boost: params.similarityBoost
  }
  if (params.style !== undefined) settings.style = params.style
  if (params.speakerBoost !== undefined) settings.use_speaker_boost = params.speakerBoost
  if (params.speed !== undefined) settings.speed = params.speed

  const body: Record<string, unknown> = { text, model_id: params.modelId, voice_settings: settings }
  if (prevText) body.previous_text = prevText
  if (nextText) body.next_text = nextText
  if (prevIds.length) body.previous_request_ids = prevIds.slice(-3)
  if (opts.seed !== undefined) body.seed = opts.seed

  const path = `/v1/text-to-speech/${encodeURIComponent(params.voiceId)}` +
    (opts.timestamps ? '/with-timestamps' : '') +
    `?output_format=${encodeURIComponent(fmt)}`
  const resp = await callApi(path, {
    key, method: 'POST', signal, proxy: opts.proxy,
    expect: opts.timestamps ? 'json' : 'audio',
    headers: {
      'Content-Type': 'application/json',
      Accept: opts.timestamps ? 'application/json'
        : fmt.startsWith('pcm_') ? 'application/octet-stream' : 'audio/mpeg'
    },
    body: JSON.stringify(body)
  })
  const requestId = resp.headers.get('request-id') || ''
  if (opts.timestamps) {
    // the JSON variant hands back the audio base64-encoded next to a
    // per-character alignment — the only cheap way to notice that the model
    // dropped half the sentence
    const j = await resp.json() as Record<string, unknown>
    const audio = Buffer.from(String(j.audio_base64 ?? ''), 'base64')
    if (!audio.length) throw new Error('ElevenLabs вернул пустой ответ')
    const a = j.alignment as Record<string, unknown> | undefined
    const alignment = a && Array.isArray(a.characters) ? {
      chars: a.characters as string[],
      t0: (a.character_start_times_seconds as number[]) ?? [],
      t1: (a.character_end_times_seconds as number[]) ?? []
    } : undefined
    return { audio, requestId, alignment }
  }
  const audio = Buffer.from(await resp.arrayBuffer())
  if (!audio.length) throw new Error('ElevenLabs вернул пустой ответ')
  return { audio, requestId }
}

/**
 * Where speech actually starts and ends in a patch.
 *
 * Measured on the samples rather than parsed out of silencedetect: what has to
 * be answered is «where does the last SUSTAINED sound end», and a real
 * ElevenLabs take was seen to finish with an isolated 30 ms burst at −34 dB
 * after 100 ms of silence — its own tail artefact. Spliced in, that burst lands
 * inside the pause between two sentences and is heard as a tick. A run shorter
 * than MIN_RUN_S that stands alone at either edge is therefore not treated as
 * speech.
 */
const SPEECH_DB = -45
const MIN_RUN_S = 0.06

async function speechBounds(file: string, duration: number): Promise<[number, number]> {
  const buf = await new Promise<Buffer>((resolve) => {
    const child = spawn(FFMPEG, ['-v', 'error', '-i', file,
      '-f', 's16le', '-ac', '1', '-ar', '48000', '-'], { stdio: ['ignore', 'pipe', 'ignore'] })
    const parts: Buffer[] = []
    child.stdout.on('data', (c) => parts.push(c))
    child.on('close', () => resolve(Buffer.concat(parts)))
    child.on('error', () => resolve(Buffer.alloc(0)))
  })
  const HOP = 480                                   // 10 мс при 48 кГц
  const n = Math.floor(buf.length / 2 / HOP)
  if (n < 2) return [0, duration]
  const loud: boolean[] = []
  for (let w = 0; w < n; w++) {
    let sum = 0
    for (let i = 0; i < HOP; i++) {
      const v = buf.readInt16LE((w * HOP + i) * 2)
      sum += v * v
    }
    const db = 20 * Math.log10(Math.sqrt(sum / HOP) / 32768 + 1e-12)
    loud.push(db > SPEECH_DB)
  }
  // сплошные участки звука
  const runs: Array<[number, number]> = []
  for (let i = 0; i < n; i++) {
    if (!loud[i]) continue
    let j = i
    while (j < n && loud[j]) j++
    runs.push([i, j])
    i = j
  }
  if (!runs.length) return [0, duration]
  const minWin = Math.round(MIN_RUN_S / 0.01)
  // короткий одиночный выброс на краю — не речь, а хвост синтеза
  while (runs.length > 1 && runs[runs.length - 1][1] - runs[runs.length - 1][0] < minWin &&
         runs[runs.length - 1][0] - runs[runs.length - 2][1] >= minWin) runs.pop()
  while (runs.length > 1 && runs[0][1] - runs[0][0] < minWin &&
         runs[1][0] - runs[0][1] >= minWin) runs.shift()
  const a = runs[0][0] * 0.01
  const b = Math.min(duration, runs[runs.length - 1][1] * 0.01)
  return b > a ? [a, b] : [0, duration]
}

/**
 * One phrase, ready to be spliced in: synthesised, sped up exactly like the
 * file it patches, and with its own leading/trailing silence cut back to a
 * controlled amount (otherwise every patch would add a pause).
 */
async function speakPhrase(req: PhraseSynthRequest): Promise<PhraseSynthResult> {
  if (job) throw new Error('синтез уже идёт')
  const text = req.text.trim()
  if (!text) throw new Error('текст фразы пуст')
  const tempo = req.tempo > 0 ? req.tempo : 1
  // хотим получить keepLead/keepTail ПОСЛЕ ускорения, значит в исходном
  // времени резать и добивать надо на tempo больше
  const wantLead = (req.keepLead ?? 0.06) * tempo
  const wantTail = (req.keepTail ?? 0.06) * tempo
  const dir = await fs.mkdtemp(join(tmpdir(), 'kadr-phrase-'))
  const j = { cancelled: false, abort: new AbortController(), ff: null as ReturnType<typeof spawn> | null }
  job = j
  const warnings: string[] = []
  try {
    const fmt = req.params.outputFormat || 'mp3_44100_128'
    const ext = fmt.startsWith('pcm_') ? 'pcm' : 'mp3'
    const rawFile = join(dir, `phrase.${ext}`)
    let requestId = ''

    if (MOCK) {
      await mockSpeech(text + '\n', 1, rawFile.replace(/\.(mp3|pcm)$/, '.wav'), (c) => { j.ff = c })
      await fs.rename(rawFile.replace(/\.(mp3|pcm)$/, '.wav'), join(dir, 'phrase.wav'))
    } else {
      const key = await readKey()
      if (!key) throw new Error('API-ключ не задан')
      let got
      try {
        got = await synthChunk(key, req.params, text, req.previousText || '', req.nextText || '',
          req.previousRequestIds ?? [], j.abort.signal,
          { timestamps: true, seed: req.seed, proxy: req.proxy })
      } catch (e) {
        // the timestamped endpoint is not available everywhere; the plain one
        // still gives usable audio, we just lose the truncation guard
        warnings.push('без выравнивания: ' + String((e as Error).message).slice(0, 120))
        got = await synthChunk(key, req.params, text, req.previousText || '', req.nextText || '',
          req.previousRequestIds ?? [], j.abort.signal, { seed: req.seed, proxy: req.proxy })
      }
      requestId = got.requestId
      if (got.alignment) {
        const said = got.alignment.chars.join('')
        const norm = (x: string) => x.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
        if (norm(said) !== norm(text)) {
          warnings.push('синтез прочитал не то, что просили')
        }
        const t0 = got.alignment.t0, t1 = got.alignment.t1
        let worst = 0
        for (let i = 1; i < t0.length; i++) worst = Math.max(worst, t0[i] - t1[i - 1])
        if (worst > 0.7) warnings.push(`внутри фразы пауза ${worst.toFixed(2)} с`)
      }
      await fs.writeFile(rawFile, got.audio)
    }

    const decoded = MOCK ? join(dir, 'phrase.wav') : rawFile
    const full = await probeDuration(decoded)
    if (!full) throw new Error('синтез вернул пустой звук')
    const [sp0, sp1] = await speechBounds(decoded, full)
    const a = Math.max(0, sp0 - wantLead)
    const b = Math.min(full, sp1 + wantTail)
    // синтез часто заканчивает ровно на последнем слове — тогда тишины не
    // обрезать надо, а ДОБАВИТЬ, иначе пауза на стыке станет короче исходной
    const leadShort = Math.max(0, wantLead - (sp0 - a))
    const tailShort = Math.max(0, wantTail - (b - sp1))

    // trim in the ORIGINAL timebase, then speed up: the other order would need
    // the cut points scaled and is easy to get wrong by a few ms
    const chain = [`atrim=start=${a.toFixed(4)}:end=${b.toFixed(4)}`, 'asetpts=N/SR/TB']
    if (leadShort > 0.001) chain.push(`adelay=${Math.round(leadShort * 1000)}:all=1`)
    if (tailShort > 0.001) chain.push(`apad=pad_dur=${tailShort.toFixed(4)}`)
    if (Math.abs(tempo - 1) > 1e-4) chain.push(...atempoChain(tempo))
    const args = ['-y', '-v', 'error']
    if (!MOCK) args.push(...inputArgs(decoded, fmt))
    else args.push('-i', decoded)
    // раскладку тоже не навязываем: склейка сама приведёт заплатку к раскладке
    // исходного файла, причём копированием канала, а не матрицей сведения
    args.push('-af', chain.join(','), '-ar', '48000', ...audioCodecArgs(req.outPath), req.outPath)
    await run(FFMPEG, args, (c) => { j.ff = c })
    if (j.cancelled) throw new Error('cancelled')

    const duration = await probeDuration(req.outPath)
    if (!duration) throw new Error('после обрезки не осталось звука')
    return { path: req.outPath, duration, requestId, warnings }
  } finally {
    job = null
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* gone */ })
  }
}

// ---------------------------------------------------------------------------
// assembling the wav

function inputArgs(file: string, fmt: string): string[] {
  const pcm = /^pcm_(\d+)$/.exec(fmt)
  // pcm_* is headerless 16-bit mono at the named rate; mp3/ulaw carry their own
  return pcm ? ['-f', 's16le', '-ar', pcm[1], '-ac', '1', '-i', file] : ['-i', file]
}

function run(bin: string, args: string[], onSpawn?: (c: ReturnType<typeof spawn>) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    onSpawn?.(child)
    let err = ''
    child.stderr.on('data', (c) => { err += c })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve()
      : reject(new Error(`${bin} exited ${code}: ${err.slice(0, 500)}`)))
  })
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await execFileP(FFPROBE, ['-v', 'error', '-show_entries',
    'format=duration', '-of', 'csv=p=0', path])
  return parseFloat(stdout.trim()) || 0
}

/**
 * Decode every chunk, concatenate, apply the speed-up and write one wav — in a
 * single ffmpeg pass. The user's script re-encoded mp3 → mp3 for the atempo and
 * lost a generation for nothing; here the tempo rides the decode.
 */
async function assemble(files: string[], fmt: string, tempo: number, out: string,
                        onSpawn: (c: ReturnType<typeof spawn>) => void): Promise<void> {
  const args = ['-y', '-v', 'error']
  for (const f of files) args.push(...inputArgs(f, fmt))
  // РАСКЛАДКУ НЕ НАВЯЗЫВАЕМ. ElevenLabs отдаёт МОНО, и прежний
  // `channel_layouts=stereo` просто дублировал канал: файл весил вдвое больше
  // ни за что (12 минут речи — 142 МБ вместо 71), а заодно проходил через
  // энергосохраняющую матрицу ffmpeg и терял ровно 3.01 дБ — измерено, каналы
  // в готовых файлах побитово одинаковы. В экспорте это не было слышно
  // (ExportMuxer поднимает всё в стерео той же матрицей), а в превью озвучка
  // играла тише, чем прислал синтез.
  const fmtF = 'aformat=sample_fmts=fltp:sample_rates=48000'
  const parts = files.map((_, i) => `[${i}:a]${fmtF}[a${i}]`)
  const labels = files.map((_, i) => `[a${i}]`).join('')
  parts.push(`${labels}concat=n=${files.length}:v=0:a=1[c]`)
  const chain = Math.abs(tempo - 1) > 1e-4 ? atempoChain(tempo) : []
  parts.push(chain.length ? `[c]${chain.join(',')}[out]` : '[c]anull[out]')
  args.push('-filter_complex', parts.join(';'), '-map', '[out]',
            '-ar', '48000', ...audioCodecArgs(out), out)
  await run(FFMPEG, args, onSpawn)
}

/** Speech-shaped audio without touching the network, for the test suites: a
    tone whose length tracks the text, silenced at every sentence end so the
    phrase-boundary logic of stage 2 has real gaps to find. */
async function mockSpeech(script: string, tempo: number, out: string,
                          onSpawn: (c: ReturnType<typeof spawn>) => void): Promise<void> {
  const CPS = 15                                   // characters per second of speech
  const GAP = 0.3
  const ends = sentenceEnds(script)
  const total = script.length / CPS + ends.length * GAP
  const mutes = ends.map((c, i) => {
    const t = c / CPS + i * GAP
    return `between(t,${t.toFixed(3)},${(t + GAP).toFixed(3)})`
  })
  const args = ['-y', '-v', 'error', '-f', 'lavfi',
    '-i', `sine=frequency=180:duration=${total.toFixed(3)}:sample_rate=48000`]
  const af = ['tremolo=f=6:d=0.7']
  if (mutes.length) af.push(`volume=0:enable='${mutes.join('+')}'`)
  const chain = Math.abs(tempo - 1) > 1e-4 ? atempoChain(tempo) : []
  af.push(...chain)
  // моно — как настоящий ответ API, иначе фикстура проверяла бы не тот путь
  args.push('-af', af.join(','), '-ar', '48000', '-ac', '1', ...audioCodecArgs(out), out)
  await run(FFMPEG, args, onSpawn)
}

// ---------------------------------------------------------------------------

async function speak(win: BrowserWindow, req: TtsRequest): Promise<TtsResult> {
  if (job) throw new Error('синтез уже идёт')
  const tempo = req.tempo && req.tempo > 0 ? req.tempo : 1
  const script = normalizeScript(req.text)
  if (!script.trim()) throw new Error('текст пуст')
  const dir = await fs.mkdtemp(join(tmpdir(), 'kadr-tts-'))

  // the busy flag goes up only once nothing between here and the try/finally
  // can throw — otherwise it would stay up and refuse every later synthesis
  const j = { cancelled: false, abort: new AbortController(), ff: null as ReturnType<typeof spawn> | null }
  job = j
  const send = (progress: number, stage: string, text?: string) =>
    win.webContents.send('tts:progress', { progress, stage, text })
  // расширение снимаем любое: озвучка пишется в .flac, а у пользователя могут
  // лежать старые .wav — сценарий обязан лечь рядом под тем же именем
  const scriptPath = req.outPath.replace(/\.(wav|flac)$/i, '') + '.script.txt'
  try {
    // the script is written BEFORE the audio: it is what the detector aligns
    // against, and a file whose script went missing cannot be checked at all
    await fs.writeFile(scriptPath, script, 'utf8')
    const scriptHash = createHash('sha1').update(script, 'utf8').digest('hex')

    const fmt = req.params.outputFormat || 'mp3_44100_128'
    const ext = fmt.startsWith('pcm_') ? 'pcm' : 'mp3'
    const files: string[] = []
    const requestIds: string[] = []

    if (MOCK) {
      send(0.4, 'synth')
      await mockSpeech(script, tempo, req.outPath, (c) => { j.ff = c })
    } else {
      const key = await readKey()
      if (!key) throw new Error('API-ключ не задан')
      const limit = MODEL_CHAR_LIMIT[req.params.modelId] ?? 10000
      const parts = chunkText(script, Math.floor(limit * 0.9))
      for (let i = 0; i < parts.length; i++) {
        if (j.cancelled) throw new Error('cancelled')
        send((i / parts.length) * 0.9, 'synth',
             script.slice(parts[i].from, parts[i].from + 60))
        const text = script.slice(parts[i].from, parts[i].to)
        const prevText = i > 0 ? script.slice(Math.max(0, parts[i].from - CONTEXT_CHARS), parts[i].from) : ''
        const nextText = i + 1 < parts.length ? script.slice(parts[i].to, parts[i].to + CONTEXT_CHARS) : ''
        const { audio, requestId } = await synthChunk(
          key, req.params, text, prevText, nextText, requestIds.filter(Boolean), j.abort.signal,
          { proxy: req.proxy })
        const f = join(dir, `chunk-${String(i).padStart(3, '0')}.${ext}`)
        await fs.writeFile(f, audio)
        files.push(f)
        requestIds.push(requestId)
      }
      if (j.cancelled) throw new Error('cancelled')
      send(0.92, 'assemble')
      await assemble(files, fmt, tempo, req.outPath, (c) => { j.ff = c })
    }
    if (j.cancelled) throw new Error('cancelled')

    const duration = await probeDuration(req.outPath)
    if (!duration) throw new Error('получился пустой аудиофайл')
    send(1, 'done')
    return { path: req.outPath, duration, scriptPath, scriptHash,
             chunks: Math.max(1, files.length), requestIds, tempo }
  } finally {
    job = null
    await fs.rm(dir, { recursive: true, force: true }).catch(() => { /* gone */ })
  }
}

export function registerTtsIpc(getWin: () => BrowserWindow | null) {
  ipcMain.handle('tts:has-key', async () => MOCK || !!(await readKey()))
  // Whether THIS process synthesises locally. `tts:has-key` cannot answer
  // that: it is true whenever a real key is stored, so a test that guarded on
  // it would happily run against the live API — which is exactly what happened
  // once, with real requests going out under the user's key.
  ipcMain.handle('tts:is-mock', () => MOCK)
  ipcMain.handle('tts:set-key', (_e, key: unknown) => {
    // Стирание ключа должно быть НАМЕРЕННЫМ. Раньше здесь стояло
    // String(key || '') — и вызов ttsSetKey() без аргумента молча удалял
    // секрет пользователя. Именно так его один раз и потеряли (мой же тест
    // перебирал все методы со словом key и вызывал их без аргументов).
    if (typeof key !== 'string') {
      throw new Error('tts:set-key ждёт строку; чтобы удалить ключ, передайте пустую строку')
    }
    return writeKey(key.trim())
  })
  ipcMain.handle('tts:voices', (_e, proxy?: string) => listVoices(proxy))
  ipcMain.handle('tts:speak', (_e, req: TtsRequest) => {
    const win = getWin()
    if (!win) throw new Error('no window')
    return speak(win, req)
  })
  ipcMain.handle('tts:speak-phrase', (_e, req: PhraseSynthRequest) => speakPhrase(req))
  ipcMain.handle('tts:cancel', () => {
    if (!job) return
    job.cancelled = true
    job.abort?.abort()
    job.ff?.kill('SIGKILL')
  })
}
