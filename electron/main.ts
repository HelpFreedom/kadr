import { app, BrowserWindow, ipcMain, dialog, protocol, net, clipboard } from 'electron'
import { join, dirname, basename } from 'path'
import { promises as fs, createReadStream, statSync, existsSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { createHash, randomBytes } from 'crypto'
import { execFile } from 'child_process'
import {
  probeMedia, makeProxy, makeDecoded, makeReversed, measureLoudness, packedAlphaPlan,
  ExportMuxer, RawVideoEncoder, meanVolume
} from './ffmpeg'
import { mediaCacheKey, proxySuffix, decodedSuffix, reverseSuffix } from './cacheKeys'
import { registerStorageIpc } from './storage'
import { registerClaudeIpc } from './claude'
import { registerTranscribeIpc } from './transcribe'
import { registerTtsIpc } from './tts'
import { registerVoiceIpc } from './voice'
import { registerEnvelopeIpc } from './envelope'
import { registerSoundsIpc } from './sounds'
import { registerFragmentIpc, cancelFragmentRenders } from './fragments'
import type { ExportJob, Project } from '@shared/types'

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

// Let Chromium use VAAPI for hardware video encode/decode where the driver
// allows it (Intel iGPU on this machine); WebCodecs then picks it up via
// hardwareAcceleration: 'prefer-hardware'.
app.commandLine.appendSwitch('ignore-gpu-blocklist')
app.commandLine.appendSwitch(
  'enable-features',
  'VaapiVideoEncoder,VaapiVideoDecoder,VaapiVideoDecodeLinuxGL,AcceleratedVideoEncoder'
)

// Last line of defense: a stray async error (e.g. a stream racing a request
// abort) must be logged, not shown as a modal error dialog over the editor.
process.on('uncaughtException', (err) => {
  console.error('[kadr] uncaught exception in main:', err)
})

let win: BrowserWindow | null = null
/** window.open name of the detached preview — see src/engine/popout.ts */
const PREVIEW_WIN = 'kadr-preview'

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
      // page and preload share one JS context: export frames reach the
      // preload-spawned ffmpeg by reference — any bridge/IPC route copies
      // ~8 MB per 1080p frame at only a few hundred MB/s and dominates
      // render time. The renderer loads local content only.
      contextIsolation: false,
      sandbox: false
    }
  })
  win.setMenuBarVisibility(false)
  const owner = win
  // The preview can be detached into a window of its own (src/engine/popout.ts).
  // The renderer opens an about:blank popup — same origin and same renderer
  // process, which is the only reason the live GL canvas can be adopted into
  // it — and moves the preview's DOM across. Exactly one window name is
  // allowed: the Remotion fragment pages served by the workspace dev server
  // run inside this webContents too, and nothing they contain has any business
  // opening an OS window.
  win.webContents.setWindowOpenHandler(({ frameName }) => {
    if (frameName !== PREVIEW_WIN) return { action: 'deny' }
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        title: 'Kadr',
        // --c-bg-0: about:blank is white, and the styles arrive a beat later
        backgroundColor: '#0b0d12',
        minWidth: 320,
        minHeight: 200,
        autoHideMenuBar: true
      }
    }
  })
  win.webContents.on('did-create-window', (child, { frameName }) => {
    if (frameName !== PREVIEW_WIN) return
    child.setMenuBarVisibility(false)
    child.removeMenu()
    // closing the editor must not leave the preview window behind: while one
    // is open window-all-closed never fires and the app would never quit
    const closeChild = () => { if (!child.isDestroyed()) child.destroy() }
    owner.on('close', closeChild)
    child.on('closed', () => owner.isDestroyed() || owner.removeListener('close', closeChild))
  })
  // a killed/crashed renderer leaves a dead window and an immortal main
  // process (the running project is lost either way — autosave has it);
  // exit cleanly so the next launch starts fresh instead of being blocked
  win.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason !== 'clean-exit') {
      console.error('[kadr] renderer gone:', details.reason, '— exiting')
      app.exit(1)
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

/**
 * kadr:// is a privileged scheme (bypassCSP + CORS + `Access-Control-Allow-Origin: *`,
 * all of which the media elements need — without them Chromium taints their
 * pixels and preview/export go black, see the note at the top), and its handler
 * streams any absolute path. That is fine for this editor's own renderer, which
 * holds node access anyway — but the fragment dev server serves pages on ANOTHER
 * origin (the <iframe> preview, the offscreen capture window) whose code is
 * written by hand, by Claude, or arrives inside somebody else's project, and
 * which has no such access. Measured before this lock: such a page could
 * `fetch('kadr://media/etc/hostname')` and read the reply (issue #13).
 *
 * So every URL carries a per-run capability token that only the preload knows:
 * a page that cannot read the privileged renderer's JS cannot forge one.
 * A directory allowlist was considered and rejected — media legitimately lives
 * wherever the user picked it, and a project loaded through kadr_eval never
 * passes main at all, so the allowlist would have had silent holes exactly
 * where a miss means a black preview.
 */
const MEDIA_TOKEN = randomBytes(24).toString('hex')

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
    if (url.searchParams.get('t') !== MEDIA_TOKEN) {
      return new Response('forbidden', { status: 403 })
    }
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
  registerIpc()
  void pruneDecodedCache()
  void sweepPartFiles()
  registerClaudeIpc(() => win)
  registerTranscribeIpc(() => win)
  registerTtsIpc(() => win)
  registerVoiceIpc(() => win)
  registerEnvelopeIpc()
  registerSoundsIpc()
  registerStorageIpc()
  registerFragmentIpc(() => win)
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
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
  exportState?.muxer?.cancel()
  cancelFragmentRenders()
  void cleanupExport()
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
  raw: RawVideoEncoder | null
  rawEncoded: boolean
  /** WebSocket frame transport: Electron IPC serializes ~8 MB per 1080p
      frame at only ~400 MB/s (≈20 ms of renderer main-thread per frame) —
      a local binary WebSocket moves the same data several times faster */
  rawWss: import('ws').WebSocketServer | null
  rawChain: Promise<void>
  rawErr: Error | null
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

async function requestProxy(
  srcPath: string,
  duration: number,
  opts?: { alpha?: boolean; codec?: string }
): Promise<string> {
  const stat = statSync(srcPath)
  // alpha proxies are a different artifact (webm) — separate cache identity
  const key = mediaCacheKey(srcPath, stat.size, stat.mtimeMs, proxySuffix(opts?.alpha))
  const ext = opts?.alpha ? 'webm' : 'mp4'
  const out = join(proxyDir(), `${key}.${ext}`)
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
    const tmp = join(proxyDir(), `${key}.part.${ext}`)
    try {
      await makeProxy(srcPath, tmp, duration, (p) => {
        win?.webContents.send('proxy:progress', { path: srcPath, progress: p })
      }, opts)
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

// full-res H.264 intermediates for sources Chromium cannot decode (export
// reads these instead of the original video stream; audio still reads the
// original). Same identity key and queue discipline as proxies.
const decodedDir = () => join(app.getPath('userData'), 'decoded')
let decodedChain: Promise<unknown> = Promise.resolve()

async function requestDecoded(
  srcPath: string,
  duration: number,
  opts?: { alpha?: boolean; codec?: string; packed?: boolean; matrix?: string }
): Promise<string> {
  const stat = statSync(srcPath)
  const key = mediaCacheKey(srcPath, stat.size, stat.mtimeMs, decodedSuffix(opts))
  // packed = colour over its alpha matte in one fast-decodable H.264 mp4
  const ext = opts?.alpha && !opts?.packed ? 'webm' : 'mp4'
  const out = join(decodedDir(), `${key}.${ext}`)
  try {
    // a zero-byte file is the corpse of an interrupted build, not a cache hit
    if ((await fs.stat(out)).size > 0) return out
    await fs.unlink(out)
  } catch { /* not built yet */ }
  await fs.mkdir(decodedDir(), { recursive: true })
  if (opts?.packed) {
    const plan = await packedAlphaPlan(srcPath)
    if (!plan.canPack) {
      throw new Error('alpha packing skipped: full-range source')
    }
    opts = { ...opts, matrix: plan.matrix }
    // lossless colour+matte intermediates are big (~220 MB per minute of
    // 1080p60, four times that at 4K); refuse rather than fill the disk — the
    // caller falls back to the slow element path, which is correct, just slow
    const need = Math.max(2e9, duration * plan.bytesPerSecond) + 3e9
    try {
      const st = await fs.statfs(decodedDir())
      const free = st.bsize * st.bavail
      if (free < need) {
        throw new Error(`not enough free disk for a packed alpha intermediate: ` +
          `${Math.round(free / 1e9)} GB free, ~${Math.round(need / 1e9)} GB needed`)
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('not enough')) throw err
      // statfs unavailable — proceed, ffmpeg will fail loudly if it can't write
    }
  }
  const job = decodedChain.then(async () => {
    try {
      if ((await fs.stat(out)).size > 0) return // built while we waited in the queue
    } catch { /* still missing */ }
    const tmp = join(decodedDir(), `${key}.part.${ext}`)
    try {
      await makeDecoded(srcPath, tmp, duration, (p) => {
        win?.webContents.send('proxy:progress', { path: srcPath, progress: p })
      }, opts)
      await fs.rename(tmp, out)
    } catch (err) {
      fs.unlink(tmp).catch(() => { /* nothing to clean */ })
      throw err
    }
  })
  decodedChain = job.catch(() => { /* keep the queue alive */ })
  await job
  win?.webContents.send('proxy:progress', { path: srcPath, progress: 1 })
  return out
}

/**
 * Keep the decode cache from eating the disk. A lossless colour+matte
 * intermediate costs ~250 MB per minute of 1080p60 and every edit of a
 * fragment makes a new one, so the folder would grow without bound. Runs at
 * startup only — nothing can be reading these files yet — and drops the
 * least recently touched entries until the folder is back under the cap.
 */
const DECODED_CACHE_CAP = 10e9

async function pruneDecodedCache(): Promise<void> {
  try {
    const dir = decodedDir()
    const names = await fs.readdir(dir)
    const files = await Promise.all(names.map(async (name) => {
      const p = join(dir, name)
      const st = await fs.stat(p).catch(() => null)
      return st?.isFile() ? { p, size: st.size, used: Math.max(st.mtimeMs, st.atimeMs) } : null
    }))
    const list = files.filter((f): f is { p: string; size: number; used: number } => !!f)
    let total = list.reduce((n, f) => n + f.size, 0)
    if (total <= DECODED_CACHE_CAP) return
    list.sort((a, b) => a.used - b.used) // oldest first
    for (const f of list) {
      if (total <= DECODED_CACHE_CAP * 0.8) break
      await fs.unlink(f.p).catch(() => { /* someone else won the race */ })
      total -= f.size
      console.log(`[kadr] decode cache: dropped ${f.p} (${Math.round(f.size / 1e6)} MB)`)
    }
  } catch { /* no cache dir yet */ }
}

/**
 * Every cache here builds into a `<key>.part.<ext>` sidecar and renames on
 * success, so a survivor of a kill is always a `.part.` file and never a
 * cache hit. Nothing is building at startup, so any that remain are corpses:
 * drop them rather than let them count against the cache budget forever.
 * Directories (the reverse worker's scratch `.tmp` dir) are left alone.
 */
async function sweepPartFiles(): Promise<void> {
  const dirs = ['decoded', 'proxies', 'reversed', 'fragment-renders']
    .map((d) => join(app.getPath('userData'), d))
  let dropped = 0
  for (const dir of dirs) {
    let names: string[]
    try { names = await fs.readdir(dir) } catch { continue } // never used yet
    for (const name of names) {
      if (!name.includes('.part.')) continue
      const p = join(dir, name)
      try {
        if (!(await fs.stat(p)).isFile()) continue
        await fs.unlink(p)
        dropped++
      } catch { /* raced away */ }
    }
  }
  if (dropped) console.log(`[kadr] swept ${dropped} interrupted cache build(s)`)
}

// reversed renders: keyed by source identity + range, built one at a time
const reverseDir = () => join(app.getPath('userData'), 'reversed')
let reverseChain: Promise<unknown> = Promise.resolve()

async function requestReversed(
  srcPath: string,
  start: number,
  duration: number,
  info: { kind: string; hasAudio: boolean; width: number; height: number; fps: number }
): Promise<string> {
  const stat = statSync(srcPath)
  const key = mediaCacheKey(srcPath, stat.size, stat.mtimeMs, reverseSuffix(start, duration))
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
        win?.webContents.send('reverse:progress', { path: srcPath, start, duration, progress: p })
      })
      await fs.rename(tmp, out)
    } catch (err) {
      fs.unlink(tmp).catch(() => { /* nothing to clean */ })
      throw err
    }
  })
  reverseChain = job.catch(() => { /* keep the queue alive */ })
  await job
  win?.webContents.send('reverse:progress', { path: srcPath, start, duration, progress: 1 })
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
  ipcMain.handle('proxy:request', (_e, srcPath: string, duration: number,
    opts?: { alpha?: boolean; codec?: string }) =>
    requestProxy(srcPath, duration, opts)
  )

  ipcMain.handle('media:decoded', (_e, srcPath: string, duration: number,
    opts?: { alpha?: boolean; codec?: string; packed?: boolean }) =>
    requestDecoded(srcPath, duration, opts)
  )

  ipcMain.handle('media:loudness', (_e, srcPath: string, start: number, duration: number) =>
    measureLoudness(srcPath, start, duration)
  )

  ipcMain.handle('media:mean-volume', (_e, srcPath: string, start: number, duration: number) =>
    meanVolume(srcPath, start, duration)
  )

  ipcMain.handle(
    'media:reverse',
    (_e, srcPath: string, start: number, duration: number, info: {
      kind: string; hasAudio: boolean; width: number; height: number; fps: number
    }) => requestReversed(srcPath, start, duration, info)
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

  ipcMain.on('media:token', (e) => { e.returnValue = MEDIA_TOKEN })
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

  // Clipboard paste (Ctrl+V with an empty editor clipboard): copied FILES
  // (file managers put text/uri-list on the clipboard) win over a copied
  // IMAGE (e.g. Telegram's «Копировать изображение» — photos can't even be
  // dragged out of tdesktop, paste is the ergonomic route into the editor).
  ipcMain.handle('media:clipboard-paste', async () => {
    let uriList = ''
    try { uriList = clipboard.read('text/uri-list') || '' } catch { /* format absent */ }
    const paths: string[] = []
    for (const line of uriList.split(/\r?\n/)) {
      const u = line.trim()
      if (!u.startsWith('file://')) continue
      try { paths.push(decodeURIComponent(new URL(u).pathname)) } catch { /* malformed */ }
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

  ipcMain.handle('dialog:pick-dir', async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(win!, {
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
    exportState = {
      job, videoTemp, fh, muxer: null, raw: null, rawEncoded: false,
      rawWss: null, rawChain: Promise.resolve(), rawErr: null
    }
  })

  ipcMain.handle('export:video-chunk', async (_e, data: ArrayBuffer, position: number) => {
    if (!exportState?.fh) throw new Error('no export in progress')
    await exportState.fh.write(Buffer.from(data), 0, data.byteLength, position)
  })

  // direct ffmpeg encode: raw RGBA frames from the renderer over stdin;
  // returns a local WebSocket port for the frame stream (0 = use IPC)
  ipcMain.handle('export:raw-begin', async (
    _e, width: number, height: number, fps: number,
    outWidth?: number, outHeight?: number
  ) => {
    if (!exportState) throw new Error('no export in progress')
    const st = exportState
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
  ipcMain.handle('export:use-video', async (_e, path: string) => {
    if (!exportState) throw new Error('no export in progress')
    const st = exportState
    await st.fh?.close()
    st.fh = null
    if (st.videoTemp !== path) {
      try { await fs.unlink(st.videoTemp) } catch { /* never written */ }
    }
    st.videoTemp = path
    st.rawEncoded = true
  })

  ipcMain.handle('export:raw-frame', async (_e, data: ArrayBuffer) => {
    if (!exportState?.raw) throw new Error('no raw encoder')
    await exportState.raw.write(Buffer.from(data))
  })

  ipcMain.handle('export:raw-end', async () => {
    if (!exportState?.raw) throw new Error('no raw encoder')
    const st = exportState
    await st.rawChain
    if (st.rawErr) throw st.rawErr
    st.rawWss?.close()
    st.rawWss = null
    await st.raw!.finish()
    st.raw = null
  })

  ipcMain.handle('export:video-done', async () => {
    if (!exportState) throw new Error('no export in progress')
    const st = exportState
    await st.fh?.close()
    st.fh = null
    st.muxer = new ExportMuxer()
    try {
      // raw path already produced the final video stream — never re-encode it
      const job = st.rawEncoded
        ? { ...st.job, preset: { ...st.job.preset, ffmpegVideo: 'copy' as const } }
        : st.job
      await st.muxer.run(job, st.videoTemp, sendProgress)
      sendProgress({ phase: 'done', progress: 1 })
      await cleanupExport()
    } catch (err: any) {
      const cancelled = err?.message === 'cancelled'
      // the video stream took hours to render; a failed mux must not throw it
      // away — keep the temp file and tell the user where it is
      const keep = !cancelled && !st.job.preset.audioOnly
      sendProgress({
        phase: cancelled ? 'cancelled' : 'error',
        progress: 0,
        message: String(err?.message ?? err) + (keep ? ` (video kept at ${st.videoTemp})` : '')
      })
      await cleanupExport(keep)
    }
  })

  ipcMain.handle('export:cancel', async () => {
    exportState?.raw?.kill()
    exportState?.muxer?.cancel()
    if (exportState && !exportState.muxer) {
      await cleanupExport()
      sendProgress({ phase: 'cancelled', progress: 0 })
    }
  })
}

async function cleanupExport(keepVideo = false) {
  if (!exportState) return
  const st = exportState
  exportState = null
  st.raw?.kill()
  st.rawWss?.close()
  try { await st.fh?.close() } catch { /* already closed */ }
  if (!keepVideo) {
    try { await fs.unlink(st.videoTemp) } catch { /* never created */ }
  }
}
