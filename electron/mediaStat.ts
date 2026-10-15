// Offline media and relink: which asset files are still on disk, and
// which file in a folder a missing one moved to. The matching rules live in
// shared/relinkMatch.ts (pure, `node scripts/check-relink-match.mjs`).
import { ipcMain } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { probeDuration } from './ffmpeg'
import { relinkMatch, type RelinkFile, type RelinkWanted } from '../shared/relinkMatch'

/** 1000 assets on a network drive: a few dozen stats in flight, not a thousand */
const STAT_BATCH = 64
/** ponytail: a flat cap on the folder walk — a whole drive picked by mistake stops here */
const SCAN_CAP = 20000

async function statMany(paths: string[]): Promise<(number | null)[]> {
  const out: (number | null)[] = []
  for (let i = 0; i < paths.length; i += STAT_BATCH) {
    out.push(...await Promise.all(paths.slice(i, i + STAT_BATCH).map(async (p) => {
      const st = await fs.stat(String(p)).catch(() => null)
      return st?.isFile() ? st.size : null
    })))
  }
  return out
}

async function listFiles(root: string): Promise<RelinkFile[]> {
  const files: RelinkFile[] = []
  const dirs = [root]
  while (dirs.length && files.length < SCAN_CAP) {
    const dir = dirs.shift()!
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (e.name.startsWith('.')) continue
      const p = join(dir, e.name)
      if (e.isDirectory()) dirs.push(p)
      else if (e.isFile()) files.push({ path: p, size: 0 })
    }
  }
  const sizes = await statMany(files.map((f) => f.path))
  return files.map((f, i) => ({ ...f, size: sizes[i] ?? -1 }))
}

export function registerMediaStatIpc(): void {
  ipcMain.handle('media:stat-many', (_e, paths: string[]) => statMany(Array.isArray(paths) ? paths : []))
  ipcMain.handle('media:relink-scan', async (_e, folder: string, wanted: RelinkWanted[]) =>
    relinkMatch(wanted, await listFiles(String(folder)), probeDuration))
}
