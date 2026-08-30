import { app, ipcMain } from 'electron'
import { promises as fs, statfsSync } from 'fs'
import { join, basename, resolve, sep } from 'path'
import { mediaCacheKey, proxySuffix, decodedSuffix } from './cacheKeys'
import type {
  StorageScan, StorageGroup, StorageGroupId, StorageProject, StoragePruneRequest,
  StoragePruneResult
} from '../shared/types'

/**
 * What Kadr has left on the disk, and what of it may go.
 *
 * The split that matters is not "big vs small" but REBUILDABLE vs REFERENCED.
 * A proxy, a decoded intermediate and a fragment render all name themselves
 * after their source (see cacheKeys.ts), so deleting one costs time and
 * nothing else: the same name is produced again on demand, and the project
 * that points at it finds it back. A reversed clip, a downloaded file and a
 * voice-over run are the opposite — the project stores their path, and there
 * is no way to derive them a second time. Those are shown, sized and
 * attributed, but the panel never offers a cheerful one-click delete for them.
 */

const homeCache = () =>
  process.env.KADR_TTSQC_CACHE || join(app.getPath('home'), '.cache', 'kadr', 'ttsqc')

interface GroupDef {
  id: StorageGroupId
  dir: () => string
  rebuildable: boolean
  /** how a file in this directory is tied back to a project */
  match: 'key' | 'path' | 'prefix' | 'none'
}

const GROUPS: GroupDef[] = [
  { id: 'proxies', dir: () => join(app.getPath('userData'), 'proxies'), rebuildable: true, match: 'key' },
  { id: 'decoded', dir: () => join(app.getPath('userData'), 'decoded'), rebuildable: true, match: 'key' },
  { id: 'fragments', dir: () => join(app.getPath('userData'), 'fragment-renders'), rebuildable: true, match: 'prefix' },
  { id: 'ttsqcCache', dir: homeCache, rebuildable: true, match: 'none' },
  { id: 'reversed', dir: () => join(app.getPath('userData'), 'reversed'), rebuildable: false, match: 'path' },
  { id: 'imported', dir: () => join(app.getPath('userData'), 'imported'), rebuildable: false, match: 'path' },
  { id: 'voiceRuns', dir: () => join(app.getPath('userData'), 'ttsqc-runs'), rebuildable: false, match: 'path' }
]

/** Every project we were told about, reduced to what identifies its files. */
interface Known {
  /** the path, or '#open' for a project that has never been saved. NOT the
   *  name: a user's projects are routinely all called "Untitled", and keying
   *  by name silently merged twelve of them into one row */
  id: string
  name: string
  path: string | null
  /** absolute source paths of its assets */
  assets: string[]
  fragmentIds: string[]
  runDirs: string[]
}

async function readProjectFile(path: string): Promise<Known | null> {
  try {
    const p = JSON.parse(await fs.readFile(path, 'utf8'))
    return {
      id: path,
      name: p.name || basename(path),
      path,
      assets: (p.assets ?? []).map((a: { path?: string }) => a.path).filter(Boolean),
      fragmentIds: (p.tracks ?? []).flatMap((t: { clips?: { fragmentId?: string }[] }) =>
        (t.clips ?? []).map((c) => c.fragmentId).filter(Boolean)),
      runDirs: (p.voiceRuns ?? []).map((r: { runDir?: string }) => r.runDir).filter(Boolean)
    }
  } catch {
    return null   // moved, deleted, or not a project — simply unknown to us
  }
}

/**
 * The cache names a project would produce today. A source that has been moved
 * or re-encoded since simply yields no key, and its old entries show up as
 * belonging to nobody — which is exactly what they are.
 */
async function keysOf(k: Known): Promise<Set<string>> {
  const keys = new Set<string>()
  const add = async (src: string) => {
    let st
    try { st = await fs.stat(src) } catch { return }
    for (const suffix of [proxySuffix(false), proxySuffix(true),
                          decodedSuffix(), decodedSuffix({ alpha: true }), decodedSuffix({ packed: true })]) {
      keys.add(mediaCacheKey(src, st.size, st.mtimeMs, suffix))
    }
  }
  for (const src of k.assets) await add(src)
  // A decoded intermediate is usually built from a RENDERED FRAGMENT, not from
  // a project asset: the exporter materialises fragments first and only then
  // packs their alpha. Without this pass those files belong to nobody, and the
  // largest group on disk reads as pure garbage when much of it is in use.
  if (k.fragmentIds.length) {
    const dir = join(app.getPath('userData'), 'fragment-renders')
    let names: string[] = []
    try { names = await fs.readdir(dir) } catch { /* nothing rendered yet */ }
    for (const name of names) {
      if (!k.fragmentIds.some((id) => name.startsWith(id + '-'))) continue
      await add(join(dir, name))
    }
  }
  return keys
}

const inside = (dir: string, path: string) => {
  const d = resolve(dir) + sep
  return resolve(path).startsWith(d)
}

async function entriesOf(dir: string): Promise<{ path: string; name: string; size: number; mtime: number }[]> {
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return [] }
  const out = []
  for (const name of names) {
    const path = join(dir, name)
    try {
      const st = await fs.stat(path)
      // a run is a directory of its own; everything else is a file
      out.push({ path, name, size: st.isDirectory() ? await dirSize(path) : st.size, mtime: st.mtimeMs })
    } catch { /* vanished while we looked */ }
  }
  return out
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return 0 }
  for (const n of names) {
    try {
      const st = await fs.stat(join(dir, n))
      total += st.isDirectory() ? await dirSize(join(dir, n)) : st.size
    } catch { /* gone */ }
  }
  return total
}

