import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import type { KadrApi, ExportProgress } from '@shared/types'
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
      if (stdin.write(view)) resolve()
      else stdin.once('drain', resolve)
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
  fileUrl: (path) => `kadr://media${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`,
  pathForFile: (f) => {
    try { return webUtils.getPathForFile(f) } catch { return '' }
  },
  downloadMedia: (url) => ipcRenderer.invoke('media:download', url),
  saveBlobMedia: (name, mime, data) => ipcRenderer.invoke('media:save-blob', name, mime, data),
  portalFiles: (key) => ipcRenderer.invoke('media:portal-files', key),
  clipboardMedia: () => ipcRenderer.invoke('media:clipboard-paste'),
  dropLog: (entry) => ipcRenderer.send('debug:drop-log', entry),

  saveProjectDialog: (name) => ipcRenderer.invoke('project:save-dialog', name),
  openProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
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
  requestProxy: (path, duration) => ipcRenderer.invoke('proxy:request', path, duration),
  onProxyProgress: (cb) => {
    const handler = (_e: unknown, p: { path: string; progress: number }) => cb(p)
    ipcRenderer.on('proxy:progress', handler)
    return () => ipcRenderer.removeListener('proxy:progress', handler)
  },

  exportDialog: (name, ext) => ipcRenderer.invoke('export:dialog', name, ext),
  exportBegin: (job) => ipcRenderer.invoke('export:begin', job),
  exportVideoChunk: (data, position) => ipcRenderer.invoke('export:video-chunk', data, position),
  exportRawBegin: (width, height, fps) => ipcRenderer.invoke('export:raw-begin', width, height, fps),
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
  fragmentCreate: (spec) => ipcRenderer.invoke('fragment:create', spec),
  fragmentDelete: (id) => ipcRenderer.invoke('fragment:delete', id),
  fragmentCaptureStart: (id, url, w, h, fps) =>
    ipcRenderer.invoke('fragment:capture-start', id, url, w, h, fps),
  fragmentCaptureStop: (id) => ipcRenderer.invoke('fragment:capture-stop', id),
  fragmentCaptureSync: (id, msg) => ipcRenderer.send('fragment:capture-sync', id, msg),
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
  }
}

// contextIsolation is off (see main.ts: export frames pass by reference),
// so the api object lands on the shared window directly; the bridge branch
// keeps working if isolation is ever re-enabled.
if (process.contextIsolated) contextBridge.exposeInMainWorld('kadr', api)
else (globalThis as unknown as { kadr: KadrApi }).kadr = api
