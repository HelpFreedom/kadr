// What Kadr keeps on disk, from the renderer's side: the list of projects the
// panel is allowed to attribute files to, and thin wrappers over the two IPC
// calls that do the actual work in main.
import type { StorageProject, StoragePruneRequest } from '@shared/types'
import { useEditor } from '@/state/store'
import { logWarn } from './log'

const STORE = 'recent-projects'
const CAP = 20

interface Recent { path: string; at: number }

let cache: Recent[] | null = null

async function read(): Promise<Recent[]> {
  if (cache) return cache
  try {
    const raw = await window.kadr.readUserStore(STORE)
    cache = Array.isArray(raw)
      ? (raw as Recent[]).filter((r) => r && typeof r.path === 'string')
      : []
  } catch {
    cache = []
  }
  return cache
}

/**
 * Remember a project file. This is the only way the storage panel can say
 * "these 2.5 GB of proxies belong to THAT project" — a cache entry is named
 * after its source, not after whoever wanted it, so without a list of projects
 * every file on disk looks equally orphaned.
 */
export async function rememberProject(path: string): Promise<void> {
  const list = (await read()).filter((r) => r.path !== path)
  list.unshift({ path, at: Date.now() })
  cache = list.slice(0, CAP)
  try {
    await window.kadr.writeUserStore(STORE, cache)
  } catch (err) {
    logWarn('хранилище', 'не удалось запомнить проект в списке недавних', err)
  }
}

export async function recentProjects(): Promise<string[]> {
  return (await read()).map((r) => r.path)
}

export async function forgetProject(path: string): Promise<void> {
  cache = (await read()).filter((r) => r.path !== path)
  try { await window.kadr.writeUserStore(STORE, cache) } catch { /* stays for now */ }
}

/** The open project, whether or not it has ever been saved. */
export function openProjectInfo(): StorageProject {
  const s = useEditor.getState()
  const p = s.project
  return {
    name: p.name || 'Untitled',
    path: s.projectPath,
    assets: p.assets.map((a) => a.path).filter((x): x is string => !!x),
    fragmentIds: p.tracks.flatMap((t) => t.clips.map((c) => c.fragmentId).filter(Boolean) as string[]),
    runDirs: (p.voiceRuns ?? []).map((r) => r.runDir).filter((x): x is string => !!x)
  }
}

export async function scanStorage() {
  return window.kadr.storageScan(await recentProjects(), openProjectInfo())
}

export async function pruneStorage(req: Omit<StoragePruneRequest, 'projects' | 'open'>) {
  return window.kadr.storagePrune({
    confirm: true,   // the panel only calls this behind its own confirmation
    ...req,
    projects: await recentProjects(),
    open: openProjectInfo()
  })
}
