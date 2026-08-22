import { app, BrowserWindow, ipcMain } from 'electron'
import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { join } from 'path'
import { promisify } from 'util'
import { FFMPEG } from './ffmpeg'
import { fragmentContentVersion, fragmentPreviewInfo } from './fragments'
import type { TimelineThumbnailFrame, TimelineThumbnailRequest } from '@shared/types'

const execFileP = promisify(execFile)
const CACHE_VERSION = 'filmstrip-v2'
const MAX_CACHE_BYTES = 512 * 1024 * 1024
const MAX_CACHE_AGE_MS = 30 * 24 * 60 * 60 * 1000

const cacheDir = () => join(app.getPath('userData'), 'timeline-thumbnails', CACHE_VERSION)
const sha = (value: string) => createHash('sha1').update(value).digest('hex')
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let thumbnailChain: Promise<unknown> = Promise.resolve()
let lastCleanup = 0

function normalizedRequest(request: TimelineThumbnailRequest): TimelineThumbnailRequest {
  if (!request || (request.kind !== 'media' && request.kind !== 'remotion')) {
    throw new Error('invalid thumbnail request')
  }
  const width = Math.max(48, Math.min(384, Math.round(Number(request.width) || 96)))
  const height = Math.max(28, Math.min(216, Math.round(Number(request.height) || 54)))
  const times = [...new Set((request.times ?? [])
    .map(Number)
    .filter((t) => Number.isFinite(t) && t >= 0)
    .map((t) => Math.round(t * 1000) / 1000))]
    .sort((a, b) => a - b)
    .slice(0, 32)
  if (!times.length) return { ...request, width, height, times }
  if (request.kind === 'media' && !request.sourcePath) throw new Error('sourcePath is required')
  if (request.kind === 'remotion' && !request.fragmentId) throw new Error('fragmentId is required')
  return { ...request, width, height, times }
}

async function readDataUrl(path: string, mime: string): Promise<string> {
  const data = await fs.readFile(path)
  return `data:${mime};base64,${data.toString('base64')}`
}

async function atomicGenerate(path: string, generate: (tmp: string) => Promise<void>): Promise<void> {
  try {
    await fs.access(path)
    return
  } catch { /* cache miss */ }
  await fs.mkdir(cacheDir(), { recursive: true })
  const ext = path.endsWith('.png') ? '.png' : '.jpg'
  const tmp = join(cacheDir(), `${randomUUID()}.part${ext}`)
  try {
    await generate(tmp)
    const st = await fs.stat(tmp)
    if (st.size < 64) throw new Error('thumbnail encoder produced an empty image')
    await fs.rename(tmp, path).catch(async (err: NodeJS.ErrnoException) => {
      if (err.code !== 'EEXIST') throw err
    })
  } finally {
    await fs.unlink(tmp).catch(() => { /* already renamed or never created */ })
  }
}

async function mediaFrames(request: TimelineThumbnailRequest): Promise<TimelineThumbnailFrame[]> {
  const source = request.sourcePath!
  const stat = await fs.stat(source)
  if (!stat.isFile()) throw new Error('thumbnail source is not a file')
  const sourceVersion = sha(`${source}:${stat.size}:${Math.round(stat.mtimeMs)}:${request.cacheKey ?? ''}`)
  const out: TimelineThumbnailFrame[] = []
  for (const time of request.times) {
    const key = sha(`${CACHE_VERSION}:media:${sourceVersion}:${time}:${request.width}x${request.height}`)
    const path = join(cacheDir(), `${key}.jpg`)
    try {
      await atomicGenerate(path, async (tmp) => {
        await execFileP(FFMPEG, [
          '-y', '-v', 'error', '-ss', String(time), '-i', source,
          '-map', '0:v:0', '-frames:v', '1', '-an',
          '-vf',
          `scale=${request.width}:${request.height}:force_original_aspect_ratio=decrease,` +
            `pad=${request.width}:${request.height}:(ow-iw)/2:(oh-ih)/2:color=black,format=yuvj420p`,
          // Some packaged FFmpeg builds fail to initialize the threaded MJPEG
          // encoder for tiny images. A single thread is cheap at filmstrip size.
          '-threads', '1', '-q:v', '5', tmp
        ], { maxBuffer: 2 * 1024 * 1024 })
      })
      out.push({ time, dataUrl: await readDataUrl(path, 'image/jpeg') })
    } catch {
      // Return the healthy frames from the batch. One awkward timestamp near
      // EOF must not blank the entire filmstrip.
    }
  }
  return out
}

