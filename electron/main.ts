import { app, BrowserWindow, ipcMain, dialog, protocol, net, clipboard, Menu, screen } from 'electron'
import type { WebContents } from 'electron'
import { join, dirname, basename, extname, resolve } from 'path'
import { buildDockMenu, buildMenu } from './menu'
import { promises as fs, createReadStream, statSync, existsSync, appendFileSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { createHash } from 'crypto'
import { execFile, execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import {
  probeMedia, makeProxy, validateProxy, makeDecoded, makeReversed,
  measureLoudness, ExportMuxer, RawVideoEncoder
} from './ffmpeg'
import { registerClaudeIpc } from './claude'
import { registerTranscribeIpc } from './transcribe'
import { bundleFragments, registerFragmentIpc } from './fragments'
import { registerVoiceoverIpc } from './voiceover'
import { registerThumbnailIpc } from './thumbnails'
import { writeHtmlPlayerExport } from './html-player'
import {
  embedProjectVoiceClones,
  packageProject,
  projectForDisk,
  readProjectFile
} from './project-package'
import type {
  ExportJob, HtmlPlayerExportRequest, Project, ProjectPackageOptions, ProxyBuildUpdate
} from '@shared/types'

// Streamed local media under a privileged scheme so the renderer can play
// file content regardless of its own origin (http in dev, file in prod).
// corsEnabled is required since Chromium ~136: without it a kadr:// <video>
// is treated as cross-origin, so its pixels are "tainted" and can't be
// uploaded to WebGL (texImage2D throws) — black preview and black export.
// The media response sends Access-Control-Allow-Origin:* and the elements
// set crossOrigin='anonymous', so the CORS check then passes and untaints.
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kadr',
    privileges: { secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true }
  }
])

// Don't touch the OS keyring (gnome-keyring/libsecret): Chromium ≥ some
// recent version otherwise pops a "unlock keyring" password dialog on
// launch to encrypt its cookie/storage store. Kadr keeps no web secrets,
// so the in-app "basic" store is correct — and it means no prompt.
app.commandLine.appendSwitch('password-store', 'basic')

