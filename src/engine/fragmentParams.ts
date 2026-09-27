// Fragment parameters, editor side (the fragment side is defineParams in
// electron/fragment-kit/runtime.ts). A slider in the Inspector sets a LIVE
// value: it goes straight to every page showing that fragment — iframes and
// capture windows — and the picture follows without a reload. When the
// dragging stops the values are written into the fragment's params.json,
// which the pages and the render read; the file is the truth from then on.
//
// Not in the undo history: like an edit of the fragment's code, this lives in
// the fragment's folder, not in the project.
import { create } from 'zustand'
import type { FragmentParamDecl, FragmentParamValue } from '@shared/types'
import { logError } from './log'

export const useFragmentParams = create<{ live: Record<string, Record<string, FragmentParamValue>> }>(() => ({
  live: {}
}))

/** the last values written (or read) per fragment, so a re-selected clip shows them at once */
const savedCache = new Map<string, Record<string, unknown>>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const pending = new Map<string, Promise<void>>()

export const SAVE_DELAY_MS = 400

export function rememberParamValues(fid: string, values: Record<string, unknown> | undefined) {
  if (values && !timers.has(fid) && !pending.has(fid)) savedCache.set(fid, { ...values })
}

/** a value is acceptable for its declaration: same type, finite */
export function paramOk(d: FragmentParamDecl, v: unknown): v is FragmentParamValue {
  return typeof v === typeof d.value && (typeof v !== 'number' || Number.isFinite(v))
}

/** what the fragment shows for every declared parameter right now */
export function paramValues(fid: string, decl: Record<string, FragmentParamDecl>, saved?: Record<string, unknown>) {
  const live = useFragmentParams.getState().live[fid] ?? {}
  const file = savedCache.get(fid) ?? saved ?? {}
  const out: Record<string, FragmentParamValue> = {}
  for (const [k, d] of Object.entries(decl)) {
    out[k] = paramOk(d, live[k]) ? live[k] : paramOk(d, file[k]) ? (file[k] as FragmentParamValue) : d.value
  }
  return out
}

/**
 * Set one value live and schedule the save. Only the values moved in this
 * session are sent; main merges them into the file as it is on disk NOW, so an
 * edit of params.json by hand (or by Claude) since is not overwritten.
 */
export function setParam(fid: string, name: string, value: FragmentParamValue) {
  const cur = useFragmentParams.getState().live[fid] ?? {}
  useFragmentParams.setState((s) => ({ live: { ...s.live, [fid]: { ...cur, [name]: value } } }))
  const t = timers.get(fid)
  if (t) clearTimeout(t)
  timers.set(fid, setTimeout(() => {
    timers.delete(fid)
    void save(fid, { ...(useFragmentParams.getState().live[fid] ?? {}) })
  }, SAVE_DELAY_MS))
}

/** Back to the declared defaults: the file is emptied, nothing stays live. */
export async function resetParams(fid: string) {
  const t = timers.get(fid)
  if (t) { clearTimeout(t); timers.delete(fid) }
  useFragmentParams.setState((s) => ({ live: { ...s.live, [fid]: {} } }))
  await save(fid, null)
}

async function save(fid: string, patch: Record<string, FragmentParamValue> | null) {
  const run = (pending.get(fid) ?? Promise.resolve()).then(async () => {
    try {
      const file = await window.kadr.fragmentParamsWrite(fid, patch)
      savedCache.set(fid, file)
      // What is live now equals the file. It stops being live only after the
      // pages have had time to reload the file (player page: 'kadr:params') —
      // dropped at once, a page still holding the old file would show the old
      // value for a moment — and only if nobody moved it meanwhile. From then
      // on the file decides, so an edit of params.json by hand (or by Claude)
      // is not overridden by a value the editor still held.
      setTimeout(() => {
        if (timers.has(fid)) return
        const live = { ...(useFragmentParams.getState().live[fid] ?? {}) }
        let changed = false
        for (const k of Object.keys(live)) {
          if (JSON.stringify(live[k]) === JSON.stringify(file[k])) { delete live[k]; changed = true }
        }
        if (changed) useFragmentParams.setState((s) => ({ live: { ...s.live, [fid]: live } }))
      }, 2000)
    } catch (e) {
      logError('параметры фрагмента', `${fid}: не удалось сохранить params.json`, e)
    }
  })
  pending.set(fid, run)
  await run
  if (pending.get(fid) === run) pending.delete(fid)
}

/** Write whatever is still waiting — before a render reads params.json. */
export async function flushParamSaves() {
  const due = [...timers.keys()]
  for (const fid of due) {
    clearTimeout(timers.get(fid)!)
    timers.delete(fid)
    await save(fid, { ...(useFragmentParams.getState().live[fid] ?? {}) })
  }
  await Promise.all([...pending.values()])
}
