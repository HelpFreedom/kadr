import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { execFile } from 'child_process'
import { randomUUID } from 'crypto'
import { promises as fs, existsSync } from 'fs'
import { basename, dirname, extname, join, resolve } from 'path'
import { promisify } from 'util'
import type {
  VoiceClonePreview,
  VoiceCloneProcessingOptions,
  VoiceCloneSaveRequest,
  VoiceoverCustomVoice
} from '@shared/types'
import { FFMPEG, probeMedia } from './ffmpeg'

const execFileAsync = promisify(execFile)
const MAX_REFERENCE_SECONDS = 120
let libraryMutation: Promise<unknown> = Promise.resolve()

function libraryRoot(): string {
  return join(app.getPath('userData'), 'voice-clones')
}

function libraryPath(): string {
  return join(libraryRoot(), 'library.json')
}

function tempRoot(): string {
  return join(app.getPath('temp'), 'kadr-voice-clones')
}

function safeName(value: string): string {
  return value.replace(/[^\p{L}\p{N} ._-]/gu, '_').trim().slice(0, 80) || 'Мой голос'
}

async function readLibrary(): Promise<VoiceoverCustomVoice[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(libraryPath(), 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((voice): voice is VoiceoverCustomVoice =>
      voice && typeof voice.id === 'string' && typeof voice.name === 'string' &&
      typeof voice.referencePath === 'string' && existsSync(voice.referencePath))
  } catch {
    return []
  }
}

async function writeLibrary(voices: VoiceoverCustomVoice[]): Promise<void> {
  const path = libraryPath()
  await fs.mkdir(dirname(path), { recursive: true })
  const pending = `${path}.part`
  await fs.writeFile(pending, JSON.stringify(voices, null, 2) + '\n', 'utf8')
  await fs.rename(pending, path)
}

function mutateLibrary<T>(mutation: () => Promise<T>): Promise<T> {
  const next = libraryMutation.then(mutation, mutation)
  libraryMutation = next.then(() => undefined, () => undefined)
  return next
}

async function tempOutput(label: string): Promise<string> {
  const dir = tempRoot()
  await fs.mkdir(dir, { recursive: true })
  return join(dir, `${label}-${randomUUID()}.wav`)
}

async function runFfmpeg(sourcePath: string, outputPath: string, filters: string[]): Promise<void> {
  if (!existsSync(sourcePath)) throw new Error('Исходный аудиофайл не найден')
  const pending = outputPath.replace(/\.wav$/i, `.part-${randomUUID()}.wav`)
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error', '-i', sourcePath,
    '-map', '0:a:0', '-vn', '-t', String(MAX_REFERENCE_SECONDS),
    ...(filters.length ? ['-af', filters.join(',')] : []),
    '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', pending
  ]
  try {
    await execFileAsync(FFMPEG, args, { maxBuffer: 8 * 1024 * 1024, timeout: 180_000 })
    await fs.rename(pending, outputPath)
  } catch (error: any) {
    await fs.rm(pending, { force: true }).catch(() => undefined)
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(-1200)
    throw new Error(`Не удалось обработать голос: ${detail}`)
  }
}

async function inspect(path: string): Promise<VoiceClonePreview> {
  const result = await probeMedia(path)
  const duration = result.asset.duration
  if (!result.asset.hasAudio && result.asset.kind !== 'audio') throw new Error('В файле нет звуковой дорожки')
  if (duration < 1) throw new Error('Запись слишком короткая — нужно хотя бы 1 секунду речи')
  return { path, duration }
}

async function prepare(sourcePath: string): Promise<VoiceClonePreview> {
  const output = await tempOutput('original')
  await runFfmpeg(sourcePath, output, [])
  return inspect(output)
}

async function processVoice(
  sourcePath: string,
  options: VoiceCloneProcessingOptions
): Promise<VoiceClonePreview> {
  const filters: string[] = []
  if (options.noiseReduction.enabled) {
    const strength = Math.max(0, Math.min(1, options.noiseReduction.strength))
    const noiseFloor = -35 + strength * 15
    filters.push('highpass=f=65', `afftdn=nf=${noiseFloor.toFixed(1)}:tn=1`)
  }
  if (options.compressor.enabled) {
    const thresholdDb = Math.max(-40, Math.min(-3, options.compressor.thresholdDb))
    const threshold = Math.pow(10, thresholdDb / 20)
    const ratio = Math.max(1, Math.min(12, options.compressor.ratio))
    filters.push(`acompressor=threshold=${threshold.toFixed(5)}:ratio=${ratio.toFixed(2)}:attack=20:release=250:makeup=1`)
  }
  if (options.normalization.enabled) {
    const target = Math.max(-30, Math.min(-10, options.normalization.targetLufs))
    filters.push(`loudnorm=I=${target}:TP=-2:LRA=9`)
  }
  const output = await tempOutput('processed')
  await runFfmpeg(sourcePath, output, filters)
  return inspect(output)
}

