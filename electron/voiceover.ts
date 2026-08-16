import { app, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { promises as fs, existsSync } from 'fs'
import { basename, dirname, join } from 'path'
import { homedir } from 'os'
import { promisify } from 'util'
import type {
  VoiceoverGenerateRequest,
  VoiceoverGenerateResult,
  VoiceoverProgress,
  VoiceoverSettings,
  VoiceoverStatus
} from '@shared/types'

const execFileAsync = promisify(execFile)

interface VoiceoverRuntime {
  pythonPath: string
  modelPath: string
  ffmpegPath: string
  configPath: string
}

interface VoiceoverConfig {
  pythonPath?: string
  modelPath?: string
  ffmpegPath?: string
}

type WorkerMessage =
  | { type: 'ready' }
  | { type: 'progress'; id: string; stage: VoiceoverProgress['stage']; progress: number; message?: string }
  | { type: 'done'; id: string; path: string; duration: number; seed: number }
  | { type: 'error'; id: string; message: string }

let worker: ChildProcessWithoutNullStreams | null = null
let workerReady: Promise<void> | null = null
let workerRuntimeKey: string | null = null
let resolveReady: (() => void) | null = null
let rejectReady: ((err: Error) => void) | null = null
let stdoutBuffer = ''
let stderrTail = ''
let current: {
  id: string
  clipId: string
  target: WebContents
  resolve: (result: VoiceoverGenerateResult) => void
  reject: (err: Error) => void
} | null = null

const safePart = (value: string) => value.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 80) || 'voice'

async function resolveRuntime(settings: VoiceoverSettings): Promise<VoiceoverRuntime> {
  const configPath = join(homedir(), '.config', 'kadr', 'tts.json')
  let config: VoiceoverConfig = {}
  try {
    config = JSON.parse(await fs.readFile(configPath, 'utf8')) as VoiceoverConfig
  } catch { /* the local TTS config is optional */ }
  return {
    pythonPath: process.env.KADR_TTS_PYTHON || config.pythonPath || settings.pythonPath || '',
    modelPath: process.env.KADR_TTS_MODEL || config.modelPath || settings.modelPath || '',
    ffmpegPath: process.env.KADR_FFMPEG || config.ffmpegPath || 'ffmpeg',
    configPath
  }
}

async function voiceoverStatus(settings: VoiceoverSettings): Promise<VoiceoverStatus> {
  const runtime = await resolveRuntime(settings)
  const unavailable = (reason: string): VoiceoverStatus => ({
    ready: false,
    reason,
    pythonPath: runtime.pythonPath,
    modelPath: runtime.modelPath,
    configPath: runtime.configPath
  })
  if (!existsSync(runtime.pythonPath)) return unavailable('Не найден Python для TTS')
  if (!existsSync(runtime.modelPath)) return unavailable('Не найдена локальная модель TTS')
  if (!existsSync(join(runtime.modelPath, 'config.json'))) return unavailable('Папка модели TTS заполнена не полностью')
  const script = join(app.getAppPath(), 'scripts', 'voiceover_worker.py')
  if (!existsSync(script)) return unavailable('Не найден TTS-воркер Kadr')
  try {
    await execFileAsync(runtime.pythonPath, [
      '-c',
      'import mlx.core, numpy; from mlx_audio.tts.utils import load_model'
    ], { timeout: 20_000 })
  } catch {
    return unavailable('В Python не установлены зависимости TTS')
  }
  try {
    await execFileAsync(runtime.ffmpegPath, ['-version'], { timeout: 10_000 })
  } catch {
    return unavailable('Не найден ffmpeg для финализации озвучки')
  }
  return {
    ready: true,
    pythonPath: runtime.pythonPath,
    modelPath: runtime.modelPath,
    configPath: runtime.configPath
  }
}

function sendProgress(target: WebContents, progress: VoiceoverProgress) {
  if (!target.isDestroyed()) target.send('voiceover:progress', progress)
}

function stopWorker(reason = 'Генерация отменена') {
  if (current) {
    current.reject(new Error(reason))
    current = null
  }
  rejectReady?.(new Error(reason))
  resolveReady = null
  rejectReady = null
  workerReady = null
  workerRuntimeKey = null
  stdoutBuffer = ''
  try { worker?.kill('SIGKILL') } catch { /* already gone */ }
  worker = null
}