/** Which of the known projects claims this file. */
function ownersOf(
  def: GroupDef,
  entry: { path: string; name: string },
  known: Known[],
  keys: Map<string, Set<string>>
): string[] {
  const out: string[] = []
  for (const k of known) {
    let mine = false
    if (def.match === 'key') {
      const key = entry.name.split('.')[0]
      mine = keys.get(k.id)?.has(key) ?? false
    } else if (def.match === 'prefix') {
      // fragment renders are named "<fragmentId>-<hash>-q2[-a].<ext>"
      mine = k.fragmentIds.some((id) => entry.name.startsWith(id + '-'))
    } else if (def.match === 'path') {
      mine = k.assets.some((a) => a === entry.path || inside(entry.path, a)) ||
             k.runDirs.some((r) => resolve(r) === resolve(entry.path))
    }
    if (mine) out.push(k.id)
  }
  return out
}

async function collect(projects: string[], open: StorageProject | null): Promise<Known[]> {
  const known: Known[] = []
  if (open) {
    known.push({
      id: open.path ?? '#open',
      name: open.name, path: open.path ?? null,
      assets: open.assets, fragmentIds: open.fragmentIds, runDirs: open.runDirs
    })
  }
  for (const p of projects) {
    if (open?.path && resolve(open.path) === resolve(p)) continue   // already have it, fresher
    const k = await readProjectFile(p)
    if (k) known.push(k)
  }
  return known
}

async function scan(projects: string[], open: StorageProject | null): Promise<StorageScan> {
  const known = await collect(projects, open)
  const keys = new Map<string, Set<string>>()
  for (const k of known) keys.set(k.id, await keysOf(k))
  const label = new Map(known.map((k) => [k.id, k.name]))

  const groups: StorageGroup[] = []
  for (const def of GROUPS) {
    const dir = def.dir()
    const entries = await entriesOf(dir)
    const byProject: Record<string, { files: number; bytes: number }> = {}
    let staleFiles = 0
    let staleBytes = 0
    let bytes = 0
    for (const e of entries) {
      bytes += e.size
      const owners = ownersOf(def, e, known, keys)
      if (owners.length === 0) {
        staleFiles++
        staleBytes += e.size
      }
      for (const o of owners) {
        byProject[o] = byProject[o] || { files: 0, bytes: 0 }
        byProject[o].files++
        byProject[o].bytes += e.size
      }
    }
    groups.push({
      id: def.id,
      dir,
      rebuildable: def.rebuildable,
      attributed: def.match !== 'none',
      files: entries.length,
      bytes,
      stale: { files: staleFiles, bytes: staleBytes },
      byProject: Object.entries(byProject)
        .map(([id, v]) => ({ id, name: label.get(id) ?? id, ...v }))
        .sort((a, b) => b.bytes - a.bytes)
    })
  }

  let freeBytes = 0
  try {
    const st = statfsSync(app.getPath('userData'))
    freeBytes = Number(st.bavail) * Number(st.bsize)
  } catch { /* unknown — the panel simply omits it */ }

  return {
    groups,
    projects: known.map((k) => ({ id: k.id, name: k.name, path: k.path, assets: k.assets.length })),
    totalBytes: groups.reduce((n, g) => n + g.bytes, 0),
    freeBytes
  }
}

/**
 * Delete, but never on the renderer's word alone: the page names a group and a
 * scope, main re-scans and decides which files that means. The page cannot
 * name a path, so it cannot name a path outside these directories — the same
 * rule the voice-over version cleanup already works by.
 */
async function prune(req: StoragePruneRequest): Promise<StoragePruneResult> {
  const def = GROUPS.find((g) => g.id === req.group)
  if (!def) return { removed: 0, bytes: 0, error: 'unknown group' }
  const known = await collect(req.projects ?? [], req.open ?? null)
  const keys = new Map<string, Set<string>>()
  for (const k of known) keys.set(k.id, await keysOf(k))

  const dir = def.dir()
  const entries = await entriesOf(dir)
  const only = req.only && new Set(req.only)
  const doomed = entries.filter((e) => {
    if (only && !only.has(e.name)) return false
    const owners = ownersOf(def, e, known, keys)
    if (req.scope === 'stale') return owners.length === 0
    if (req.scope === 'project') return req.project ? owners.includes(req.project) : false
    return true   // 'all'
  })
  // a project's own files may only be dropped when they can come back
  if (req.scope !== 'stale' && !def.rebuildable) {
    return { removed: 0, bytes: 0, error: 'not rebuildable' }
  }

  const wouldTake = { removed: doomed.length, bytes: doomed.reduce((n, e) => n + e.size, 0) }
  // Fail towards keeping the files. A request that does not SAY delete does
  // not delete — including one from a caller newer than this handler, whose
  // extra flags mean nothing here.
  if (req.dryRun || !req.confirm) return wouldTake

  let removed = 0
  let bytes = 0
  for (const e of doomed) {
    if (!inside(dir, e.path)) continue   // belt and braces: never outside the group
    try {
      await fs.rm(e.path, { recursive: true, force: true })
      removed++
      bytes += e.size
    } catch { /* in use, or gone already */ }
  }
  return { removed, bytes }
}

export function registerStorageIpc() {
  ipcMain.handle('storage:scan', (_e, projects: string[], open: StorageProject | null) =>
    scan(Array.isArray(projects) ? projects : [], open ?? null))
  ipcMain.handle('storage:prune', (_e, req: StoragePruneRequest) => prune(req))
}
