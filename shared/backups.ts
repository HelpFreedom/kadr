/**
 * Project backups: which versions are kept, and which one is offered back after
 * a crash. Pure — electron/backups.ts does the disk work.
 * Test: `node scripts/check-backups.mjs`.
 */

export const BACKUP_KEEP = 10
export const BACKUP_CAP_BYTES = 500 * 1024 * 1024

export interface BackupFile { name: string; size: number; mtime: number }

/**
 * The versions to delete: the newest ones are kept while there are fewer than
 * `keep` and they fit in `cap` bytes together; everything older than the first
 * one that does not fit goes. The newest is kept even if it alone is over the cap.
 */
export function backupsToPrune(files: BackupFile[], keep = BACKUP_KEEP, cap = BACKUP_CAP_BYTES): BackupFile[] {
  const newest = [...files].sort((a, b) => b.mtime - a.mtime)
  let bytes = 0
  for (let i = 0; i < newest.length; i++) {
    bytes += newest[i].size
    if (i >= keep || (i > 0 && bytes > cap)) return newest.slice(i)
  }
  return []
}

export interface RestoreCandidate {
  file: string
  mtime: number
  /** mtime of the project file the backup was made of; null when it was never saved or is gone */
  projectMtime: number | null
}

/**
 * The backup to offer after an unclean exit: written during the session that
 * died (`since` = its start, from the lock; null = the last exit was clean, no
 * offer), and newer than its project file — the newest such one. A backup of an
 * older session was already there to offer then, so it is not offered forever.
 */
export function pickRestore<T extends RestoreCandidate>(backups: T[], since: number | null): T | null {
  if (since === null) return null
  let best: T | null = null
  for (const b of backups) {
    if (b.mtime < since) continue
    if (b.projectMtime !== null && b.mtime <= b.projectMtime) continue
    if (!best || b.mtime > best.mtime) best = b
  }
  return best
}