function handleMessage(msg: WorkerMessage) {
  if (msg.type === 'ready') {
    resolveReady?.()
    resolveReady = null
    rejectReady = null
    return
  }
  if (!current || msg.id !== current.id) return
  if (msg.type === 'progress') {
    sendProgress(current.target, {
      clipId: current.clipId,
      stage: msg.stage,
      progress: msg.progress,
      message: msg.message
    })
  } else if (msg.type === 'done') {
    const done = current
    current = null
    sendProgress(done.target, { clipId: done.clipId, stage: 'done', progress: 1 })
    done.resolve({ path: msg.path, duration: msg.duration, seed: msg.seed })
  } else if (msg.type === 'error') {
    const failed = current
    current = null
    sendProgress(failed.target, {
      clipId: failed.clipId,
      stage: 'error',
      progress: 0,
      message: msg.message
    })
    failed.reject(new Error(msg.message))
  }
}

function ensureWorker(runtime: VoiceoverRuntime): Promise<void> {
  const runtimeKey = JSON.stringify([
    runtime.pythonPath,
    runtime.modelPath,
    runtime.ffmpegPath
  ])
  if (worker && workerReady && workerRuntimeKey === runtimeKey) return workerReady
  if (worker) stopWorker('Конфигурация TTS изменилась')

  const script = join(app.getAppPath(), 'scripts', 'voiceover_worker.py')
  stderrTail = ''
  stdoutBuffer = ''
  workerReady = new Promise<void>((resolve, reject) => {
    resolveReady = resolve
    rejectReady = reject
  })
  workerRuntimeKey = runtimeKey
  worker = spawn(runtime.pythonPath, [script, '--model', runtime.modelPath], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PYTHONUNBUFFERED: '1', KADR_FFMPEG: runtime.ffmpegPath }
  })
  worker.stdout.on('data', (chunk) => {
    stdoutBuffer += String(chunk)
    const lines = stdoutBuffer.split('\n')
    stdoutBuffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      try { handleMessage(JSON.parse(line) as WorkerMessage) }
      catch { /* model libraries occasionally print to stdout; ignore it */ }
    }
  })
  worker.stderr.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-4000)
  })
  worker.on('error', (err) => stopWorker(err.message))
  worker.on('close', (code) => {
    const detail = stderrTail.trim().slice(-1200)
    stopWorker(detail || `TTS-процесс завершился с кодом ${code}`)
  })
  return workerReady
}

async function outputPath(req: VoiceoverGenerateRequest): Promise<string> {
  const root = req.projectPath
    ? join(dirname(req.projectPath), `${basename(req.projectPath, '.kadr')}.media`, 'voiceover')
    : join(app.getPath('userData'), 'voiceover')
  const dir = join(root, safePart(req.clipId))
  await fs.mkdir(dir, { recursive: true })
  return join(dir, `v${Math.max(1, Math.floor(req.version))}.wav`)
}

async function generate(
  target: WebContents,
  req: VoiceoverGenerateRequest
): Promise<VoiceoverGenerateResult> {
  if (current) throw new Error('Дождитесь завершения текущей генерации')
  const text = req.text.trim()
  if (!text) throw new Error('Введите текст для озвучки')
  const id = `${safePart(req.clipId)}-${Date.now()}`
  const status = await voiceoverStatus(req.settings)
  if (!status.ready) throw new Error(`${status.reason}. Настройте TTS по инструкции в README.md`)
  const runtime = await resolveRuntime(req.settings)
  sendProgress(target, { clipId: req.clipId, stage: 'loading', progress: 0.04 })
  await ensureWorker(runtime)
  const out = await outputPath(req)
  sendProgress(target, { clipId: req.clipId, stage: 'generating', progress: 0.15 })

  return new Promise<VoiceoverGenerateResult>((resolve, reject) => {
    current = { id, clipId: req.clipId, target, resolve, reject }
    worker!.stdin.write(JSON.stringify({
      id,
      text,
      outputPath: out,
      settings: req.settings
    }) + '\n')
  })
}

export function registerVoiceoverIpc() {
  ipcMain.handle('voiceover:status', (_e, settings: VoiceoverSettings) =>
    voiceoverStatus(settings)
  )
  ipcMain.handle('voiceover:generate', (event, req: VoiceoverGenerateRequest) =>
    generate(event.sender, req)
  )
  ipcMain.handle('voiceover:cancel', (event) => {
    if (!current || current.target.id !== event.sender.id) return
    const { clipId, target } = current
    stopWorker()
    if (clipId) sendProgress(target, {
      clipId,
      stage: 'error',
      progress: 0,
      message: 'Генерация отменена'
    })
  })
  app.on('before-quit', () => stopWorker('Kadr закрывается'))
}