async function transcribeReference(sourcePath: string): Promise<string> {
  await inspect(sourcePath)
  const configPath = join(app.getPath('home'), '.config', 'kadr', 'tts.json')
  let config: { pythonPath?: string; cachePath?: string } = {}
  try { config = JSON.parse(await fs.readFile(configPath, 'utf8')) } catch { /* optional config */ }
  const pythonPath = process.env.KADR_TTS_PYTHON || config.pythonPath || ''
  if (!pythonPath || !existsSync(pythonPath)) {
    throw new Error('Для распознавания референса сначала установите F5‑TTS')
  }
  const script = [
    'import json, sys',
    'from f5_tts.infer.utils_infer import preprocess_ref_audio_text',
    '_, text = preprocess_ref_audio_text(sys.argv[1], "", show_info=lambda *_: None)',
    'print(json.dumps({"text": text.strip()}, ensure_ascii=False))'
  ].join('; ')
  try {
    const { stdout } = await execFileAsync(pythonPath, ['-c', script, sourcePath], {
      maxBuffer: 8 * 1024 * 1024,
      timeout: 300_000,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        ...(config.cachePath ? { HF_HOME: config.cachePath, TORCH_HOME: join(config.cachePath, 'torch') } : {})
      }
    })
    const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1)
    const text = line ? String((JSON.parse(line) as { text?: string }).text ?? '').trim() : ''
    if (!text) throw new Error('Речь в референсе не распознана')
    return text.replace(/\.\s*$/, '')
  } catch (error: any) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim().slice(-1200)
    throw new Error(`Не удалось распознать текст референса: ${detail}`)
  }
}

async function saveClone(request: VoiceCloneSaveRequest): Promise<VoiceoverCustomVoice> {
  if (!existsSync(request.processedPath)) throw new Error('Сначала выполните обработку записи')
  if (!request.referenceText.trim()) throw new Error('Проверьте и укажите точный текст референса')
  await inspect(request.processedPath)
  return mutateLibrary(async () => {
    const voices = await readLibrary()
    const index = request.voiceId ? voices.findIndex((item) => item.id === request.voiceId) : -1
    if (request.voiceId && index < 0) throw new Error('Редактируемый голос не найден в библиотеке')
    const previous = index >= 0 ? voices[index] : undefined
    const id = previous?.id ?? `custom_${randomUUID().replace(/-/g, '')}`
    const root = libraryRoot()
    await fs.mkdir(root, { recursive: true })
    const referencePath = join(root, `${id}-${randomUUID().slice(0, 8)}.wav`)
    const pending = `${referencePath}.part`
    await fs.copyFile(request.processedPath, pending)
    await fs.rename(pending, referencePath)
    const voice: VoiceoverCustomVoice = {
      id,
      name: safeName(request.name),
      description: request.description?.trim().slice(0, 240) || undefined,
      referencePath,
      referenceText: request.referenceText.trim(),
      createdAt: previous?.createdAt ?? new Date().toISOString(),
      source: request.source,
      sourceLabel: request.sourceLabel?.trim().slice(0, 160) || basename(request.processedPath, extname(request.processedPath))
    }
    if (index >= 0) voices[index] = voice
    else voices.push(voice)
    await writeLibrary(voices)
    return voice
  })
}

async function deleteClone(voiceId: string): Promise<boolean> {
  return mutateLibrary(async () => {
    const voices = await readLibrary()
    const filtered = voices.filter((voice) => voice.id !== voiceId)
    if (filtered.length === voices.length) return false
    // Keep the immutable WAV on disk: an open or portable project may still
    // reference this exact take even after it disappears from the library.
    await writeLibrary(filtered)
    return true
  })
}

async function discardTemporary(paths: string[]): Promise<void> {
  const root = resolve(tempRoot())
  await Promise.all(paths.map(async (path) => {
    const candidate = resolve(path)
    if (dirname(candidate) !== root) return
    await fs.rm(candidate, { force: true }).catch(() => undefined)
  }))
}

export function registerVoiceCloneIpc() {
  ipcMain.handle('voice-clone:list', () => readLibrary())
  ipcMain.handle('voice-clone:pick-file', async (event) => {
    const options: OpenDialogOptions = {
      properties: ['openFile'],
      filters: [
        { name: 'Аудио', extensions: ['wav', 'mp3', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'webm', 'mp4', 'mov'] },
        { name: 'Все файлы', extensions: ['*'] }
      ]
    }
    const parent = BrowserWindow.fromWebContents(event.sender)
    const result = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  ipcMain.handle('voice-clone:prepare', (_event, sourcePath: string) => prepare(sourcePath))
  ipcMain.handle('voice-clone:process', (_event, sourcePath: string, options: VoiceCloneProcessingOptions) =>
    processVoice(sourcePath, options))
  ipcMain.handle('voice-clone:transcribe', (_event, sourcePath: string) => transcribeReference(sourcePath))
  ipcMain.handle('voice-clone:save', (_event, request: VoiceCloneSaveRequest) => saveClone(request))
  ipcMain.handle('voice-clone:delete', (_event, voiceId: string) => deleteClone(voiceId))
  ipcMain.handle('voice-clone:discard', (_event, paths: string[]) => discardTemporary(paths))
}
