// Where a defect of a voice-over shows up on the timeline.
//
// Defect times are SOURCE seconds of the asset, never timeline seconds: clips
// are moved, trimmed, split and rippled, and a timeline number would be stale
// after the first of those. Binding to the asset instead means the same defect
// draws on every clip that shows that part of the file — which is correct, and
// it is also why a regeneration (which rewrites the file) has to fix them all.
import type { Clip, Project, Track, AudioDefect } from '@shared/types'

/** Source second of this clip's asset → project second; null if outside it. */
export function srcToProject(clip: Clip, t: number): number | null {
  const speed = clip.speed || 1
  const rel = (t - clip.inPoint) / speed
  if (rel < 0 || rel > clip.duration) return null
  return clip.start + rel
}

export interface VisibleSpan {
  start: number
  end: number
  /** the clip's trim cut the span short on that side */
  clippedIn: boolean
  clippedOut: boolean
}

/** The visible part of a source span on one clip, or null if none of it shows. */
export function spanToProject(clip: Clip, a: number, b: number): VisibleSpan | null {
  const speed = clip.speed || 1
  const lo = clip.inPoint
  const hi = clip.inPoint + clip.duration * speed
  const from = Math.max(a, lo)
  const to = Math.min(b, hi)
  if (to <= from) return null
  return {
    start: clip.start + (from - lo) / speed,
    end: clip.start + (to - lo) / speed,
    clippedIn: a < lo,
    clippedOut: b > hi
  }
}

export interface DefectPlacement {
  defect: AudioDefect
  clipId: string
  trackId: string
  trackIndex: number
  /** the defect itself */
  src: VisibleSpan
  /** the phrase around it; null when the trim hid it entirely */
  phrase: VisibleSpan | null
}

/** Every clip that shows part of `assetId`, with its track index for drawing. */
export function clipsForAsset(project: Project, assetId: string):
  Array<{ clip: Clip; track: Track; trackIndex: number }> {
  const out: Array<{ clip: Clip; track: Track; trackIndex: number }> = []
  project.tracks.forEach((track, trackIndex) => {
    for (const clip of track.clips) {
      if (clip.assetId === assetId) out.push({ clip, track, trackIndex })
    }
  })
  return out
}

/**
 * Lay every defect onto the timeline.
 *
 * A defect appears once per clip showing it — twice if the voice-over was
 * duplicated, not at all if that part was trimmed away. NB looping clips show
 * it in the first pass only: `collectAudioSegments` wraps the source, and this
 * mapping deliberately does not, exactly like docTimeToProject.
 */
export function placeDefects(project: Project, defects?: AudioDefect[]): DefectPlacement[] {
  const list = defects ?? project.defects ?? []
  if (!list.length) return []
  const byAsset = new Map<string, Array<{ clip: Clip; track: Track; trackIndex: number }>>()
  const out: DefectPlacement[] = []
  for (const defect of list) {
    let clips = byAsset.get(defect.assetId)
    if (!clips) {
      clips = clipsForAsset(project, defect.assetId)
      byAsset.set(defect.assetId, clips)
    }
    for (const { clip, track, trackIndex } of clips) {
      const src = spanToProject(clip, defect.src[0], defect.src[1])
      if (!src) continue
      out.push({
        defect,
        clipId: clip.id,
        trackId: track.id,
        trackIndex,
        src,
        phrase: spanToProject(clip, defect.phrase.t0, defect.phrase.t1)
      })
    }
  }
  return out
}

/** Project second → source second of this clip's asset (for hand-placed marks). */
export function projectToSrc(clip: Clip, t: number): number {
  const speed = clip.speed || 1
  return clip.inPoint + (t - clip.start) * speed
}
