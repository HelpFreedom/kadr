import { app } from 'electron'
import type { WebContents } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, existsSync } from 'fs'
import { promises as fs } from 'fs'
import { homedir } from 'os'
import { basename, dirname, join } from 'path'
import { request } from 'https'
import type { IncomingMessage } from 'http'
import type { VoiceoverInstallProgress } from '@shared/types'
import { VOICEOVER_VOICES } from '@shared/voiceover'

const UV_VERSION = '0.12.5'
const UV_ARCHIVE = 'uv-aarch64-apple-darwin.tar.gz'
const UV_URL = `https://releases.astral.sh/github/uv/releases/download/${UV_VERSION}/${UV_ARCHIVE}`
const UV_SHA256 = '5bb0e5fe008a773c3dbcb97ff79cd89e1241464fe9d2f986d52ad8f1b037bd62'
const MODEL_REVISION = 'ea166adeae4c80ec5ee423a671e2bdb83906cf84'
const MODEL_URL = 'https://huggingface.co/Misha24-10/F5-TTS_RUSSIAN/resolve/' +
  `${MODEL_REVISION}/F5TTS_v1_Base_accent_tune/model_20000_inference.safetensors?download=true`
const MODEL_SHA256 = '2500e3e1423680035acb8c66c60b3f0597e18fa1746aab43190a75830623b703'
const VOCAB_URL = 'https://huggingface.co/Misha24-10/F5-TTS_RUSSIAN/resolve/' +
  `${MODEL_REVISION}/F5TTS_v1_Base/vocab.txt?download=true`
const VOCAB_SHA256 = '2a05f992e00af9b0bd3800a8d23e78d520dbd705284ed2eedb5f4bd29398fa3c'

export interface InstalledVoiceoverRuntime {
  pythonPath: string
  modelPath: string
  vocabPath: string
  voicesPath: string
  cachePath: string
  ffmpegPath: string
  configPath: string
}

let installAbort: AbortController | null = null
let installProcess: ChildProcess | null = null

const cancelledError = () => new Error('Установка F5-TTS отменена')

function send(target: WebContents, progress: VoiceoverInstallProgress) {
  if (!target.isDestroyed()) target.send('voiceover:install-progress', progress)
}

async function sha256(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

async function isVerified(path: string, expected: string): Promise<boolean> {
  if (!existsSync(path)) return false
  return (await sha256(path)) === expected
}

function responseLength(response: IncomingMessage): number {
  const value = Number(response.headers['content-length'] ?? 0)
  return Number.isFinite(value) ? value : 0
}

async function download(
  url: string,
  destination: string,
  signal: AbortSignal,
  onProgress: (downloaded: number, total: number) => void,
  redirects = 0
): Promise<void> {
  if (signal.aborted) throw cancelledError()
  if (redirects > 8) throw new Error('Слишком много перенаправлений при загрузке F5-TTS')
  const partial = `${destination}.part`
  const offset = await fs.stat(partial).then((stat) => stat.size).catch(() => 0)

  return new Promise((resolve, reject) => {
    const req = request(url, {
      headers: offset > 0 ? { Range: `bytes=${offset}-`, 'User-Agent': 'Kadr-F5-Installer/1' }
        : { 'User-Agent': 'Kadr-F5-Installer/1' }
    }, (response) => {
      const location = response.headers.location
      if (location && response.statusCode && response.statusCode >= 300 && response.statusCode < 400) {
        response.resume()
        const next = new URL(location, url).toString()
        void download(next, destination, signal, onProgress, redirects + 1).then(resolve, reject)
        return
      }
      if (offset > 0 && response.statusCode === 200) {
        response.resume()
        void fs.unlink(partial).catch(() => {}).then(() =>
          download(url, destination, signal, onProgress, redirects)).then(resolve, reject)
        return
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        response.resume()
        reject(new Error(`Сервер загрузки вернул HTTP ${response.statusCode ?? 0}`))
        return
      }
      const append = response.statusCode === 206 && offset > 0
      let downloaded = append ? offset : 0
      const total = downloaded + responseLength(response)
      const output = createWriteStream(partial, { flags: append ? 'a' : 'w' })
      const abort = () => {
        req.destroy(cancelledError())
        response.destroy(cancelledError())
        output.destroy(cancelledError())
      }
      signal.addEventListener('abort', abort, { once: true })
      response.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        onProgress(downloaded, total)
      })
      response.on('error', reject)
      output.on('error', reject)
      output.on('finish', () => {
        signal.removeEventListener('abort', abort)
        void fs.rename(partial, destination).then(() => resolve(), reject)
      })
      response.pipe(output)
    })
    req.on('error', reject)
    req.end()
  })
}

