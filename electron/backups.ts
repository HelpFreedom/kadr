import { app, ipcMain, shell } from 'electron'
import { promises as fs, readFileSync, writeFileSync, rmSync } from 'fs'
import { join, resolve, sep } from 'path'
import { atomicWrite, sweepPartSidecars } from './atomicWrite'
import { projectKey } from './cacheKeys'
import { backupsToPrune, pickRestore, type RestoreCandidate } from '../shared/backups'
import type { BackupOffer } from '../shared/types'

/**
 * Versioned project backups and the restore offer after a crash.
 *
 * Every autosave tick writes `<userData>/backups/<project key>/<ISO time>.kadr`
 * (key: projectKey of the saved path, `unsaved-<project id>` before the first
 * save) plus `source.json` naming the project file; shared/backups.ts decides
 * which versions stay. `session.lock` is written at startup and removed on a
 * clean quit, so finding it at the next start means Kadr died — then the newest
 * backup written during that session and newer than its project file is offered.
 */

export const backupsDir = () => join(app.getPath('userData'), 'backups')
const lockPath = () => join(app.getPath('userData'), 'session.lock')

/** start of the session that died (from its lock), or null after a clean exit */
let crashedSince: number | null = null

export function beginSession() {
  try {
    const lock = JSON.parse(readFileSync(lockPath(), 'utf8'))
    crashedSince = Number(lock.started) || 0
  } catch { crashedSince = null }   // no lock: the last exit was clean
  try { writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, started: Date.now() })) } catch { /* no userData yet — nothing to offer either */ }
}

export function endSession() {
  rmSync(lockPath(), { force: true })
}

export async function writeBackup(json: string, mainPath: string | null, project: { id: string; name: string }): Promise<string> {
  const key = mainPath ? projectKey(resolve(mainPath)) : `unsaved-${String(project.id).replace(/[^\w-]/g, '')}`
  const dir = join(backupsDir(), key)
  await fs.mkdir(dir, { recursive: true })
  const out = join(dir, new Date().toISOString().replace(/:/g, '-') + '.kadr')
  await atomicWrite(out, json)
  await atomicWrite(join(dir, 'source.json'), JSON.stringify({ path: mainPath, name: project.name }))
  await sweepPartSidecars(dir)
  const files = []
  for (const name of await fs.readdir(dir)) {
    if (!name.endsWith('.kadr')) continue
    try { const st = await fs.stat(join(dir, name)); files.push({ name, size: st.size, mtime: st.mtimeMs }) } catch { /* gone */ }
  }
  for (const f of backupsToPrune(files)) await fs.rm(join(dir, f.name), { force: true }).catch(() => {})
  return out
}

async function findOffer(since: number | null): Promise<BackupOffer | null> {
  if (since === null) return null
  const all: (RestoreCandidate & { path: string | null; name: string })[] = []
  let keys: string[] = []
  try { keys = await fs.readdir(backupsDir()) } catch { return null }
  for (const key of keys) {
    const dir = join(backupsDir(), key)
    let src: { path: string | null; name: string }
    try { src = JSON.parse(await fs.readFile(join(dir, 'source.json'), 'utf8')) } catch { continue }
    let projectMtime: number | null = null
    if (src.path) try { projectMtime = (await fs.stat(src.path)).mtimeMs } catch { /* moved or deleted */ }
    let names: string[] = []
    try { names = await fs.readdir(dir) } catch { continue }
    for (const n of names) {
      if (!n.endsWith('.kadr')) continue
      try {
        const file = join(dir, n)
        all.push({ file, mtime: (await fs.stat(file)).mtimeMs, projectMtime, path: src.path, name: src.name })
      } catch { /* gone */ }
    }
  }
  const best = pickRestore(all, since)
  return best && { file: best.file, time: best.mtime, projectPath: best.path, name: best.name }
}

export function registerBackupIpc() {
  // asked once by the page at startup; consumed, so a reload does not ask again
  ipcMain.handle('backup:offer', async () => {
    const since = crashedSince
    crashedSince = null
    return findOffer(since)
  })
  ipcMain.handle('backup:reveal', (_e, file: string) => {
    const p = resolve(String(file))
    if (p.startsWith(resolve(backupsDir()) + sep)) shell.showItemInFolder(p)
  })
}
