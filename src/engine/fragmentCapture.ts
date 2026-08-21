// Fragment pixel capture, renderer side: decides per remotion clip whether
// the iframe overlay suffices or the fragment must become a real compositor
// layer (masks, 3D, transitions, effects, overlaps), manages the offscreen
// capture windows in main, stores their latest frames for drawClipLayer and
// keeps the captured players synced to the editor clock.
import type { Anim, Clip, Project, Track } from '@shared/types'
import { useEditor } from '@/state/store'
import { evalAnim } from './anim'
import { fadeFactor, overlapFades } from './player'
import { ensureFragmentServer } from './fragments'

export interface CaptureFrame {
  data: Uint8Array
  w: number
  h: number
  version: number
}

const frames = new Map<string, CaptureFrame>()
const active = new Map<string, { clipId: string }>()
// Per fragment: the last frame number we asked the offscreen player to show,
// and the capture `version` at the moment we asked. captureReady() then waits
// for a paint that landed AFTER the request, so a snapshot reflects the target
// frame rather than whatever the offscreen happened to be showing.
const syncedFrame = new Map<string, number>()
const versionAtSync = new Map<string, number>()

/** Offscreen player frame for a fragment clip at editor time `playhead`. */
function frameOf(clip: Clip, playhead: number): number {
  const fps = clip.fragmentMeta?.fps ?? 60
  const rel = playhead - clip.start
  return Math.max(0, Math.round(
    (Math.max(0, Math.min(clip.duration, rel)) * (clip.speed || 1) + clip.inPoint) * fps
  ))
}

export function getCaptureFrame(fragmentId: string): CaptureFrame | null {
  return frames.get(fragmentId) ?? null
}

// Frame snapshots need FULL WYSIWYG: iframe-overlay fragments are DOM, not
// GL, so for the duration of a snapshot every active fragment is forced
// through pixel capture and lands in the compositor like any video layer.
let forceAll = false
let reconcileNow: (() => void) | null = null

export function setForceCaptureAll(on: boolean) {
  if (forceAll === on) return
  forceAll = on
  reconcileNow?.()
}

/** Every fragment wanted at time t is captured AND has painted a frame for the
 *  current sync target (not just any leftover frame). */
export function captureReady(project: Project, t: number): boolean {
  for (const id of wanted(project, t).keys()) {
    const f = frames.get(id)
    if (!f) return false
    // require a paint newer than the last frame request, so we don't read a
    // stale frame (e.g. the offscreen's initial frame before it seeked)
    if (f.version <= (versionAtSync.get(id) ?? -1)) return false
  }
  return true
}

const animActive = (a?: Anim) =>
  !!a && (Math.abs(a.value) > 1e-6 || (a.keyframes?.length ?? 0) > 0)

/** GL-only features on this clip — the iframe overlay can't show them. */
export function fragmentNeedsCapture(track: Track, clip: Clip): boolean {
  if ((clip.effects ?? []).some((e) => e.enabled)) return true
  const tr = clip.transform
  if (animActive(tr.rotX) || animActive(tr.rotY) || animActive(tr.z)) return true
  if (track.motion) return true
  const m = clip.mask
  if (m && [m.left, m.top, m.right, m.bottom].some((a) => animActive(a))) return true
  if ((clip.maskShapes?.length ?? 0) > 0 || clip.maskShape) return true
  if (clip.transitionIn && clip.transitionIn.type !== 'none') return true
  if (clip.transitionOut && clip.transitionOut.type !== 'none') return true
  const end = clip.start + clip.duration
  if (track.clips.some((o) => o.id !== clip.id && o.start < end && o.start + o.duration > clip.start)) {
    return true // overlap ⇒ Vegas-style transition blends pixels
  }
  return false
}

/** Captured fragments near the playhead right now (clip → fragment). */
function wanted(project: Project, t: number): Map<string, { clip: Clip; track: Track }> {
  const out = new Map<string, { clip: Clip; track: Track }>()
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'remotion' || !clip.fragmentId) continue
      if (t < clip.start - 2 || t >= clip.start + clip.duration + 0.75) continue
      if (!forceAll && !fragmentNeedsCapture(track, clip)) continue
      out.set(clip.fragmentId, { clip, track })
    }
  }
  return out
}

/** True when this clip is being shown through pixel capture. */
export function isCaptured(fragmentId: string): boolean {
  return active.has(fragmentId) && frames.has(fragmentId)
}

/** Capture is on for the clip (frames may still be on their way). */
export function captureRequested(fragmentId: string): boolean {
  return active.has(fragmentId)
}

const CAPTURE_MAX_W = 1280

export function wireFragmentCapture() {
  window.kadr.onFragmentFrame(({ id, w, h, data }) => {
    if (!active.has(id)) return
    frames.set(id, {
      data: data instanceof Uint8Array ? data : new Uint8Array(data),
      w,
      h,
      version: (frames.get(id)?.version ?? 0) + 1
    })
  })

  const syncOne = (fragmentId: string, clip: Clip, track: Track) => {
    const s = useEditor.getState()
    const rel = s.playhead - clip.start
    const inside = rel >= 0 && rel < clip.duration
    const vol = clip.muted || track.muted || !inside
      ? 0
      : Math.min(1, evalAnim(clip.gain, Math.max(0, rel)) * track.gain *
          fadeFactor(clip, Math.max(0, rel), overlapFades(track, clip)))
    const frame = frameOf(clip, s.playhead)
    // when the target frame changes, remember the current paint version so
    // captureReady() waits for the NEXT paint (the one that shows this frame)
    if (syncedFrame.get(fragmentId) !== frame) {
      syncedFrame.set(fragmentId, frame)
      versionAtSync.set(fragmentId, frames.get(fragmentId)?.version ?? 0)
    }
    window.kadr.fragmentCaptureSync(fragmentId, {
      kadr: true,
      type: 'sync',
      frame,
      playing: s.playing && inside,
      volume: vol
    })
  }

  const reconcile = async () => {
    const s = useEditor.getState()
    const want = wanted(s.project, s.playhead)
    for (const id of [...active.keys()]) {
      if (!want.has(id)) {
        active.delete(id)
        frames.delete(id)
        syncedFrame.delete(id)
        versionAtSync.delete(id)
        void window.kadr.fragmentCaptureStop(id)
      }
    }
    for (const [id, { clip, track }] of want) {
      if (!active.has(id)) {
        active.set(id, { clipId: clip.id })
        try {
          const url = await ensureFragmentServer()
          const meta = clip.fragmentMeta
          const cw = Math.min(CAPTURE_MAX_W, meta?.width ?? s.project.width)
          const ch = Math.round(cw * ((meta?.height ?? s.project.height) / (meta?.width ?? s.project.width)))
          // seed the player on the target frame so its first paint is correct
          const frame = frameOf(clip, s.playhead)
          await window.kadr.fragmentCaptureStart(
            id, `${url}/?comp=${encodeURIComponent(id)}&frame=${frame}`, cw, ch, meta?.fps ?? 60
          )
        } catch {
          active.delete(id)
        }
      }
      syncOne(id, clip, track)
    }
  }

  let scheduled = false
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(() => {
      scheduled = false
      void reconcile()
    }, 120)
  }
  reconcileNow = () => void reconcile()
  useEditor.subscribe(schedule)
  setInterval(schedule, 400) // drift correction while playing
}
