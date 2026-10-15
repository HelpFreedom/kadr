// Autosave: every 5 minutes, and after 25 undo steps, a changed project is
// written as a backup version (userData/backups, electron/backups.ts) and to
// <name>.autosave.kadr next to a saved project. Paused while an export or the
// voice-over check runs — those hold the disk and the GPU for minutes. NOT
// paused for a Claude session: every edit replaces the project object
// wholesale (zustand), so a tick can never catch a half-applied change.
import type { Project } from '@shared/types'
import { useEditor } from '@/state/store'
import { logWarn } from './log'

/** Heavy activities flip these; autosave skips its tick while any is set. */
export const activity = {
  exporting: false,
  /** the defect detector holds the GPU for minutes */
  voiceCheck: false
}

const INTERVAL_MS = 5 * 60 * 1000
/** undo steps between two backups (Kdenlive's rule) */
const OPS_PER_BACKUP = 25

let lastSnapshot: Project | null = null
let busy = false

async function tick() {
  if (busy || activity.exporting || activity.voiceCheck) return
  const s = useEditor.getState()
  if (s.project === lastSnapshot) return // nothing changed since the last write
  const clips = s.project.tracks.reduce((n, t) => n + t.clips.length, 0)
  if (!clips && !(s.project.texts?.length)) return // nothing worth keeping
  busy = true
  try {
    const snapshot = s.project
    await window.kadr.autosaveProject(snapshot, s.projectPath)
    lastSnapshot = snapshot
  } catch (err) {
    logWarn('автосохранение', 'не удалось записать, повторю через 5 минут', err)
  } finally {
    busy = false
  }
}

export function wireAutosave() {
  setInterval(() => void tick(), INTERVAL_MS)
  // every history move counts (push, undo, redo): `past` is a new array each time
  let ops = 0
  useEditor.subscribe((s, prev) => {
    if (s.past !== prev.past && ++ops >= OPS_PER_BACKUP) { ops = 0; void tick() }
  })
}

/** Run one autosave check right now (tests / manual trigger). */
export const autosaveNow = tick
