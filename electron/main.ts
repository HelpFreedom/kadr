import { app, BrowserWindow, ipcMain, dialog, protocol, Menu } from 'electron'
import { join, dirname, basename } from 'path'
import { buildMenu } from './menu'
import { promises as fs, createReadStream, statSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { execFileSync } from 'child_process'
import { createHash } from 'crypto'
import { probeMedia, makeProxy, ExportMuxer } from './ffmpeg'
import { registerClaudeIpc } from './claude'
import { registerTranscribeIpc } from './transcribe'
import { registerFragmentIpc } from './fragments'
import type { ExportJob, Project } from '@shared/types'

// Streamed local media under a privileged scheme so the renderer can play
// file content regardless of its own origin (http in dev, file in prod).
protocol.registerSchemesAsPrivileged([
  { scheme: 'kadr', privileges: { secure: true, stream: true, supportFetchAPI: true, bypassCSP: true } }
])

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

let win: BrowserWindow | null = null

function createWindow() {
  win = new BrowserWindow({
    width: 1500,
    height: 900,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#15171c',
    title: 'Kadr',
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

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

function mediaResponse(filePath: string, rangeHeader: string | null): Response {
  const stat = statSync(filePath)
  const size = stat.size
  const m = rangeHeader?.match(/bytes=(\d*)-(\d*)/)
  // CORS header keeps WebAudio (MediaElementSource) from silencing the stream
  if (m && (m[1] || m[2])) {
    const start = m[1] ? parseInt(m[1], 10) : Math.max(0, size - parseInt(m[2], 10))
    const end = m[1] && m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1
    return new Response(streamBody(createReadStream(filePath, { start, end })), {
      status: 206,
      headers: {
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
      'Accept-Ranges': 'bytes',
      'Content-Length': String(size),
      'Access-Control-Allow-Origin': '*'
    }
  })
}

app.whenReady().then(() => {
  protocol.handle('kadr', (request) => {
    const url = new URL(request.url)
    const filePath = decodeURIComponent(url.pathname)
    try {
      return mediaResponse(filePath, request.headers.get('range'))
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
  Menu.setApplicationMenu(buildMenu(() => win))
  registerIpc()
  registerClaudeIpc(() => win)
  registerTranscribeIpc(() => win)
  registerFragmentIpc(() => win)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// ---------------------------------------------------------------------------

const MEDIA_FILTERS = [
  { name: 'Media', extensions: ['mp4', 'mkv', 'mov', 'webm', 'avi', 'm4v', 'mts', 'mp3', 'wav', 'flac', 'ogg', 'aac', 'm4a', 'opus', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'srt', 'txt'] },
  { name: 'All files', extensions: ['*'] }
]
const PROJECT_FILTERS = [{ name: 'Kadr project', extensions: ['kadr'] }]

let exportState: {
  job: ExportJob
  videoTemp: string
  fh: fs.FileHandle | null
  muxer: ExportMuxer | null
} | null = null

function sendProgress(p: import('@shared/types').ExportProgress) {
  win?.webContents.send('export:progress', p)
}

// app-wide JSON stores (presets etc.) in userData — independent of the
// renderer profile, so they survive restarts and concurrent instances
const userStorePath = (name: string) =>
  join(app.getPath('userData'), `${name.replace(/[^a-z0-9-]/gi, '')}.json`)

// preview proxies: keyed by source identity, built one at a time (weak CPU)
const proxyDir = () => join(app.getPath('userData'), 'proxies')
let proxyChain: Promise<unknown> = Promise.resolve()

async function requestProxy(srcPath: string, duration: number): Promise<string> {
  const stat = statSync(srcPath)
  const key = createHash('sha1')
    .update(`${srcPath}:${stat.size}:${Math.round(stat.mtimeMs)}`)
    .digest('hex')
    .slice(0, 20)
  const out = join(proxyDir(), `${key}.mp4`)
  try {
    await fs.access(out)
    return out
  } catch { /* not built yet */ }
  await fs.mkdir(proxyDir(), { recursive: true })
  const job = proxyChain.then(async () => {
    try {
      await fs.access(out)
      return // built while we waited in the queue
    } catch { /* still missing */ }
    const tmp = join(proxyDir(), `${key}.part.mp4`)
    try {
      await makeProxy(srcPath, tmp, duration, (p) => {
        win?.webContents.send('proxy:progress', { path: srcPath, progress: p })
      })
      await fs.rename(tmp, out)
    } catch (err) {
      fs.unlink(tmp).catch(() => { /* nothing to clean */ })
      throw err
    }
  })
  proxyChain = job.catch(() => { /* keep the queue alive */ })
  await job
  win?.webContents.send('proxy:progress', { path: srcPath, progress: 1 })
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
  ipcMain.handle('proxy:request', (_e, srcPath: string, duration: number) =>
    requestProxy(srcPath, duration)
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

  ipcMain.handle('media:open-dialog', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile', 'multiSelections'],
      defaultPath: await lastDir('media'),
      filters: MEDIA_FILTERS
    })
    if (r.canceled || !r.filePaths.length) return []
    void rememberDir('media', r.filePaths[0])
    return r.filePaths
  })

  ipcMain.handle('media:probe', (_e, path: string) => probeMedia(path))

  ipcMain.handle('project:save-dialog', async (_e, currentName: string) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: join(await lastDir('project'), `${currentName}.kadr`),
      filters: PROJECT_FILTERS
    })
    if (r.canceled || !r.filePath) return null
    void rememberDir('project', r.filePath)
    return r.filePath
  })

  ipcMain.handle('project:open-dialog', async () => {
    const r = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      defaultPath: await lastDir('project'),
      filters: PROJECT_FILTERS
    })
    if (r.canceled || !r.filePaths[0]) return null
    void rememberDir('project', r.filePaths[0])
    return r.filePaths[0]
  })

  ipcMain.handle('project:read', async (_e, path: string): Promise<Project> => {
    return JSON.parse(await fs.readFile(path, 'utf-8'))
  })

  ipcMain.handle('project:write', async (_e, path: string, project: Project) => {
    await fs.writeFile(path, JSON.stringify(project, null, 1), 'utf-8')
  })

  // periodic safety net: <name>.autosave.kadr next to the saved project
  // (Downloads for never-saved ones); tmp+rename so a crash mid-write can
  // never leave a torn file
  ipcMain.handle('project:autosave', async (_e, project: Project, mainPath: string | null) => {
    const dir = mainPath ? dirname(mainPath) : app.getPath('downloads')
    const base = mainPath
      ? basename(mainPath, '.kadr')
      : (project.name || 'Untitled').replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'Untitled'
    const out = join(dir, `${base}.autosave.kadr`)
    const tmp = `${out}.tmp`
    await fs.writeFile(tmp, JSON.stringify(project, null, 1), 'utf-8')
    await fs.rename(tmp, out)
    return out
  })

  ipcMain.handle('export:dialog', async (_e, defaultName: string, ext: string) => {
    const r = await dialog.showSaveDialog(win!, {
      defaultPath: join(await lastDir('export'), `${defaultName}.${ext}`),
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }]
    })
    if (r.canceled || !r.filePath) return null
    void rememberDir('export', r.filePath)
    return r.filePath
  })

  ipcMain.handle('export:begin', async (_e, job: ExportJob) => {
    await cleanupExport()
    const videoTemp = join(tmpdir(), `kadr-export-${Date.now()}.mp4`)
    const fh = job.preset.audioOnly ? null : await fs.open(videoTemp, 'w')
    exportState = { job, videoTemp, fh, muxer: null }
  })

  ipcMain.handle('export:video-chunk', async (_e, data: ArrayBuffer, position: number) => {
    if (!exportState?.fh) throw new Error('no export in progress')
    await exportState.fh.write(Buffer.from(data), 0, data.byteLength, position)
  })

  ipcMain.handle('export:video-done', async () => {
    if (!exportState) throw new Error('no export in progress')
    const st = exportState
    await st.fh?.close()
    st.fh = null
    st.muxer = new ExportMuxer()
    try {
      await st.muxer.run(st.job, st.videoTemp, sendProgress)
      sendProgress({ phase: 'done', progress: 1 })
    } catch (err: any) {
      sendProgress({
        phase: err?.message === 'cancelled' ? 'cancelled' : 'error',
        progress: 0,
        message: String(err?.message ?? err)
      })
    } finally {
      await cleanupExport()
    }
  })

  ipcMain.handle('export:cancel', async () => {
    exportState?.muxer?.cancel()
    if (exportState && !exportState.muxer) {
      await cleanupExport()
      sendProgress({ phase: 'cancelled', progress: 0 })
    }
  })
}

async function cleanupExport() {
  if (!exportState) return
  const st = exportState
  exportState = null
  try { await st.fh?.close() } catch { /* already closed */ }
  try { await fs.unlink(st.videoTemp) } catch { /* never created */ }
}
