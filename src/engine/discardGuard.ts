import type { Project } from '@shared/types'

/**
 * Whether replacing the open project (New, Open, closing the window) must ask
 * first. Every edit makes a new project object, so "unsaved" is simply "not
 * the object that was last written or opened" — the same rule as the dirty
 * dot. `saved` is null before the app recorded anything: nothing to lose yet.
 * Test: `node scripts/check-discard-guard.mjs`.
 */
export function needsConfirm(project: Project, saved: Project | null): boolean {
  return saved !== null && project !== saved
}