async function verifiedDownload(
  url: string,
  path: string,
  checksum: string,
  signal: AbortSignal,
  onProgress: (downloaded: number, total: number) => void
) {
  if (await isVerified(path, checksum)) return
  if (existsSync(path)) await fs.unlink(path)
  await fs.mkdir(dirname(path), { recursive: true })
  await download(url, path, signal, onProgress)
  if (!await isVerified(path, checksum)) {
    await fs.unlink(path).catch(() => {})
    throw new Error(`Контрольная сумма ${basename(path)} не совпала`)
  }
}

async function findExecutable(root: string, name: string): Promise<string | null> {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name)
    if (entry.isDirectory()) {
      const nested = await findExecutable(path, name)
      if (nested) return nested
    } else if (entry.name === name) return path
  }
  return null
}

async function run(
  command: string,
  args: string[],
  signal: AbortSignal,
  env?: NodeJS.ProcessEnv
): Promise<void> {
  if (signal.aborted) throw cancelledError()
  return new Promise((resolve, reject) => {
    let tail = ''
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env, PYTHONUNBUFFERED: '1' }
    })
    installProcess = child
    const capture = (chunk: Buffer) => { tail = (tail + String(chunk)).slice(-5000) }
    child.stdout.on('data', capture)
    child.stderr.on('data', capture)
    const abort = () => child.kill('SIGKILL')
    signal.addEventListener('abort', abort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      signal.removeEventListener('abort', abort)
      if (installProcess === child) installProcess = null
      if (signal.aborted) reject(cancelledError())
      else if (code === 0) resolve()
      else reject(new Error(tail.trim() || `${basename(command)} завершился с кодом ${code}`))
    })
  })
}

async function ensureUv(root: string, signal: AbortSignal, target: WebContents): Promise<string> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') {
    throw new Error('Автоустановка F5-TTS пока поддерживает macOS на Apple Silicon')
  }
  const tools = join(root, 'tools')
  const uv = join(tools, 'uv')
  if (existsSync(uv)) return uv
  await fs.mkdir(tools, { recursive: true })
  const archive = join(tools, UV_ARCHIVE)
  send(target, { stage: 'runtime', progress: 0.08, message: 'Загружаю установщик Python' })
  await verifiedDownload(UV_URL, archive, UV_SHA256, signal, (downloaded, total) =>
    send(target, { stage: 'runtime', progress: 0.08 + 0.04 * (total ? downloaded / total : 0),
      message: 'Загружаю установщик Python', downloadedBytes: downloaded, totalBytes: total }))
  const unpack = join(tools, `uv-${UV_VERSION}`)
  await fs.mkdir(unpack, { recursive: true })
  await run('/usr/bin/tar', ['-xzf', archive, '-C', unpack], signal)
  const extracted = await findExecutable(unpack, 'uv')
  if (!extracted) throw new Error('В архиве uv не найден исполняемый файл')
  await fs.copyFile(extracted, uv)
  await fs.chmod(uv, 0o755)
  return uv
}

async function copyVoices(root: string): Promise<string> {
  const source = join(app.getAppPath(), 'resources', 'voiceover-voices')
  const destination = join(root, 'voices')
  await fs.mkdir(destination, { recursive: true })
  for (const voice of VOICEOVER_VOICES) {
    const bundled = join(source, voice.referenceFile)
    if (!existsSync(bundled)) throw new Error(`В Kadr отсутствует голос №${voice.number}`)
    await fs.copyFile(bundled, join(destination, voice.referenceFile))
  }
  return destination
}

