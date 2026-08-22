import { app, ipcMain } from 'electron'
import type { WebContents } from 'electron'
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process'
import { randomUUID } from 'crypto'
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
import {
  getVoiceoverVoice,
  VOICEOVER_REFERENCE_TEXT,
  VOICEOVER_VOICES
} from '@shared/voiceover'
import { cancelVoiceoverInstall, installVoiceoverBackend } from './voiceover-installer'
import { registerVoiceCloneIpc } from './voice-clones'

const execFileAsync = promisify(execFile)

interface VoiceoverRuntime {
  pythonPath: string
  modelPath: string
  vocabPath: string
  voicesPath: string
  cachePath: string
  ffmpegPath: string
  configPath: string
}

interface VoiceoverConfig {
  pythonPath?: string
  modelPath?: string
  vocabPath?: string
  voicesPath?: string
  cachePath?: string
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
let readyStatusCache: { key: string; status: VoiceoverStatus } | null = null
let statusCheck: { key: string; promise: Promise<VoiceoverStatus> } | null = null
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
    vocabPath: process.env.KADR_TTS_VOCAB || config.vocabPath || settings.vocabPath || '',
    voicesPath: process.env.KADR_TTS_VOICES || config.voicesPath || settings.voicesPath || '',
    cachePath: config.cachePath || '',
    ffmpegPath: process.env.KADR_FFMPEG || config.ffmpegPath || 'ffmpeg',
    configPath
  }
}

async function voiceoverStatus(settings: VoiceoverSettings): Promise<VoiceoverStatus> {
  const runtime = await resolveRuntime(settings)
  const unavailable = (reason: string): VoiceoverStatus => ({
    ready: false,
    reason,
    engine: 'F5-TTS',
    pythonPath: runtime.pythonPath,
    modelPath: runtime.modelPath,
    vocabPath: runtime.vocabPath,
    voicesPath: runtime.voicesPath,
    configPath: runtime.configPath
  })
  if (!existsSync(runtime.pythonPath)) return unavailable('Не найден Python для TTS')
  if (!existsSync(runtime.modelPath)) return unavailable('Не найден checkpoint F5-TTS')
  if (!existsSync(runtime.vocabPath)) return unavailable('Не найден словарь F5-TTS')
  if (!existsSync(runtime.voicesPath)) return unavailable('Не найдена папка референсов голосов')
  const missingVoice = VOICEOVER_VOICES.find((voice) =>
    !existsSync(join(runtime.voicesPath, voice.referenceFile)))
  if (missingVoice) return unavailable(`Не найден референс голоса №${missingVoice.number}`)
  const script = join(app.getAppPath(), 'scripts', 'voiceover_worker.py')
  if (!existsSync(script)) return unavailable('Не найден TTS-воркер Kadr')
  const key = JSON.stringify([
    runtime.pythonPath, runtime.modelPath, runtime.vocabPath, runtime.voicesPath,
    runtime.cachePath, runtime.ffmpegPath, script
  ])
  if (readyStatusCache?.key === key) return readyStatusCache.status
  if (statusCheck?.key === key) return statusCheck.promise

  const promise = (async (): Promise<VoiceoverStatus> => {
    try {
      await execFileAsync(runtime.pythonPath, [
        '-c',
        'import f5_tts, numpy, soundfile, torch; from f5_tts.api import F5TTS'
      ], { timeout: 30_000 })
    } catch {
      return unavailable('В Python не установлены зависимости TTS')
    }
    try {
      await execFileAsync(runtime.ffmpegPath, ['-version'], { timeout: 10_000 })
    } catch {
      return unavailable('Не найден ffmpeg для финализации озвучки')
    }
    const status: VoiceoverStatus = {
      ready: true,
      engine: 'F5-TTS',
      pythonPath: runtime.pythonPath,
      modelPath: runtime.modelPath,
      vocabPath: runtime.vocabPath,
      voicesPath: runtime.voicesPath,
      configPath: runtime.configPath
    }
    readyStatusCache = { key, status }
    return status
  })()
  statusCheck = { key, promise }
  try {
    return await promise
  } finally {
    if (statusCheck?.promise === promise) statusCheck = null
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
    runtime.vocabPath,
    runtime.voicesPath,
    runtime.cachePath,
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
  worker = spawn(runtime.pythonPath, [
    script,
    '--model', runtime.modelPath,
    '--vocab', runtime.vocabPath
  ], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      PYTHONUNBUFFERED: '1',
      KADR_FFMPEG: runtime.ffmpegPath,
      ...(runtime.cachePath ? {
        HF_HOME: runtime.cachePath,
        TORCH_HOME: join(runtime.cachePath, 'torch')
      } : {})
    }
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
  // A failed/retried take may reuse the same visible version number. Give
  // every render an immutable URL so Chromium never reuses a cached WAV from
  // the previous attempt.
  return join(dir, `v${Math.max(1, Math.floor(req.version))}-${Date.now()}-${randomUUID().slice(0, 8)}.wav`)
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
  const customVoice = req.settings.customVoice?.id === req.settings.voiceId
    ? req.settings.customVoice
    : undefined
  const bundledVoice = getVoiceoverVoice(req.settings.voiceId)
  const referencePath = customVoice?.referencePath ?? join(runtime.voicesPath, bundledVoice.referenceFile)
  const referenceText = customVoice?.referenceText ?? VOICEOVER_REFERENCE_TEXT
  const voiceName = customVoice?.name ?? bundledVoice.name
  if (!existsSync(referencePath)) throw new Error(`Не найден референс голоса «${voiceName}»`)
  if (customVoice && !referenceText.trim()) {
    throw new Error(`У голоса «${voiceName}» не подтверждён текст референса. Откройте «Управление голосами» и сохраните распознанный текст`)
  }
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
      settings: req.settings,
      voice: {
        id: customVoice?.id ?? bundledVoice.id,
        referencePath,
        referenceText
      }
    }) + '\n')
  })
}

export function registerVoiceoverIpc() {
  registerVoiceCloneIpc()
  ipcMain.handle('voiceover:status', (_e, settings: VoiceoverSettings) =>
    voiceoverStatus(settings)
  )
  ipcMain.handle('voiceover:install', async (event, settings: VoiceoverSettings) => {
    const currentStatus = await voiceoverStatus(settings)
    if (currentStatus.ready) return currentStatus
    await installVoiceoverBackend(event.sender)
    return voiceoverStatus(settings)
  })
  ipcMain.handle('voiceover:install-cancel', () => cancelVoiceoverInstall())
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
  app.on('before-quit', () => {
    cancelVoiceoverInstall()
    stopWorker('Kadr закрывается')
  })
}
