import { contextBridge, ipcRenderer } from 'electron'
import type { KadrApi, ExportProgress } from '@shared/types'

const api: KadrApi = {
  openMediaDialog: () => ipcRenderer.invoke('media:open-dialog'),
  probeMedia: (path) => ipcRenderer.invoke('media:probe', path),
  fileUrl: (path) => `kadr://media${encodeURI(path).replace(/[?#]/g, encodeURIComponent)}`,

  saveProjectDialog: (name) => ipcRenderer.invoke('project:save-dialog', name),
  openProjectDialog: () => ipcRenderer.invoke('project:open-dialog'),
  readProject: (path) => ipcRenderer.invoke('project:read', path),
  writeProject: (path, project) => ipcRenderer.invoke('project:write', path, project),
  autosaveProject: (project, mainPath) => ipcRenderer.invoke('project:autosave', project, mainPath),

  readUserStore: (name) => ipcRenderer.invoke('store:read', name),
  writeUserStore: (name, data) => ipcRenderer.invoke('store:write', name, data),

  requestProxy: (path, duration) => ipcRenderer.invoke('proxy:request', path, duration),
  onProxyProgress: (cb) => {
    const handler = (_e: unknown, p: { path: string; progress: number }) => cb(p)
    ipcRenderer.on('proxy:progress', handler)
    return () => ipcRenderer.removeListener('proxy:progress', handler)
  },

  exportDialog: (name, ext) => ipcRenderer.invoke('export:dialog', name, ext),
  exportBegin: (job) => ipcRenderer.invoke('export:begin', job),
  exportVideoChunk: (data, position) => ipcRenderer.invoke('export:video-chunk', data, position),
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
  },
  onMenuCommand: (cb) => {
    const handler = (_e: unknown, cmd: string) => cb(cmd)
    ipcRenderer.on('menu:command', handler)
    return () => ipcRenderer.removeListener('menu:command', handler)
  }
}

contextBridge.exposeInMainWorld('kadr', api)