// The dmenu/X-session environment on this machine can carry a malformed
// DBUS_SESSION_BUS_ADDRESS ("Could not parse server address" in the log) —
// then Chromium and our portal helper can't reach the session bus, and a
// drag from an XDG-portal source (application/vnd.portal.filetransfer)
// delivers nothing. Normalize to the live user socket when needed.
{
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS
  if (!addr || !/^(unix|tcp):/.test(addr)) {
    const sock = `/run/user/${typeof process.getuid === 'function' ? process.getuid() : 1000}/bus`
    if (existsSync(sock)) process.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${sock}`
  }
}

// A GUI app launched from Finder/LaunchServices inherits only a minimal PATH
// (/usr/bin:/bin:/usr/sbin:/sbin) — none of Homebrew, ~/.local/bin, nvm, etc.
// That silently breaks every external tool the editor shells out to: the
// `claude` CLI (its PTY just exits → "session ended"), `node` for the MCP
// bridge, and ffmpeg/ffprobe/python3. So adopt the user's real login-shell
// PATH before anything spawns. Only needed for packaged macOS launches; a
// dev run already inherits the terminal's environment.
function fixUserPath() {
  if (process.platform !== 'darwin' || !app.isPackaged) return
  const fallback = [
    '/opt/homebrew/bin', '/opt/homebrew/sbin',
    '/usr/local/bin', '/usr/local/sbin',
    join(homedir(), '.local/bin'),
    '/usr/bin', '/bin', '/usr/sbin', '/sbin'
  ]
  let shellPath = ''
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    // login+interactive so ~/.zprofile / ~/.zshrc (nvm, pyenv, custom dirs)
    // are sourced; markers isolate $PATH from any shell-startup banner noise.
    const out = execFileSync(shell, ['-ilc', 'printf "_KP_<%s>_KP_" "$PATH"'], {
      encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore']
    })
    shellPath = out.match(/_KP_<(.*)>_KP_/)?.[1] ?? ''
  } catch { /* shell unavailable — fall back to the known dirs */ }
  const parts = [...shellPath.split(':'), ...fallback].filter(Boolean)
  process.env.PATH = [...new Set(parts)].join(':')
}
fixUserPath()

// Hardware video encode/decode. On Linux this means VAAPI (Intel/AMD iGPU);
// macOS and Windows already expose their native accelerators (VideoToolbox /
// Media Foundation) to Chromium + WebCodecs without these Linux-only flags,
// and forcing them off-platform only risks the GPU sandbox. WebCodecs then
// picks the hardware path up via hardwareAcceleration: 'prefer-hardware'.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
  app.commandLine.appendSwitch(
    'enable-features',
    'VaapiVideoEncoder,VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,AcceleratedVideoEncoder'
  )
}

// Last line of defense: a stray async error (e.g. a stream racing a request
// abort) must be logged, not shown as a modal error dialog over the editor.
process.on('uncaughtException', (err) => {
  console.error('[kadr] uncaught exception in main:', err)
})

const editorWindows = new Set<BrowserWindow>()
const initialProjects = new Map<number, string>()
const windowProjects = new Map<BrowserWindow, string>()
const pendingProjectPaths: string[] = []

function focusedEditorWindow(): BrowserWindow | null {
  const focused = BrowserWindow.getFocusedWindow()
  if (focused && editorWindows.has(focused)) return focused
  return [...editorWindows].at(-1) ?? null
}

function senderWindow(sender: WebContents): BrowserWindow {
  const owner = BrowserWindow.fromWebContents(sender)
  if (!owner || !editorWindows.has(owner)) throw new Error('no editor window')
  return owner
}

function sendTo(sender: WebContents, channel: string, ...args: unknown[]) {
  if (!sender.isDestroyed()) sender.send(channel, ...args)
}

function projectKey(path: string): string {
  return resolve(path)
}

function focusWindow(win: BrowserWindow) {
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function openProjectWindow(path: string): BrowserWindow {
  const key = projectKey(path)
  app.addRecentDocument(key)
  const existing = [...windowProjects].find(([win, current]) => !win.isDestroyed() && current === key)?.[0]
  if (existing) {
    focusWindow(existing)
    return existing
  }
  return createWindow(key)
}

function safePreviewPosition(features: string): { x?: number; y?: number } {
  const values = new Map(
    features.split(',').map((part) => {
      const [key, value = ''] = part.split('=', 2)
      return [key.trim(), value.trim()]
    })
  )
  const x = Number(values.get('left') ?? values.get('x'))
  const y = Number(values.get('top') ?? values.get('y'))
  const width = Number(values.get('width')) || 960
  const height = Number(values.get('height')) || 540
  if (!Number.isFinite(x) || !Number.isFinite(y)) return {}

  const visible = screen.getAllDisplays().some(({ workArea }) => {
    const overlapW = Math.min(x + width, workArea.x + workArea.width) - Math.max(x, workArea.x)
    const overlapH = Math.min(y + height, workArea.y + workArea.height) - Math.max(y, workArea.y)
    return overlapW >= 80 && overlapH >= 40
  })
  if (visible) return {}

  const { workArea } = screen.getPrimaryDisplay()
  return {
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2)
  }
}

function createWindow(initialProjectPath?: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#15171c',
    title: 'Kadr',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      // page and preload share one JS context: export frames reach the
      // preload-spawned ffmpeg by reference — any bridge/IPC route copies
      // ~8 MB per 1080p frame at only a few hundred MB/s and dominates
      // render time. The renderer loads local content only.
      contextIsolation: false,
      sandbox: false
    }
  })
  const windowId = win.webContents.id
  editorWindows.add(win)
  if (initialProjectPath) {
    const key = projectKey(initialProjectPath)
    initialProjects.set(windowId, key)
    windowProjects.set(win, key)
  }
  win.on('closed', () => {
    editorWindows.delete(win)
    initialProjects.delete(windowId)
    windowProjects.delete(win)
    htmlExportAborts.get(windowId)?.abort()
    void cleanupExport(windowId)
  })
  win.setMenuBarVisibility(false)
  win.webContents.setWindowOpenHandler(({ frameName, features }) => {
    if (frameName !== 'kadr-preview') return { action: 'allow' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        minWidth: 480,
        minHeight: 320,
        backgroundColor: '#15171c',
        autoHideMenuBar: true,
        title: 'Kadr — Preview',
        ...safePreviewPosition(features)
      }
    }
  })
  win.webContents.on('did-create-window', (child, details) => {
    if (details.frameName === 'kadr-preview') child.setMenuBarVisibility(false)
  })
  // A renderer crash should close only its editor window. Other projects are
  // independent and must keep running.
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') {
      console.error('[kadr] renderer gone:', details.reason, '— closing window')
      if (!win.isDestroyed()) win.destroy()
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return win
}

// Finder and LaunchServices reuse the running process on macOS. Register the
// handler before `ready`, otherwise a project dropped on the Dock or opened
// while Kadr is closed can be lost.
app.on('open-file', (event, path) => {
  event.preventDefault()
  if (extname(path).toLowerCase() !== '.kadr') return
  if (!app.isReady()) pendingProjectPaths.push(projectKey(path))
  else openProjectWindow(path)
})

/**
 * Wrap a Node read stream into a Web ReadableStream with guarded
 * enqueue/close: the renderer aborts kadr:// requests mid-flight all the
 * time (reloads, <video> src swaps, seeks), and a close() racing the abort
 * must not become an uncaught exception in the main process.
 */
function streamBody(stream: ReturnType<typeof createReadStream>): ReadableStream<Uint8Array> {
  let alive = true
  return new ReadableStream({
    start(controller) {
      stream.on('data', (chunk) => {
        if (!alive) return
        try {
          controller.enqueue(new Uint8Array(chunk as Buffer))
        } catch {
          alive = false
          stream.destroy()
          return
        }
        if ((controller.desiredSize ?? 1) <= 0) stream.pause()
      })
      stream.on('end', () => {
        if (!alive) return
        alive = false
        try { controller.close() } catch { /* consumer already gone */ }
      })
      stream.on('error', (err) => {
        if (!alive) return
        alive = false
        try { controller.error(err) } catch { /* consumer already gone */ }
      })
    },
    pull() {
      stream.resume()
    },
    cancel() {
      alive = false
      stream.destroy()
    }
  })
}

function mediaContentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case '.wav': return 'audio/wav'
    case '.mp3': return 'audio/mpeg'
    case '.m4a': return 'audio/mp4'
    case '.aac': return 'audio/aac'
    case '.flac': return 'audio/flac'
    case '.ogg': return 'audio/ogg'
    case '.mp4': return 'video/mp4'
    case '.mov': return 'video/quicktime'
    case '.webm': return 'video/webm'
    case '.png': return 'image/png'
    case '.jpg':
    case '.jpeg': return 'image/jpeg'
    case '.webp': return 'image/webp'
    case '.gif': return 'image/gif'
    default: return 'application/octet-stream'
  }
}

function mediaResponse(filePath: string, rangeHeader: string | null): Response {
  const stat = statSync(filePath)
  const size = stat.size
  const contentType = mediaContentType(filePath)
  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/)
  // CORS header keeps WebAudio (MediaElementSource) from silencing the stream
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10))
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
    return new Response(streamBody(createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${end}/${size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': String(end - start + 1),
        'Access-Control-Allow-Origin': '*'
      }
    })
  }
  return new Response(streamBody(createReadStream(filePath)), {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Access-Control-Allow-Origin': '*'
    }
  })
}

app.whenReady().then(() => {
  protocol.handle('kadr', (request) => {
    const url = new URL(request.url)
    let filePath = decodeURIComponent(url.pathname)
    // Windows drive paths travel as /D:/dir/file — drop the URL's leading
    // slash so fs gets D:/dir/file (node accepts forward slashes there)
    if (/^\/[A-Za-z]:[/\\]/.test(filePath)) filePath = filePath.slice(1)
    try {
      return mediaResponse(filePath, request.headers.get('range'))
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  Menu.setApplicationMenu(buildMenu(focusedEditorWindow, createWindow))
  app.dock?.setMenu(buildDockMenu(createWindow))
  registerIpc()
  registerClaudeIpc()
  registerTranscribeIpc()
  registerFragmentIpc()
  registerThumbnailIpc()
  registerVoiceoverIpc()
  if (pendingProjectPaths.length) {
    for (const path of [...new Set(pendingProjectPaths)]) openProjectWindow(path)
    pendingProjectPaths.length = 0
  } else {
    createWindow()
  }
  app.on('activate', () => {
    if (!editorWindows.size) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
    // an in-flight export/muxer or any stray handle must never keep a
    // windowless process alive — a lingering instance blocks the next
    // launch and reads as "the editor won't open anymore"
    setTimeout(() => app.exit(0), 2500)
  }
})

app.on('before-quit', () => {
  for (const controller of htmlExportAborts.values()) controller.abort()
  for (const [windowId, state] of exportStates) {
    state.muxer?.cancel()
    void cleanupExport(windowId)
  }
})

// ---------------------------------------------------------------------------

const MEDIA_FILTERS = [
  { name: 'Media and scripts', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mts', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'opus', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'srt', 'txt', 'doc', 'docx'] },
  { name: 'All files', extensions: ['*'] }
]
const PROJECT_FILTERS = [{ name: 'Kadr project', extensions: ['kadr'] }]

type ExportState = {
  job: ExportJob
  videoTemp: string
  fh: fs.FileHandle | null
  muxer: ExportMuxer | null
  raw: RawVideoEncoder | null
  rawEncoded: boolean
  /** WebSocket frame transport: Electron IPC serializes ~8 MB per 1080p
      frame at only ~400 MB/s (≈20 ms of renderer main-thread per frame) —
      a local binary WebSocket moves the same data several times faster */
  rawWss: import('ws').WebSocketServer | null
  rawChain: Promise<void>
  rawErr: Error | null
}
const exportStates = new Map<number, ExportState>()
const htmlExportAborts = new Map<number, AbortController>()

function sendProgress(sender: WebContents, p: import('@shared/types').ExportProgress) {
  sendTo(sender, 'export:progress', p)
}

// app-wide JSON stores (presets etc.) in userData — independent of the
// renderer profile, so they survive restarts and concurrent instances
const userStorePath = (name: string) =>
  join(app.getPath('userData'), `${name.replace(/[^a-z0-9-]/gi, '')}.json`)

// Preview proxies: keyed by source identity + encode profile, built one at a
// time (weak CPU). Changing the profile version automatically retires old
// low-quality caches without having to scan or delete the cache directory.
const proxyDir = () => join(app.getPath('userData'), 'proxies')
const storyboardDir = () => join(app.getPath('userData'), 'storyboards')
let lastStoryboardCleanup = 0

async function cleanupStoryboardCache(): Promise<void> {
  if (Date.now() - lastStoryboardCleanup < 60 * 60 * 1000) return
  lastStoryboardCleanup = Date.now()
  let names: string[]
  try { names = await fs.readdir(storyboardDir()) } catch { return }
  const entries = (await Promise.all(names.map(async (name) => {
    const path = join(storyboardDir(), name)
    try {
      const stat = await fs.stat(path)
      return stat.isDirectory() ? { path, mtimeMs: stat.mtimeMs } : null
    } catch { return null }
  }))).filter((entry): entry is NonNullable<typeof entry> => !!entry)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
  for (const [index, entry] of entries.entries()) {
    if (index >= 24 || entry.mtimeMs < cutoff) {
      await fs.rm(entry.path, { recursive: true, force: true }).catch(() => {})
    }
  }
}

const PROXY_PROFILE_VERSION = 'v2-portrait-720-crf22'
const PROXY_MAX_ATTEMPTS = 3
let proxyChain: Promise<unknown> = Promise.resolve()
const validatedProxies = new Map<string, string>()

function proxyError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1000)
}

function proxyUpdate(
  sender: WebContents,
  srcPath: string,
  update: Omit<ProxyBuildUpdate, 'path'>
) {
  sendTo(sender, 'proxy:progress', { path: srcPath, ...update } satisfies ProxyBuildUpdate)
}

async function proxyIsValid(path: string, duration: number): Promise<boolean> {
  try {
    const stat = await fs.stat(path)
    const identity = `${stat.size}:${Math.round(stat.mtimeMs)}`
    if (validatedProxies.get(path) === identity) return true
    await validateProxy(path, duration)
    validatedProxies.set(path, identity)
    return true
  } catch {
    validatedProxies.delete(path)
    await fs.unlink(path).catch(() => { /* already absent or in use */ })
    return false
  }
}

async function publishProxy(temp: string, out: string): Promise<void> {
  try {
    // Same-directory rename is atomic on the common desktop filesystems and
    // replaces the old proxy only after the new one has passed validation.
    await fs.rename(temp, out)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EEXIST' && code !== 'EPERM') throw error
    // Windows can refuse rename-over-existing. Preserve the valid old proxy
    // as a rollback target until the new file is in its final location.
    const backup = `${out}.${process.pid}.old`
    await fs.unlink(backup).catch(() => { /* stale backup absent */ })
    await fs.rename(out, backup)
    try {
      await fs.rename(temp, out)
      await fs.unlink(backup).catch(() => { /* cleanup is best effort */ })
    } catch (publishError) {
      await fs.rename(backup, out).catch(() => { /* retain original error */ })
      throw publishError
    }
  }
}

const proxyBackoff = (attempt: number) => new Promise<void>((resolveDelay) => {
  setTimeout(resolveDelay, 750 * (2 ** (attempt - 1)))
})

async function requestProxy(
  sender: WebContents,
  srcPath: string,
  duration: number,
  force = false
): Promise<string> {
  const stat = statSync(srcPath)
  const key = createHash('sha1')
    .update(`${PROXY_PROFILE_VERSION}:${srcPath}:${stat.size}:${Math.round(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 20)
  const out = join(proxyDir(), `${key}.mp4`)
  await fs.mkdir(proxyDir(), { recursive: true })
  if (!force && await proxyIsValid(out, duration)) {
    proxyUpdate(sender, srcPath, { state: 'ready', progress: 1, cached: true })
    return out
  }
  proxyUpdate(sender, srcPath, { state: 'queued', progress: 0, attempt: 1 })

  const job = proxyChain.then(async () => {
    if (!force && await proxyIsValid(out, duration)) {
      proxyUpdate(sender, srcPath, { state: 'ready', progress: 1, cached: true })
      return out
    }

    let lastError: unknown = new Error('proxy generation did not start')
    for (let attempt = 1; attempt <= PROXY_MAX_ATTEMPTS; attempt++) {
      const tmp = join(proxyDir(), `${key}.${process.pid}.${Date.now()}.${attempt}.part.mp4`)
      try {
        proxyUpdate(sender, srcPath, { state: 'building', progress: 0, attempt })
        await makeProxy(srcPath, tmp, duration, (progress) => {
          proxyUpdate(sender, srcPath, { state: 'building', progress, attempt })
        })
        proxyUpdate(sender, srcPath, { state: 'validating', progress: 1, attempt })
        await validateProxy(tmp, duration)
        await publishProxy(tmp, out)
        const outStat = await fs.stat(out)
        validatedProxies.set(out, `${outStat.size}:${Math.round(outStat.mtimeMs)}`)
        proxyUpdate(sender, srcPath, { state: 'ready', progress: 1, attempt, cached: false })
        return out
      } catch (error) {
        lastError = error
        await fs.unlink(tmp).catch(() => { /* partial output absent */ })
        if (attempt < PROXY_MAX_ATTEMPTS) {
          const retryInMs = 750 * (2 ** (attempt - 1))
          proxyUpdate(sender, srcPath, {
            state: 'retrying', progress: 0, attempt, retryInMs, error: proxyError(error)
          })
          await proxyBackoff(attempt)
        }
      }
    }
    const message = proxyError(lastError)
    proxyUpdate(sender, srcPath, {
      state: 'error', progress: 0, attempt: PROXY_MAX_ATTEMPTS, error: message
    })
    throw new Error(`proxy generation failed after ${PROXY_MAX_ATTEMPTS} attempts: ${message}`)
  })
  proxyChain = job.catch(() => { /* keep the queue alive */ })
  return job
}

// full-res H.264 intermediates for sources Chromium cannot decode (export
// reads these instead of the original video stream; audio still reads the
// original). Same identity key and queue discipline as proxies.
const decodedDir = () => join(app.getPath('userData'), 'decoded')
let decodedChain: Promise<unknown> = Promise.resolve()

async function requestDecoded(sender: WebContents, srcPath: string, duration: number): Promise<string> {
  const stat = statSync(srcPath)
  const key = createHash('sha1')
    .update(`${srcPath}:${stat.size}:${Math.round(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 20)
  const out = join(decodedDir(), `${key}.mp4`)
  try {
    await fs.access(out)
    return out
  } catch { /* not built yet */ }
  await fs.mkdir(decodedDir(), { recursive: true })
  const job = decodedChain.then(async () => {
    try {
      await fs.access(out)
      return // built while we waited in the queue
    } catch { /* still missing */ }
    const tmp = join(decodedDir(), `${key}.part.mp4`)
    try {
      await makeDecoded(srcPath, tmp, duration, (p) => {
        sendTo(sender, 'proxy:progress', { path: srcPath, progress: p })
      })
      await fs.rename(tmp, out)
    } catch (err) {
      fs.unlink(tmp).catch(() => { /* nothing to clean */ })
      throw err
    }
  })
  decodedChain = job.catch(() => { /* keep the queue alive */ })
  await job
  sendTo(sender, 'proxy:progress', { path: srcPath, progress: 1 })
  return out
}

// reversed renders: keyed by source identity + range, built one at a time
const reverseDir = () => join(app.getPath('userData'), 'reversed')
let reverseChain: Promise<unknown> = Promise.resolve()

async function requestReversed(
  sender: WebContents,
  srcPath: string,
  start: number,
  duration: number,
  info: { kind: string; hasAudio: boolean; width: number; height: number; fps: number }
): Promise<string> {
  const stat = statSync(srcPath)
  const key = createHash('sha1')
    .update(`${srcPath}:${stat.size}:${Math.round(stat.mtimeMs)}:${start.toFixed(3)}:${duration.toFixed(3)}`)
    .digest('hex')
    .slice(0, 20)
  const out = join(reverseDir(), `${key}.${info.kind === 'video' ? 'mp4' : 'wav'}`)
  try {
    await fs.access(out)
    return out
  } catch { /* not built yet */ }
  await fs.mkdir(reverseDir(), { recursive: true })
  const job = reverseChain.then(async () => {
    try {
      await fs.access(out)
      return // built while queued
    } catch { /* still missing */ }
    const tmp = join(reverseDir(), `${key}.part.${info.kind === 'video' ? 'mp4' : 'wav'}`)
    try {
      await makeReversed(srcPath, start, duration, tmp, info, join(reverseDir(), `${key}.tmp`), (p) => {
        sendTo(sender, 'reverse:progress', { path: srcPath, start, duration, progress: p })
      })
      await fs.rename(tmp, out)
    } catch (err) {
      fs.unlink(tmp).catch(() => { /* nothing to clean */ })
      throw err
    }
  })
  reverseChain = job.catch(() => { /* keep the queue alive */ })
  await job
  sendTo(sender, 'reverse:progress', { path: srcPath, start, duration, progress: 1 })
  return out
}

// every save/open dialog remembers its last directory; the first run lands
// in Videos/Downloads — never in the app's working directory, where renders
// silently disappear from the user's sight
const DIRS_STORE = 'last-dirs'

async function lastDir(kind: string): Promise<string> {
  try {
    const data = JSON.parse(await fs.readFile(userStorePath(DIRS_STORE), 'utf8'))
    const d = data?.[kind]
    if (typeof d === 'string') {
      await fs.access(d)
      return d
    }
  } catch { /* first run */ }
  try {
    return app.getPath('videos')
  } catch {
    return app.getPath('downloads')
  }
}

async function rememberDir(kind: string, filePath: string) {
  try {
    let data: Record<string, string> = {}
    try {
      data = JSON.parse(await fs.readFile(userStorePath(DIRS_STORE), 'utf8'))
    } catch { /* fresh store */ }
    data[kind] = dirname(filePath)
    await fs.writeFile(userStorePath(DIRS_STORE), JSON.stringify(data, null, 1))
  } catch { /* best effort */ }
}

function registerIpc() {
  ipcMain.on('window:new', (event) => {
    senderWindow(event.sender)
    createWindow()
  })

  ipcMain.handle('window:initial-project', (event) => {
    const path = initialProjects.get(event.sender.id) ?? null
    initialProjects.delete(event.sender.id)
    return path
  })

  ipcMain.on('window:project-state', (event, state: {
    path: string | null
    name: string
    dirty: boolean
  }) => {
    const win = senderWindow(event.sender)
    const path = typeof state.path === 'string' && state.path ? projectKey(state.path) : null
    const name = typeof state.name === 'string' && state.name.trim() ? state.name.trim() : 'Untitled'
    if (path) {
      const changed = windowProjects.get(win) !== path
      windowProjects.set(win, path)
      if (changed) {
        if (process.platform === 'darwin') win.setRepresentedFilename(path)
        app.addRecentDocument(path)
      }
    } else {
      windowProjects.delete(win)
      if (process.platform === 'darwin') win.setRepresentedFilename('')
    }
    if (process.platform === 'darwin') win.setDocumentEdited(Boolean(state.dirty))
    win.setTitle(`${name} — Kadr`)
  })

  ipcMain.handle('proxy:request', (event, srcPath: string, duration: number) =>
    requestProxy(event.sender, srcPath, duration)
  )

  ipcMain.handle('proxy:rebuild', (event, srcPath: string, duration: number) =>
    requestProxy(event.sender, srcPath, duration, true)
  )

  ipcMain.handle('media:decoded', (event, srcPath: string, duration: number) =>
    requestDecoded(event.sender, srcPath, duration)
  )

  ipcMain.handle('media:loudness', (_e, srcPath: string, start: number, duration: number) =>
    measureLoudness(srcPath, start, duration)
  )

  ipcMain.handle(
    'media:reverse',
    (event, srcPath: string, start: number, duration: number, info: {
      kind: string; hasAudio: boolean; width: number; height: number; fps: number
    }) => requestReversed(event.sender, srcPath, start, duration, info)
  )

  ipcMain.handle('store:read', async (_e, name: string) => {
    try {
      return JSON.parse(await fs.readFile(userStorePath(name), 'utf8'))
    } catch {
      return null
    }
  })

  ipcMain.handle('store:write', async (_e, name: string, data: unknown) => {
    await fs.writeFile(userStorePath(name), JSON.stringify(data, null, 1))
  })

  ipcMain.handle('media:open-dialog', async (event) => {
    const r = await dialog.showOpenDialog(senderWindow(event.sender), {
      properties: ['openFile', 'multiSelections'],
      defaultPath: await lastDir('media'),
      filters: MEDIA_FILTERS
    })
    if (r.canceled || !r.filePaths.length) return []
    void rememberDir('media', r.filePaths[0])
    return r.filePaths
  })

  ipcMain.handle('media:probe', (_e, path: string) => probeMedia(path))

  // sanitized basename + MIME-derived extension for downloaded/pasted media
  const mediaBase = (name: string, mime: string): string => {
    let base = (name || 'media').replace(/[^\w.-]+/g, '_').slice(-80) || 'media'
    if (!/\.[a-z0-9]{2,4}$/i.test(base)) {
      const extByMime: Record<string, string> = {
        'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
        'image/gif': '.gif', 'image/bmp': '.bmp', 'video/mp4': '.mp4',
        'video/webm': '.webm', 'video/quicktime': '.mov', 'audio/mpeg': '.mp3',
        'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg',
        'audio/mp4': '.m4a', 'audio/flac': '.flac'
      }
      const ct = (mime || '').split(';')[0].trim()
      if (extByMime[ct]) base += extByMime[ct]
    }
    return base
  }
  const importedDir = async (): Promise<string> => {
    const dir = join(app.getPath('userData'), 'imported')
    await fs.mkdir(dir, { recursive: true })
    return dir
  }
  const writeImported = async (out: string, buf: Buffer): Promise<string> => {
    await fs.writeFile(out + '.part', buf)
    await fs.rename(out + '.part', out)
    return out
  }

  // Media dragged out of a browser arrives as an http(s) URL — download it
  // into userData/imported (cached by URL hash) and let the normal probe
  // flow take over. net.fetch goes through Chromium's network stack.
  ipcMain.handle('media:download', async (_e, url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('unsupported url')
    const dir = await importedDir()
    let name = 'media'
    try {
      name = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'media')
    } catch { /* keep default */ }
    const tag = createHash('sha1').update(url).digest('hex').slice(0, 10)
    const resp = await net.fetch(url)
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    const base = mediaBase(name, resp.headers.get('content-type') || '')
    const out = join(dir, `${tag}-${base}`)
    try {
      await fs.access(out)
      return out // same URL downloaded before
    } catch { /* proceed */ }
    const buf = Buffer.from(await resp.arrayBuffer())
    if (buf.length > 512 * 1024 * 1024) throw new Error('remote file too large (>512 MB)')
    if (!buf.length) throw new Error('empty response')
    return writeImported(out, buf)
  })

  // Files dragged from an XDG-portal source (GTK apps, sandboxed browsers):
  // the drop carries only a transfer key — the real paths come from the
  // FileTransfer portal over the session bus.
  ipcMain.handle('media:portal-files', async (_e, key: string) => {
    if (!/^[\w.-]+$/.test(key)) throw new Error('bad portal key')
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile('gdbus', [
        'call', '--session',
        '--dest', 'org.freedesktop.portal.Documents',
        '--object-path', '/org/freedesktop/portal/documents',
        '--method', 'org.freedesktop.portal.FileTransfer.RetrieveFiles',
        key, '{}'
      ], { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(out)))
    })
    // gdbus prints (['/path/a', '/path/b'],)
    const paths = [...stdout.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1])
    if (!paths.length) throw new Error(`no files in portal transfer: ${stdout.slice(0, 120)}`)
    return paths
  })

  // Clipboard paste (platform paste shortcut with an empty editor clipboard): copied FILES
  // (file managers put text/uri-list on the clipboard) win over a copied
  // IMAGE (e.g. Telegram's «Копировать изображение» — photos can't even be
  // dragged out of tdesktop, paste is the ergonomic route into the editor).
  ipcMain.handle('media:clipboard-paste', async () => {
    const paths: string[] = []
    const seen = new Set<string>()
    const addPath = (path: string) => {
      const clean = path.trim()
      if (clean && !seen.has(clean)) {
        seen.add(clean)
        paths.push(clean)
      }
    }
    const addFileUrl = (value: string) => {
      const url = value.trim()
      if (!url.toLowerCase().startsWith('file://')) return
      try { addPath(fileURLToPath(url)) } catch { /* malformed/non-local URL */ }
    }

    // Finder exposes copied files through native pasteboard types. Electron
    // normalizes availableFormats() to "text/uri-list" on macOS, but reading
    // that normalized type returns an empty string; readImage() then yields
    // Finder's generic PNG document icon instead of the file contents.
    // NSFilenamesPboardType carries every selected file, while public.file-url
    // is the reliable single-file fallback.
    if (process.platform === 'darwin') {
      try {
        const plist = clipboard.read('NSFilenamesPboardType') || ''
        const decodeXml = (value: string) => value.replace(
          /&(amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/gi,
          (entity, token: string) => {
            const named: Record<string, string> = {
              amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"
            }
            const lower = token.toLowerCase()
            if (named[lower]) return named[lower]
            const radix = lower.startsWith('#x') ? 16 : 10
            const digits = lower.slice(radix === 16 ? 2 : 1)
            const point = parseInt(digits, radix)
            try { return Number.isFinite(point) ? String.fromCodePoint(point) : entity }
            catch { return entity }
          }
        )
        for (const match of plist.matchAll(/<string>([\s\S]*?)<\/string>/g)) {
          addPath(decodeXml(match[1]))
        }
      } catch { /* pasteboard type absent */ }
      try { addFileUrl(clipboard.read('public.file-url') || '') } catch { /* type absent */ }
    }

    let uriList = ''
    try { uriList = clipboard.read('text/uri-list') || '' } catch { /* format absent */ }
    for (const line of uriList.split(/\r?\n/)) {
      const u = line.trim()
      if (!u || u.startsWith('#')) continue
      addFileUrl(u)
    }
    if (paths.length) return paths
    const img = clipboard.readImage()
    if (!img.isEmpty()) {
      const buf = img.toPNG()
      const dir = await importedDir()
      const tag = createHash('sha1').update(buf).digest('hex').slice(0, 10)
      const out = join(dir, `${tag}-clipboard.png`)
      try {
        await fs.access(out)
      } catch {
        await writeImported(out, buf)
      }
      return [out]
    }
    return []
  })

  // drop forensics from the renderer — survives the window being closed
  ipcMain.on('debug:drop-log', (_e, entry: unknown) => {
    try {
      appendFileSync(join(app.getPath('userData'), 'drop-log.jsonl'), JSON.stringify(entry) + '\n')
    } catch { /* diagnostics must never break anything */ }
  })

  // Raw media content (a path-less File or a data: URL from a browser drag)
  // saved into the same cache, keyed by content hash.
  ipcMain.handle('media:save-blob', async (_e, name: string, mime: string, data: Uint8Array) => {
    if (!data?.byteLength) throw new Error('empty blob')
    if (data.byteLength > 512 * 1024 * 1024) throw new Error('blob too large (>512 MB)')
    const dir = await importedDir()
    const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    const tag = createHash('sha1').update(buf).digest('hex').slice(0, 10)
    const out = join(dir, `${tag}-${mediaBase(name, mime)}`)
    try {
      await fs.access(out)
      return out // identical content saved before
    } catch { /* proceed */ }
    return writeImported(out, buf)
  })

  ipcMain.handle('dialog:pick-dir', async (event, title?: string) => {
    const r = await dialog.showOpenDialog(senderWindow(event.sender), {
      title: title || undefined,
      properties: ['openDirectory', 'createDirectory']
    })
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0]
  })

  // frame snapshots: PNG next to the project file (Downloads when the
  // project was never saved and no dir was chosen)
  ipcMain.handle('snapshot:save', async (_e, dir: string | null, baseName: string, png: ArrayBuffer) => {
    if (!png?.byteLength) throw new Error('empty snapshot')
    // without an XDG DOWNLOAD entry getPath('downloads') degrades to $HOME —
    // prefer the real ~/Downloads when it exists
    let fallback = app.getPath('downloads')
    if (fallback === app.getPath('home')) {
      const dl = join(app.getPath('home'), 'Downloads')
      try { await fs.access(dl); fallback = dl } catch { /* keep home */ }
    }
    const target = dir || fallback
    await fs.mkdir(target, { recursive: true })
    const safe = baseName.replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 120) || 'frame'
    let out = join(target, `${safe}.png`)
    for (let i = 1; i < 1000; i++) {
      try {
        await fs.access(out)
        out = join(target, `${safe}.${i}.png`)
      } catch { break }
    }
    await fs.writeFile(out, Buffer.from(png))
    return out
  })

  // Agent storyboards are disposable visual cache, not user media. Stable
  // paths let force refresh replace stale pixels without filling the project
  // directory (or Downloads) with numbered PNG copies.
  ipcMain.handle('storyboard:save-image', async (
    _e, cacheKey: string, baseName: string, png: ArrayBuffer
  ) => {
    if (!png?.byteLength) throw new Error('empty storyboard image')
    const safeKey = String(cacheKey).replace(/[^a-f0-9]/gi, '').slice(0, 64)
    if (safeKey.length < 16) throw new Error('invalid storyboard cache key')
    const safeName = String(baseName).replace(/[^\p{L}\p{N} ._-]/gu, '_').slice(0, 120) || 'frame'
    const target = join(storyboardDir(), safeKey)
    const out = join(target, `${safeName}.png`)
    const tmp = join(target, `${safeName}.${process.pid}.${Date.now()}.part.png`)
    await fs.mkdir(target, { recursive: true })
    try {
      await fs.writeFile(tmp, Buffer.from(png))
      try {
        await fs.rename(tmp, out)
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (code !== 'EEXIST' && code !== 'EPERM') throw error
        await fs.unlink(out).catch(() => { /* first generation */ })
        await fs.rename(tmp, out)
      }
    } finally {
      await fs.unlink(tmp).catch(() => { /* already published */ })
    }
    const now = new Date()
    await fs.utimes(target, now, now).catch(() => { /* directory timestamp is only for eviction */ })
    void cleanupStoryboardCache()
    return out
  })

  ipcMain.handle('project:save-dialog', async (event, currentName: string) => {
    const r = await dialog.showSaveDialog(senderWindow(event.sender), {
      defaultPath: join(await lastDir('project'), `${currentName}.kadr`),
      filters: PROJECT_FILTERS
    })
    if (r.canceled || !r.filePath) return null
    void rememberDir('project', r.filePath)
    return r.filePath
  })

  ipcMain.handle('project:package-dialog', async (event, _currentName: string) => {
    const r = await dialog.showOpenDialog(senderWindow(event.sender), {
      defaultPath: await lastDir('project'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return null
    void rememberDir('project', join(r.filePaths[0], 'project.kadr'))
    return r.filePaths[0]
  })

  ipcMain.handle('project:package', async (
    _event,
    parentDir: string,
    sourceProjectPath: string | null,
    project: Project,
    options: ProjectPackageOptions
  ) => packageProject(parentDir, sourceProjectPath, project, options))

  ipcMain.handle('project:open-dialog', async (event) => {
    const r = await dialog.showOpenDialog(senderWindow(event.sender), {
      properties: ['openFile'],
      defaultPath: await lastDir('project'),
      filters: PROJECT_FILTERS
    })
    if (r.canceled || !r.filePaths[0]) return null
    void rememberDir('project', r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('project:read', async (_e, path: string): Promise<Project> => {
    return readProjectFile(path)
  })

  ipcMain.handle('project:write', async (_e, path: string, project: Project) => {
    const portable = await embedProjectVoiceClones(project, path)
    await fs.writeFile(path, JSON.stringify(projectForDisk(portable, path), null, 1), 'utf-8')
  })

  // periodic safety net: <name>.autosave.kadr next to the saved project
  // (Downloads for never-saved ones); tmp+rename so a crash mid-write can
  // never leave a torn file
  ipcMain.handle('project:autosave', async (event, project: Project, mainPath: string | null) => {
    const dir = mainPath ? dirname(mainPath) : app.getPath('downloads')
    const base = mainPath
      ? basename(mainPath, '.kadr')
      : `${(project.name || 'Untitled').replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'Untitled'}.${event.sender.id}`
    const out = join(dir, `${base}.autosave.kadr`)
    const tmp = `${out}.tmp`
    const portable = await embedProjectVoiceClones(project, out)
    await fs.writeFile(tmp, JSON.stringify(projectForDisk(portable, out), null, 1), 'utf-8')
    await fs.rename(tmp, out)
    return out
  })

  ipcMain.handle('export:dialog', async (event, defaultName: string, ext: string) => {
    const r = await dialog.showSaveDialog(senderWindow(event.sender), {
      defaultPath: join(await lastDir('export'), `${defaultName}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (r.canceled || !r.filePath) return null
    void rememberDir('export', r.filePath)
    return r.filePath
  })

  ipcMain.handle('html-player:export', async (event, request: HtmlPlayerExportRequest) => {
    const windowId = event.sender.id
    htmlExportAborts.get(windowId)?.abort()
    const controller = new AbortController()
    htmlExportAborts.set(windowId, controller)
    try {
      const output = await writeHtmlPlayerExport(request, {
        bundlePath: join(__dirname, '..', 'html-player', 'player.js'),
        signal: controller.signal,
        bundleFragments,
        onProgress: (progress) => sendProgress(event.sender, {
          phase: 'files', progress: 0.15 + progress * 0.85
        })
      })
      sendProgress(event.sender, { phase: 'done', progress: 1 })
      return output
    } catch (error: any) {
      const cancelled = controller.signal.aborted || error?.message === 'cancelled'
      sendProgress(event.sender, {
        phase: cancelled ? 'cancelled' : 'error',
        progress: 0,
        message: String(error?.message ?? error)
      })
      throw error
    } finally {
      if (htmlExportAborts.get(windowId) === controller) htmlExportAborts.delete(windowId)
    }
  })

  ipcMain.handle('export:begin', async (event, job: ExportJob) => {
    const windowId = event.sender.id
    await cleanupExport(windowId)
    const videoTemp = join(tmpdir(), `kadr-export-${windowId}-${Date.now()}.mp4`)
    const fh = job.preset.audioOnly ? null : await fs.open(videoTemp, 'w')
    exportStates.set(windowId, {
      job, videoTemp, fh, muxer: null, raw: null, rawEncoded: false,
      rawWss: null, rawChain: Promise.resolve(), rawErr: null
    })
  })

  ipcMain.handle('export:video-chunk', async (event, data: ArrayBuffer, position: number) => {
    const state = exportStates.get(event.sender.id)
    if (!state?.fh) throw new Error('no export in progress')
    await state.fh.write(Buffer.from(data), 0, data.byteLength, position)
  })

  // direct ffmpeg encode: raw RGBA frames from the renderer over stdin;
  // returns a local WebSocket port for the frame stream (0 = use IPC)
  ipcMain.handle('export:raw-begin', async (
    event, width: number, height: number, fps: number,
    outWidth?: number, outHeight?: number
  ) => {
    const st = exportStates.get(event.sender.id)
    if (!st) throw new Error('no export in progress')
    await st.fh?.close()
    st.fh = null
    const preset = st.job.preset
    st.raw = new RawVideoEncoder()
    st.rawEncoded = true
    st.raw.start({
      width, height, outWidth, outHeight, fps,
      codec: preset.ffmpegVideo === 'copy' ? 'libx264' : preset.ffmpegVideo,
      bitrate: preset.videoBitrate,
      out: st.videoTemp
    })
    try {
      const { WebSocketServer } = await import('ws')
      const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
      await new Promise<void>((res, rej) => { wss.once('listening', res); wss.once('error', rej) })
      let pendingWrites = 0
      wss.on('connection', (sock) => {
        sock.on('message', (data) => {
          if (!st.raw) return
          pendingWrites++
          if (pendingWrites > 12) sock.pause() // ffmpeg fell behind — stop reading
          st.rawChain = st.rawChain
            .then(() => st.raw?.write(data as Buffer))
            .then(() => {
              if (--pendingWrites <= 4 && sock.isPaused) sock.resume()
            })
            .catch((err) => { st.rawErr = st.rawErr ?? (err as Error) })
        })
      })
      st.rawWss = wss
      const addr = wss.address()
      return typeof addr === 'object' && addr ? addr.port : 0
    } catch {
      return 0 // no ws transport — the renderer falls back to IPC frames
    }
  })

  // preload encoded the video itself — adopt its file for the mux stage
  ipcMain.handle('export:use-video', async (event, path: string) => {
    const st = exportStates.get(event.sender.id)
    if (!st) throw new Error('no export in progress')
    await st.fh?.close()
    st.fh = null
    if (st.videoTemp !== path) {
      try { await fs.unlink(st.videoTemp) } catch { /* never written */ }
    }
    st.videoTemp = path
    st.rawEncoded = true
  })

  ipcMain.handle('export:raw-frame', async (event, data: ArrayBuffer) => {
    const st = exportStates.get(event.sender.id)
    if (!st?.raw) throw new Error('no raw encoder')
    await st.raw.write(Buffer.from(data))
  })

  ipcMain.handle('export:raw-end', async (event) => {
    const st = exportStates.get(event.sender.id)
    if (!st?.raw) throw new Error('no raw encoder')
    await st.rawChain
    if (st.rawErr) throw st.rawErr
    st.rawWss?.close()
    st.rawWss = null
    await st.raw!.finish()
    st.raw = null
  })

  ipcMain.handle('export:video-done', async (event) => {
    const windowId = event.sender.id
    const st = exportStates.get(windowId)
    if (!st) throw new Error('no export in progress')
    await st.fh?.close()
    st.fh = null
    st.muxer = new ExportMuxer()
    try {
      // raw path already produced the final video stream — never re-encode it
      const job = st.rawEncoded
        ? { ...st.job, preset: { ...st.job.preset, ffmpegVideo: 'copy' as const } }
        : st.job
      await st.muxer.run(job, st.videoTemp, (progress) => sendProgress(event.sender, progress))
      sendProgress(event.sender, { phase: 'done', progress: 1 })
    } catch (err: any) {
      sendProgress(event.sender, {
        phase: err?.message === 'cancelled' ? 'cancelled' : 'error',
        progress: 0,
        message: String(err?.message ?? err)
      })
    } finally {
      await cleanupExport(windowId)
    }
  })

  ipcMain.handle('export:cancel', async (event) => {
    const windowId = event.sender.id
    htmlExportAborts.get(windowId)?.abort()
    const st = exportStates.get(windowId)
    st?.raw?.kill()
    st?.muxer?.cancel()
    if (st && !st.muxer) {
      await cleanupExport(windowId)
      sendProgress(event.sender, { phase: 'cancelled', progress: 0 })
    }
  })
}

async function cleanupExport(windowId: number) {
  const st = exportStates.get(windowId)
  if (!st) return
  exportStates.delete(windowId)
  st.raw?.kill()
  st.rawWss?.close()
  try { await st.fh?.close() } catch { /* already closed */ }
  try { await fs.unlink(st.videoTemp) } catch { /* never created */ }
}
