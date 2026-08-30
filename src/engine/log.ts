// The editor's own log, and the reason it exists: twenty places in the
// renderer reported a failure with console.warn and nothing else. A snapshot
// that did not happen, a normalisation that gave up, a drop that imported
// nothing, an autosave that failed — from the user's chair all of them looked
// like "I clicked and nothing happened", and the explanation sat in a devtools
// window nobody opens while editing.
//
// Everything here lives in memory only. Closing the editor takes the log with
// it: this is a window into the running session, not a diary, and a log file
// would be one more thing growing quietly on a disk with 16 GB free.
import { create } from 'zustand'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  t: number
  level: LogLevel
  /** short, human, in the user's language: «экспорт», «снимок», «импорт» */
  source: string
  msg: string
  /** stack or dump — folded away until asked for */
  detail?: string
}

/** Kept small on purpose: this is the tail of a session, not its history. */
const CAP = 500

export const useLog = create<{
  entries: LogEntry[]
  /** warnings and errors since the panel was last looked at */
  unseen: number
}>(() => ({ entries: [], unseen: 0 }))

let nextId = 1

/** Errors arrive as anything; make them readable without losing the stack. */
function describe(detail: unknown): string | undefined {
  if (detail === undefined || detail === null) return undefined
  if (detail instanceof Error) return detail.stack || `${detail.name}: ${detail.message}`
  if (typeof detail === 'string') return detail
  try {
    const s = JSON.stringify(detail, null, 1)
    return s && s.length > 4000 ? s.slice(0, 4000) + '\n…' : s
  } catch {
    return String(detail)
  }
}

function push(level: LogLevel, source: string, msg: string, detail?: unknown) {
  const entry: LogEntry = {
    id: nextId++, t: Date.now(), level, source, msg, detail: describe(detail)
  }
  useLog.setState((s) => ({
    entries: s.entries.length >= CAP
      ? [...s.entries.slice(s.entries.length - CAP + 1), entry]
      : [...s.entries, entry],
    unseen: level === 'info' ? s.unseen : s.unseen + 1
  }))
  // still printed: devtools stays as useful as it was, and nothing that
  // watched the console loses its output
  const line = `[kadr] ${source}: ${msg}`
  if (level === 'error') console.error(line, detail ?? '')
  else if (level === 'warn') console.warn(line, detail ?? '')
  else console.info(line, detail ?? '')
}

export const logInfo = (source: string, msg: string, detail?: unknown) =>
  push('info', source, msg, detail)
export const logWarn = (source: string, msg: string, detail?: unknown) =>
  push('warn', source, msg, detail)
export const logError = (source: string, msg: string, detail?: unknown) =>
  push('error', source, msg, detail)

/** The panel was opened: the badge goes quiet until something new happens. */
export const markLogSeen = () => useLog.setState({ unseen: 0 })

export const clearLog = () => useLog.setState({ entries: [], unseen: 0 })

/** One plain-text block, for pasting into a bug report or to Claude. */
export function logAsText(): string {
  return useLog.getState().entries.map((e) => {
    const ts = logTime(e.t)
    const head = `${ts}  ${e.level.toUpperCase().padEnd(5)} ${e.source}: ${e.msg}`
    return e.detail ? `${head}\n    ${e.detail.replace(/\n/g, '\n    ')}` : head
  }).join('\n')
}

/** 24-hour, fixed width: a locale that renders "10:04:52 PM" is neither at
 *  home in a Russian interface nor readable as a column. */
export function logTime(t: number): string {
  const d = new Date(t)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
}

/**
 * Chromium delivers two ResizeObserver notices through window.onerror:
 * «loop limit exceeded» and «loop completed with undelivered notifications».
 * Neither is a failure. The spec says an observation that could not be
 * delivered within a frame is delivered in the next one — nothing is lost, and
 * they carry no Error and no stack, i.e. nothing anyone can act on. So they
 * must not light the amber counter a real failure lights: they are kept as
 * INFO, still in the panel for whoever looks and silent for everyone else.
 * (One such notice used to fire on every preview detach — the observers there
 * were left behind in the editor's document; that cause is fixed at the
 * source in AudioMeter/FragmentOverlays/FragmentGizmo. This stays because the
 * notice can also come from layout work that is not ours.)
 */
const RESIZE_NOTICE = /^ResizeObserver loop /

let wired = false

/**
 * Catch what no `catch` block did. Without this the log would only ever hold
 * failures somebody already thought to report, which are the ones that hurt
 * least.
 */
export function wireLog() {
  if (wired) return
  wired = true
  window.addEventListener('error', (e) => {
    // a failed <video>/<img> load also lands here, with the element as target
    const el = e.target as HTMLElement | null
    if (el && (el instanceof HTMLVideoElement || el instanceof HTMLImageElement)) return
    const msg = e.message || 'необработанная ошибка'
    if (RESIZE_NOTICE.test(msg)) {
      logInfo('раскладка', `${msg} — не сбой: доставку перенесли на следующий кадр`)
      return
    }
    logError('сбой', msg, e.error ?? e.filename)
  })
  window.addEventListener('unhandledrejection', (e) => {
    logError('сбой', 'необработанный отказ промиса', e.reason)
  })
}
