// Offline media and relink. A source file that moved or was renamed
// used to be a silent black clip and an export that failed later with nothing
// said. Now its asset is OFFLINE: a runtime set of asset ids, never saved,
// recomputed from one `media:stat-many` pass whenever the project's asset paths
// change (open, restore, import, relink, its undo) and when the window regains
// focus. The timeline hatches its clips, the bin badges it, the export refuses
// by name, and the relink dialog points it at the file again.
import { create } from 'zustand'
import { useEditor } from '@/state/store'
import type { MediaAsset, Project } from '@shared/types'
import { baseOf } from '@shared/paths'
import { logError, logWarn } from './log'
import { tr } from '../i18n'

export const useOffline = create<{ ids: ReadonlySet<string>; dialog: boolean }>(() => ({
  ids: new Set<string>(),
  dialog: false
}))

export const openRelink = (open = true) => useOffline.setState({ dialog: open })

let pass = 0
let askNext = false

/** stat every asset now; resolves to the offline ids */
export async function refreshOffline(): Promise<ReadonlySet<string>> {
  const mine = ++pass
  const project = useEditor.getState().project
  const assets = project.assets
  const sizes = await window.kadr.statMany(assets.map((a) => a.path))
  const ids = new Set(assets.filter((_, i) => sizes[i] === null).map((a) => a.id))
  if (mine !== pass) return ids // a newer pass owns the state
  const prev = useOffline.getState().ids
  const fresh = [...ids].filter((id) => !prev.has(id))
  if (fresh.length) {
    const names = assets.filter((a) => fresh.includes(a.id)).map((a) => a.name)
    logWarn(tr('logRelink'), `${tr('offlineFound')}: ${names.join(', ')}`)
  }
  if (ids.size !== prev.size || fresh.length) useOffline.setState({ ids })
  // a project that opens with missing files asks; later passes only badge
  if (askNext) {
    askNext = false
    if (ids.size) openRelink()
  }
  return ids
}

let pending = false
function schedule() {
  if (pending) return
  pending = true
  // the stats run in main, batched; here it is one async IPC off the current
  // task. Not rAF: a window behind others gets no frames, and nothing would run.
  setTimeout(() => {
    pending = false
    refreshOffline().catch((err) => logError(tr('logRelink'), 'stat', err))
  }, 0)
}

/** a project was opened or restored: check its files now (same paths as before
    still need a pass — the file may have moved since) and ask if some are gone */
export function checkOfflineOnOpen(): void {
  askNext = true
  schedule()
}

const pathsKey = (p: Project) => p.assets.map((a) => `${a.id}\0${a.path}`).join('\n')

export function wireOffline(): void {
  let key = pathsKey(useEditor.getState().project)
  useEditor.subscribe((s, prev) => {
    if (s.project.assets === prev.project.assets) return
    const k = pathsKey(s.project)
    if (k !== key) { key = k; schedule() }
  })
  window.addEventListener('focus', schedule)
  schedule()
}

/** names of the files an export of `range` needs and cannot find — stat'ed now, not from the set */
export async function missingForExport(project: Project, range?: { start: number; end: number } | null): Promise<string[]> {
  const used = new Set<string>()
  for (const t of project.tracks) {
    for (const c of t.clips) {
      if (!c.assetId) continue
      if (range && (c.start >= range.end || c.start + c.duration <= range.start)) continue
      used.add(c.assetId)
    }
  }
  const assets = project.assets.filter((a) => used.has(a.id))
  const sizes = await window.kadr.statMany(assets.map((a) => a.path))
  return assets.filter((_, i) => sizes[i] === null).map((a) => baseOf(a.path))
}

/**
 * Point assets at new files: each file is probed first (a file that is not
 * media, or of another kind, is refused and logged), then every accepted one
 * is applied as ONE undo step. Resolves to the number relinked.
 */
export async function relinkTo(map: Record<string, string>): Promise<number> {
  const fresh: MediaAsset[] = []
  for (const [id, path] of Object.entries(map)) {
    const old = useEditor.getState().project.assets.find((a) => a.id === id)
    if (!old) continue
    try {
      const { asset } = await window.kadr.probeMedia(path)
      if (asset.kind !== old.kind) {
        logWarn(tr('logRelink'), `${tr('relinkWrongKind')}: ${path}`)
        continue
      }
      // a proxy was built from the old file: the new one gets its own
      fresh.push({ ...asset, id, ...(old.reverseOf ? { reverseOf: old.reverseOf } : {}) })
    } catch (err) {
      logError(tr('logRelink'), `${tr('relinkUnreadable')}: ${path}`, err)
    }
  }
  if (fresh.length) useEditor.getState().relinkAssets(fresh)
  await refreshOffline()
  return fresh.length
}

/** «Указать файл» */
export async function relinkPick(assetId: string): Promise<number> {
  const [path] = await window.kadr.openMediaDialog()
  return path ? relinkTo({ [assetId]: path }) : 0
}

/** «Искать в папке» — `folder` from the picker, or given (scripts, tests) */
export async function relinkFromFolder(folder?: string): Promise<number> {
  const dir = folder ?? await window.kadr.pickDirectory(tr('relinkFolder'))
  if (!dir) return 0
  const ids = await refreshOffline()
  const wanted = useEditor.getState().project.assets
    .filter((a) => ids.has(a.id))
    .map((a) => ({ id: a.id, path: a.path, size: a.size, duration: a.duration }))
  if (!wanted.length) return 0
  const found = await window.kadr.relinkScan(dir, wanted)
  const n = Object.keys(found).length ? await relinkTo(found) : 0
  if (n < wanted.length) logWarn(tr('logRelink'), `${tr('relinkNotFound')}: ${wanted.length - n} · ${dir}`)
  return n
}