async function remotionFrames(request: TimelineThumbnailRequest): Promise<TimelineThumbnailFrame[]> {
  const id = request.fragmentId!
  const info = await fragmentPreviewInfo(id)
  const version = sha(`${info.version}:${request.cacheKey ?? ''}`)
  const out: TimelineThumbnailFrame[] = []
  const missing: Array<{ time: number; path: string }> = []
  for (const time of request.times) {
    const key = sha(`${CACHE_VERSION}:remotion:${id}:${version}:${time}:${request.width}x${request.height}`)
    const path = join(cacheDir(), `${key}.png`)
    try {
      out.push({ time, dataUrl: await readDataUrl(path, 'image/png') })
    } catch {
      missing.push({ time, path })
    }
  }
  if (!missing.length) return out.sort((a, b) => a.time - b.time)

  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    width: request.width,
    height: request.height,
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  win.setContentSize(request.width, request.height)
  win.webContents.setFrameRate(30)
  try {
    await win.loadURL(`${info.url}/?comp=${encodeURIComponent(id)}`)
    await delay(450)
    for (const item of missing) {
      const frame = Math.max(0, Math.round(item.time * info.fps))
      await win.webContents.executeJavaScript(
        `window.postMessage(${JSON.stringify({
          kadr: true, type: 'sync', frame, playing: false, volume: 0
        })}, '*'); 0`,
        true
      )
      await delay(140)
      await atomicGenerate(item.path, async (tmp) => {
        const image = await win.webContents.capturePage()
        await fs.writeFile(tmp, image.toPNG())
      })
      out.push({ time: item.time, dataUrl: await readDataUrl(item.path, 'image/png') })
    }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
  return out.sort((a, b) => a.time - b.time)
}

async function cleanupCache(): Promise<void> {
  if (Date.now() - lastCleanup < 60 * 60 * 1000) return
  lastCleanup = Date.now()
  let names: string[]
  try { names = await fs.readdir(cacheDir()) } catch { return }
  const entries = (await Promise.all(names.map(async (name) => {
    const path = join(cacheDir(), name)
    try {
      const stat = await fs.stat(path)
      return { path, size: stat.size, mtimeMs: stat.mtimeMs }
    } catch { return null }
  }))).filter((x): x is NonNullable<typeof x> => !!x)
  const now = Date.now()
  for (const entry of entries) {
    if (now - entry.mtimeMs > MAX_CACHE_AGE_MS) await fs.unlink(entry.path).catch(() => {})
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0)
  if (total <= MAX_CACHE_BYTES) return
  for (const entry of entries.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    await fs.unlink(entry.path).catch(() => {})
    total -= entry.size
    if (total <= MAX_CACHE_BYTES * 0.85) break
  }
}

async function visualFingerprint(paths: string[], fragmentIds: string[]): Promise<string> {
  const parts: string[] = [CACHE_VERSION]
  for (const path of [...new Set(paths)].sort()) {
    try {
      const st = await fs.stat(path)
      parts.push(`m:${path}:${st.size}:${Math.round(st.mtimeMs)}`)
    } catch {
      parts.push(`m:${path}:missing`)
    }
  }
  for (const id of [...new Set(fragmentIds)].sort()) {
    try { parts.push(`f:${id}:${fragmentContentVersion(id)}`) }
    catch { parts.push(`f:${id}:missing`) }
  }
  return sha(parts.join('\n'))
}

export function registerThumbnailIpc(): void {
  ipcMain.handle('thumbnail:timeline', (_event, raw: TimelineThumbnailRequest) => {
    const request = normalizedRequest(raw)
    const job = thumbnailChain.then(() =>
      request.kind === 'media' ? mediaFrames(request) : remotionFrames(request)
    )
    thumbnailChain = job.catch(() => { /* a bad source must not stop later jobs */ })
    void cleanupCache()
    return job
  })
  ipcMain.handle('visual:fingerprint', (_event, paths: string[], fragmentIds: string[]) =>
    visualFingerprint(Array.isArray(paths) ? paths : [], Array.isArray(fragmentIds) ? fragmentIds : [])
  )
}
