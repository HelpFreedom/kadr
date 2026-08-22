import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import type { KadrApi, ExportProgress, MenuCommand } from '@shared/types'
import { rawEncodeArgs } from '@shared/rawEncode'

// Direct export encoder: ffmpeg is spawned HERE, in the renderer process
// (sandbox is off), so raw frames go straight from JS memory into its stdin
// through one kernel pipe. Every cross-process route (IPC invoke, WebSocket)
// tops out near ~350 MB/s in Electron — ~20 ms of main-thread per 1080p
// frame, slower than the encode itself.
let rawEnc: ChildProcess | null = null
let rawEncErr = ''
let rawEncExit: Promise<void> | null = null

const api: KadrApi = {
  rawEncodeStart: (o) => {
    const out = join(tmpdir(), `kadr-export-raw-${Date.now()}.mp4`)
    const child = spawn(process.env.KADR_FFMPEG || 'ffmpeg', rawEncodeArgs({ ...o, out }), {
      stdio: ['pipe', 'ignore', 'pipe']
    })
    rawEnc = child
    rawEncErr = ''
    child.stderr!.on('data', (c) => { rawEncErr += c })
    rawEncExit = new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        rawEnc = null
        if (code === 0) resolve()
        else reject(new Error(`raw encoder exited ${code}: ${rawEncErr.slice(0, 800)}`))
      })
    })
    rawEncExit.catch(() => { /* surfaced via frame/end */ })
    return new Promise((resolve, reject) => {
      child.once('spawn', () => resolve(out))
      child.once('error', (e) => { rawEnc = null; reject(e) })
    })
  },
  // with contextIsolation off the view arrives BY REFERENCE — zero copies;
  // resolve = ffmpeg's stdin accepted the memory, only then reuse the buffer
  rawEncodeFrame: (view) =>
    new Promise((resolve, reject) => {
      const stdin = rawEnc?.stdin
      if (!stdin || stdin.destroyed) {
        reject(new Error(`raw encoder gone: ${rawEncErr.slice(0, 300)}`))
        return
      }
      // The frame buffer is handed over BY REFERENCE (contextIsolation is
      // off exactly to avoid an 8 MB copy per frame) and the exporter reuses
      // it as soon as this promise resolves. `write()` returning true only
      // means "you may keep writing" — the chunk itself can still sit in the
      // stream's queue, still pointing at our buffer, so resolving on it let
      // the next frame overwrite data ffmpeg had not read yet: exports came
      // out with occasional TORN frames (half frame k, half frame k+2) and
      // no two runs were pixel-identical. The write callback fires only once
      // the chunk has actually been flushed to the pipe.
      stdin.write(view, (err) => (err ? reject(err) : resolve()))
    }),
  rawEncodeEnd: async () => {
    rawEnc?.stdin?.end()
    await rawEncExit
    rawEncExit = null
  },
  rawEncodeKill: () => {
    try { rawEnc?.kill('SIGKILL') } catch { /* gone */ }
    rawEnc = null
    rawEncExit = null
  },

  openMediaDialog: () => ipcRenderer.invoke('media:open-dialog'),
  probeMedia: (path) => ipcRenderer.invoke('media:probe', path),
  fileUrl: (path) => {
    // Windows paths (D:\dir\file) must become /D:/dir/file — a raw drive
    // letter glued after the host ('kadr://mediaD:\…') is an INVALID URL:
    // the element never loads and the preview spins forever (issue #6)
    const posix = path.replace(/\\/g, '/')
    const abs = posix.startsWith('/') ? posix : `/${posix}`
    return `kadr://media${encodeURI(abs).replace(/[?#]/g, encodeURIComponent)}`
  },
  pathForFile: (f) => {
    try { return webUtils.getPathForFile(f) } catch { return '' }
  },
  downloadMedia: (url) => ipcRenderer.invoke('media:download', url),
  saveBlobMedia: (name, mime, data) => ipcRenderer.invoke('media:save-blob', name, mime, data),
  portalFiles: (key) => ipcRenderer.invoke('media:portal-files', key),
  clipboardMedia: () => ipcRenderer.invoke('media:clipboard-paste'),
  dropLog: (entry) => ipcRenderer.send('debug:drop-log', entry),

  saveProjectDialog: (name) => ipcRenderer.invoke('project:save-dialog', name),
  saveProjectPackageDialog: (name) => ipcRenderer.invoke('project:package-dialog', name),
  packageProject: (parentDir, sourceProjectPath, project, options) =>
    ipcRenderer.invoke('project:package', parentDir, sourceProjectPath, project, options),
  openProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  newEditorWindow: () => ipcRenderer.send('window:new'),
  takeInitialProjectPath: () => ipcRenderer.invoke('window:initial-project'),
  setWindowProjectState: (state) => ipcRenderer.send('window:project-state', state),
  readProject: (path) => ipcRenderer.invoke('project:read', path),
  writeProject: (path, project) => ipcRenderer.invoke('project:write', path, project),
  autosaveProject: (project, mainPath) => ipcRenderer.invoke('project:autosave', project, mainPath),

  readUserStore: (name) => ipcRenderer.invoke('store:read', name),
  writeUserStore: (name, data) => ipcRenderer.invoke('store:write', name, data),

  reverseMedia: (path, start, duration, info) =>
    ipcRenderer.invoke('media:reverse', path, start, duration, info),
  onReverseProgress: (cb) => {
    const handler = (_e: unknown, p: { path: string; start: number; duration: number; progress: number }) => cb(p)
    ipcRenderer.on('reverse:progress', handler)
    return () => ipcRenderer.removeListener('reverse:progress', handler)
  },
  requestProxy: (path, duration, opts) => ipcRenderer.invoke('proxy:request', path, duration, opts),
  rebuildProxy: (path, duration, opts) => ipcRenderer.invoke('proxy:rebuild', path, duration, opts),
  timelineThumbnails: (request) => ipcRenderer.invoke('thumbnail:timeline', request),
  visualFingerprint: (paths, fragmentIds) =>
    ipcRenderer.invoke('visual:fingerprint', paths, fragmentIds),
  requestDecoded: (path, duration, opts) => ipcRenderer.invoke('media:decoded', path, duration, opts),
  pickDirectory: (title) => ipcRenderer.invoke('dialog:pick-dir', title),
  saveSnapshot: (dir, baseName, png) => ipcRenderer.invoke('snapshot:save', dir, baseName, png),
  saveStoryboardImage: (cacheKey, baseName, png) =>
    ipcRenderer.invoke('storyboard:save-image', cacheKey, baseName, png),
  measureLoudness: (path, start, duration) => ipcRenderer.invoke('media:loudness', path, start, duration),
  onProxyProgress: (cb) => {
    const handler = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p)
    ipcRenderer.on('proxy:progress', handler)
    return () => ipcRenderer.removeListener('proxy:progress', handler)
  },

  exportDialog: (name, ext) => ipcRenderer.invoke('export:dialog', name, ext),
  htmlPlayerExport: (request) => ipcRenderer.invoke('html-player:export', request),
  exportBegin: (job) => ipcRenderer.invoke('export:begin', job),
  exportVideoChunk: (data, position) => ipcRenderer.invoke('export:video-chunk', data, position),
  exportRawBegin: (width, height, fps, outWidth, outHeight) =>
    ipcRenderer.invoke('export:raw-begin', width, height, fps, outWidth, outHeight),
  exportRawFrame: (data) => ipcRenderer.invoke('export:raw-frame', data),
  exportRawEnd: () => ipcRenderer.invoke('export:raw-end'),
  exportUseVideo: (path) => ipcRenderer.invoke('export:use-video', path),
  exportVideoDone: () => ipcRenderer.invoke('export:video-done'),
  exportCancel: () => ipcRenderer.invoke('export:cancel'),
  onExportProgress: (cb) => {
    const handler = (_e: unknown, p: ExportProgress) => cb(p)
    ipcRenderer.on('export:progress', handler)
    return () => ipcRenderer.removeListener('export:progress', handler)
  },

  fragmentEnsure: () => ipcRenderer.invoke('fragment:ensure'),
  fragmentServer: () => ipcRenderer.invoke('fragment:server'),
  fragmentCreate: (spec, projectDir) => ipcRenderer.invoke('fragment:create', spec, projectDir),
  fragmentDelete: (id) => ipcRenderer.invoke('fragment:delete', id),
  fragmentRelocate: (projectDir, ids) => ipcRenderer.invoke('fragment:relocate', projectDir, ids),
  fragmentCaptureStart: (id, url, w, h, fps) =>
    ipcRenderer.invoke('fragment:capture-start', id, url, w, h, fps),
  fragmentCaptureStop: (id) => ipcRenderer.invoke('fragment:capture-stop', id),
  fragmentCaptureSync: (id, msg) => ipcRenderer.send('fragment:capture-sync', id, msg),
  fragmentCaptureQuery: (id) => ipcRenderer.invoke('fragment:capture-query', id),
  onFragmentFrame: (cb) => {
    const handler = (_e: unknown, p: { id: string; w: number; h: number; data: Uint8Array }) => cb(p)
    ipcRenderer.on('fragment:frame', handler)
    return () => ipcRenderer.removeListener('fragment:frame', handler)
  },
  fragmentRender: (id, opts) => ipcRenderer.invoke('fragment:render', id, opts),
  onFragmentProgress: (cb) => {
    const handler = (_e: unknown, p: { id: string; phase: string; progress: number }) => cb(p)
    ipcRenderer.on('fragment:progress', handler)
    return () => ipcRenderer.removeListener('fragment:progress', handler)
  },

  transcribe: (req) => ipcRenderer.invoke('transcribe:run', req),
  transcribeCancel: () => ipcRenderer.invoke('transcribe:cancel'),
  onTranscribeProgress: (cb) => {
    const handler = (_e: unknown, p: { progress: number; text: string }) => cb(p)
    ipcRenderer.on('transcribe:progress', handler)
    return () => ipcRenderer.removeListener('transcribe:progress', handler)
  },
  readTextFile: (path) => ipcRenderer.invoke('file:read-text', path),
  writeTextFile: (path, content) => ipcRenderer.invoke('file:write-text', path, content),
  statFile: (path) => ipcRenderer.invoke('file:stat', path),
  createSrtFile: (suggestedName, start) => ipcRenderer.invoke('text:create-srt', suggestedName, start),
  prepareTextDocument: (path) => ipcRenderer.invoke('text:prepare-document', path),

  voiceoverStatus: (settings) => ipcRenderer.invoke('voiceover:status', settings),
  voiceoverInstall: (settings) => ipcRenderer.invoke('voiceover:install', settings),
  voiceoverInstallCancel: () => ipcRenderer.invoke('voiceover:install-cancel'),
  onVoiceoverInstallProgress: (cb) => {
    const handler = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p)
    ipcRenderer.on('voiceover:install-progress', handler)
    return () => ipcRenderer.removeListener('voiceover:install-progress', handler)
  },
  voiceCloneList: () => ipcRenderer.invoke('voice-clone:list'),
  voiceClonePickFile: () => ipcRenderer.invoke('voice-clone:pick-file'),
  voiceClonePrepare: (sourcePath) => ipcRenderer.invoke('voice-clone:prepare', sourcePath),
  voiceCloneProcess: (sourcePath, options) => ipcRenderer.invoke('voice-clone:process', sourcePath, options),
  voiceCloneTranscribe: (sourcePath) => ipcRenderer.invoke('voice-clone:transcribe', sourcePath),
  voiceCloneSave: (request) => ipcRenderer.invoke('voice-clone:save', request),
  voiceCloneDelete: (voiceId) => ipcRenderer.invoke('voice-clone:delete', voiceId),
  voiceCloneDiscard: (paths) => ipcRenderer.invoke('voice-clone:discard', paths),
  voiceoverGenerate: (req) => ipcRenderer.invoke('voiceover:generate', req),
  voiceoverCancel: () => ipcRenderer.invoke('voiceover:cancel'),
  onVoiceoverProgress: (cb) => {
    const handler = (_e: unknown, p: Parameters<typeof cb>[0]) => cb(p)
    ipcRenderer.on('voiceover:progress', handler)
    return () => ipcRenderer.removeListener('voiceover:progress', handler)
  },

  claudeOpen: (cols, rows, cwd) => ipcRenderer.invoke('claude:open', cols, rows, cwd),
  claudeInput: (data) => ipcRenderer.send('claude:input', data),
  claudeResize: (cols, rows) => ipcRenderer.send('claude:resize', cols, rows),
  claudeClose: () => ipcRenderer.invoke('claude:close'),
  onClaudeData: (cb) => {
    const handler = (_e: unknown, data: string) => cb(data)
    ipcRenderer.on('claude:data', handler)
    return () => ipcRenderer.removeListener('claude:data', handler)
  },
  onClaudeExit: (cb) => {
    const handler = (_e: unknown, code: number) => cb(code)
    ipcRenderer.on('claude:exit', handler)
    return () => ipcRenderer.removeListener('claude:exit', handler)
  },
  onMenuCommand: (cb) => {
    const handler = (_e: unknown, cmd: MenuCommand) => cb(cmd)
    ipcRenderer.on('menu:command', handler)
    return () => ipcRenderer.removeListener('menu:command', handler)
  }
}

// contextIsolation is off (see main.ts: export frames pass by reference),
// so the api object lands on the shared window directly; the bridge branch
// keeps working if isolation is ever re-enabled.
if (process.contextIsolated) contextBridge.exposeInMainWorld('kadr', api)
else (globalThis as unknown as { kadr: KadrApi }).kadr = api
