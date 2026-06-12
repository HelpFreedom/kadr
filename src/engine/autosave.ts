// Autosave: every 5 minutes a changed project is written to
// <name>.autosave.kadr next to the saved file (Downloads when never saved).
// Paused while an export runs or an embedded Claude session is open — those
// must never compete for the disk or snapshot a mid-mutation project.
import type { Project } from '@shared/types'
import { useEditor } from '@/state/store'

/** Heavy activities flip these; autosave skips its tick while any is set. */
export const activity = {
  exporting: false,
  claude: false
}

const INTERVAL_MS = 5 * 60 * 1000

let lastSnapshot: Project | null = null

async function tick() {
  if (activity.exporting || activity.claude) return
  const s = useEditor.getState()
  if (s.project === lastSnapshot) return // nothing changed since the last write
  const clips = s.project.tracks.reduce((n, t) => n + t.clips.length, 0)
  if (!clips && !(s.project.texts?.length)) return // nothing worth keeping
  try {
    const snapshot = s.project
    await window.kadr.autosaveProject(snapshot, s.projectPath)
    lastSnapshot = snapshot
  } catch (err) {
    console.warn('[kadr] autosave failed (will retry):', err)
  }
}

export function wireAutosave() {
  setInterval(() => void tick(), INTERVAL_MS)
}

/** Run one autosave check right now (tests / manual trigger). */
export const autosaveNow = tick
