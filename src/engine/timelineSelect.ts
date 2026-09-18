// Which clips a selection gesture on the timeline covers. Pure geometry over
// the model — the pixels are converted to a track list and a time span by the
// caller, so this file has nothing to do with the DOM and can be checked
// without the app: node scripts/check-select.mjs
import type { Project } from '@shared/types'

/** Clips of the given tracks that overlap (t0, t1) — what a rubber band drawn
    over those lanes catches. Touching an edge does not count, so a band that
    stops exactly at a cut takes the clip it is over and not its neighbour.
    A LOCKED track is skipped: a selection that cannot be moved or deleted is
    a lie the user only discovers by pressing Delete and seeing nothing go. */
export function clipsInSpan(p: Project, trackIds: string[], t0: number, t1: number): string[] {
  const out: string[] = []
  for (const tr of p.tracks) {
    if (tr.locked || !trackIds.includes(tr.id)) continue
    for (const c of tr.clips) {
      if (c.start < t1 && c.start + c.duration > t0) out.push(c.id)
    }
  }
  return out
}

/** Drop whatever sits on a locked track. Every selection goes through
    withLinked() to pick up A/V twins, and that helper adds a partner without
    looking at the lock — so a band over the video of a pair whose audio is
    locked would select both, and then move, delete or trim exactly one of
    them: the store skips locked tracks, and the pair comes apart. */
export function unlocked(p: Project, ids: string[]): string[] {
  const want = new Set(ids)
  const live = new Set<string>()
  for (const tr of p.tracks) {
    if (tr.locked) continue
    for (const c of tr.clips) if (want.has(c.id)) live.add(c.id)
  }
  return ids.filter((id) => live.has(id))
}

/** Explorer's Shift+click: every clip in the rectangle the two named clips
    span — the tracks from one to the other, over the time they cover
    together. Either id missing (a clip deleted while the menu was open)
    selects nothing rather than half a rectangle. */
export function clipsBetween(p: Project, aId: string, bId: string): string[] {
  const at = p.tracks.findIndex((tr) => tr.clips.some((c) => c.id === aId))
  const bt = p.tracks.findIndex((tr) => tr.clips.some((c) => c.id === bId))
  if (at < 0 || bt < 0) return []
  const a = p.tracks[at].clips.find((c) => c.id === aId)!
  const b = p.tracks[bt].clips.find((c) => c.id === bId)!
  const ids = p.tracks.slice(Math.min(at, bt), Math.max(at, bt) + 1).map((tr) => tr.id)
  return clipsInSpan(
    p,
    ids,
    Math.min(a.start, b.start),
    Math.max(a.start + a.duration, b.start + b.duration)
  )
}
