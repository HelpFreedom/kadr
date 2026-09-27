// «Луковая кожура» — a video clip's frame laid translucently over the whole
// preview, fragments included. Made for lining a 3D camera up with filmed
// footage: the fragment on top hides the video underneath, and without this
// the only way to compare them was to toggle tracks and remember the picture.
// "Разница" shows |preview − footage|: where they match it goes black.
//
// A guide, never part of the picture: it is a DOM element over the preview,
// so snapshots and exports do not see it.
import { create } from 'zustand'
import type { Clip, MediaAsset, Project } from '@shared/types'
import { useEditor } from '@/state/store'
import { clipSourceTime } from './player'

interface OnionState {
  on: boolean
  /** the video clip shown */
  clipId: string | null
  opacity: number
  /** mix-blend-mode: difference */
  diff: boolean
}

const PREFS = 'kadr.onion'
const prefs = (): Partial<OnionState> => {
  try { return JSON.parse(localStorage.getItem(PREFS) || '{}') } catch { return {} }
}

export const useOnion = create<OnionState>(() => ({
  on: false,
  clipId: null,
  opacity: typeof prefs().opacity === 'number' ? prefs().opacity! : 0.5,
  diff: prefs().diff === true
}))

useOnion.subscribe((s, p) => {
  if (s.opacity === p.opacity && s.diff === p.diff) return
  try { localStorage.setItem(PREFS, JSON.stringify({ opacity: s.opacity, diff: s.diff })) } catch { /* per-viewer nicety */ }
})

/** a clip that can be an onion: plain video on a video track */
function isFootage(project: Project, clip: Clip): boolean {
  if (clip.kind !== 'media' || !clip.assetId) return false
  const a = project.assets.find((x) => x.id === clip.assetId)
  return !!a && a.kind === 'video'
}

/**
 * Which clip to show: the selected footage clip; else the footage under the
 * playhead (the one a fragment above is hiding — the usual case); else the
 * footage nearest to the playhead.
 */
export function pickOnionClip(project: Project, selection: string[], t: number): string | null {
  const all = project.tracks.filter((tr) => tr.kind === 'video').flatMap((tr) => tr.clips)
    .filter((c) => isFootage(project, c))
  const sel = all.find((c) => selection.includes(c.id))
  if (sel) return sel.id
  const under = all.find((c) => t >= c.start && t < c.start + c.duration)
  if (under) return under.id
  let best: Clip | null = null
  let bd = Infinity
  for (const c of all) {
    const d = t < c.start ? c.start - t : t - (c.start + c.duration)
    if (d < bd) { bd = d; best = c }
  }
  return best?.id ?? null
}

export function setOnion(on: boolean): boolean {
  if (!on) { useOnion.setState({ on: false }); return false }
  const s = useEditor.getState()
  const clipId = pickOnionClip(s.project, s.selection, s.playhead)
  useOnion.setState({ on: !!clipId, clipId })
  return !!clipId
}

export const toggleOnion = () => setOnion(!useOnion.getState().on)

/**
 * The frame of the onion clip for timeline time t: its own source time while
 * t is inside the clip, and its first/last frame outside it (so the guide
 * stays up while the fragment above is scrubbed past the clip's ends).
 */
export function onionFrame(project: Project, clipId: string | null, t: number):
  { clip: Clip; asset: MediaAsset; time: number; speed: number } | null {
  if (!clipId) return null
  const clip = project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clipId)
  const asset = clip && project.assets.find((a) => a.id === clip.assetId)
  if (!clip || !asset) return null
  const rel = Math.max(0, Math.min(clip.duration - 1e-3, t - clip.start))
  return { clip, asset, time: clipSourceTime(clip, asset, rel), speed: clip.speed || 1 }
}

/** follow the selection: picking another footage clip while the onion is up shows that one */
export function wireOnion() {
  useEditor.subscribe((s, p) => {
    const o = useOnion.getState()
    if (!o.on) return
    if (s.selection !== p.selection) {
      const sel = s.project.tracks.flatMap((tr) => tr.clips)
        .find((c) => s.selection.includes(c.id) && isFootage(s.project, c))
      if (sel && sel.id !== o.clipId) useOnion.setState({ clipId: sel.id })
    }
    // the clip was deleted: another one, or off
    if (s.project !== p.project && o.clipId &&
        !s.project.tracks.some((tr) => tr.clips.some((c) => c.id === o.clipId))) {
      setOnion(true)
    }
  })
}