export async function installVoiceoverBackend(target: WebContents): Promise<InstalledVoiceoverRuntime> {
  if (installAbort) throw new Error('Установка F5-TTS уже выполняется')
  const controller = new AbortController()
  installAbort = controller
  const { signal } = controller
  try {
    const root = join(app.getPath('userData'), 'tts')
    const modelPath = join(root, 'model', 'model_20000_inference.safetensors')
    const vocabPath = join(root, 'model', 'vocab.txt')
    const venv = join(root, 'venv')
    const pythonPath = join(venv, 'bin', 'python')
    const configPath = join(homedir(), '.config', 'kadr', 'tts.json')
    const cachePath = join(root, 'cache')
    await fs.mkdir(root, { recursive: true })
    send(target, { stage: 'preparing', progress: 0.02, message: 'Подготавливаю локальную установку' })

    const uv = await ensureUv(root, signal, target)
    if (!existsSync(pythonPath)) {
      send(target, { stage: 'runtime', progress: 0.14, message: 'Устанавливаю изолированный Python 3.11' })
      await run(uv, ['venv', '--python', '3.11', '--python-preference', 'only-managed', venv], signal,
        { UV_PYTHON_INSTALL_DIR: join(root, 'python') })
    }

    send(target, { stage: 'packages', progress: 0.24, message: 'Устанавливаю F5-TTS и PyTorch' })
    await run(uv, ['pip', 'install', '--python', pythonPath, 'f5-tts==1.1.22',
      'soundfile==0.14.0'], signal, { UV_CACHE_DIR: join(root, 'uv-cache') })

    send(target, { stage: 'model', progress: 0.48, message: 'Скачиваю русскую модель F5-TTS' })
    await verifiedDownload(MODEL_URL, modelPath, MODEL_SHA256, signal, (downloaded, total) =>
      send(target, { stage: 'model', progress: 0.48 + 0.39 * (total ? downloaded / total : 0),
        message: 'Скачиваю русскую модель F5-TTS', downloadedBytes: downloaded, totalBytes: total }))
    await verifiedDownload(VOCAB_URL, vocabPath, VOCAB_SHA256, signal, () => {})

    send(target, { stage: 'voices', progress: 0.89, message: 'Устанавливаю 11 голосов' })
    const voicesPath = await copyVoices(root)

    send(target, { stage: 'validating', progress: 0.93, message: 'Проверяю модель и загружаю вокодер' })
    const validation = [
      'from f5_tts.api import F5TTS',
      `F5TTS(model="F5TTS_v1_Base", ckpt_file=${JSON.stringify(modelPath)}, ` +
        `vocab_file=${JSON.stringify(vocabPath)}, device="mps")`,
      'print("ready")'
    ].join(';')
    await run(pythonPath, ['-c', validation], signal,
      { HF_HOME: cachePath, TORCH_HOME: join(cachePath, 'torch') })

    const config: InstalledVoiceoverRuntime = {
      pythonPath,
      modelPath,
      vocabPath,
      voicesPath,
      cachePath,
      ffmpegPath: 'ffmpeg',
      configPath
    }
    await fs.mkdir(dirname(configPath), { recursive: true })
    const pending = `${configPath}.part`
    await fs.writeFile(pending, JSON.stringify({
      pythonPath, modelPath, vocabPath, voicesPath, cachePath, ffmpegPath: 'ffmpeg'
    }, null, 2) + '\n', 'utf8')
    await fs.rename(pending, configPath)
    send(target, { stage: 'done', progress: 1, message: 'F5-TTS установлен и готов' })
    return config
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    send(target, { stage: 'error', progress: 0, message })
    throw error
  } finally {
    installAbort = null
    installProcess = null
  }
}

export function cancelVoiceoverInstall() {
  installAbort?.abort()
  try { installProcess?.kill('SIGKILL') } catch { /* already stopped */ }
}
