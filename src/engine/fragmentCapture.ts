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
import { logError, logWarn } from './log'
import { useFragmentParams } from './fragmentParams'

export interface CaptureFrame {
  data: Uint8Array
  w: number
  h: number
  version: number
}

const frames = new Map<string, CaptureFrame>()
const active = new Map<string, { clipId: string }>()
// GLOBALLY monotonic paint counter. A per-fragment counter reset on every
// capture restart: a restarted capture's first frame carried version 1 —
// the SAME number the GL texture cache remembered from the previous session
// for that clip — so the compositor skipped the upload and kept compositing
// the stale texture (the reported «snapshot shows the previous frame» bug).
let paintSeq = 0

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
  // a snapshot takes the fragments at the project's full width; live preview
  // goes back to ≤1280 afterwards (already running windows are resized)
  const p = useEditor.getState().project
  for (const [id, { clipId }] of active) {
    const clip = p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
    const [w, h] = captureSize(clip, p)
    void window.kadr.fragmentCaptureResize?.(id, w, h)
  }
  reconcileNow?.()
}

const CAPTURE_MAX_W = 1280

/** Capture window size for a clip: ≤1280 wide live, full width for snapshots. */
function captureSize(clip: Clip | undefined, p: Project): [number, number] {
  const mw = clip?.fragmentMeta?.width ?? p.width
  const mh = clip?.fragmentMeta?.height ?? p.height
  const cw = forceAll ? mw : Math.min(CAPTURE_MAX_W, mw)
  return [cw, Math.round(cw * (mh / mw))]
}

/** Every fragment wanted at time t is captured and has frames on hand. */
export function captureReady(project: Project, t: number): boolean {
  for (const id of wanted(project, t).keys()) {
    if (!frames.has(id)) return false
  }
  return true
}

/** Fragments captured at t and the player frame each one must sit on
    (same formula as syncOne) — snapshots verify against this. */
export function captureTargets(
  project: Project,
  t: number
): { fragmentId: string; expectedFrame: number }[] {
  const out: { fragmentId: string; expectedFrame: number }[] = []
  for (const [id, { clip }] of wanted(project, t)) {
    const rel = t - clip.start
    // only what is on screen at t matters to the picture; a capture kept
    // warm for a clip that has just ended sits on its LAST frame, and the
    // old formula expected one past it — a frame no player can show, so the
    // snapshot waited out its whole deadline (measured: 24 s at a cut)
    if (rel < 0 || rel >= clip.duration) continue
    out.push({ fragmentId: id, expectedFrame: fragmentFrameAt(clip, rel) })
  }
  return out
}

/** The composition frame a fragment clip shows `rel` seconds into it —
    within the composition (a clip may run longer than its source). */
export function fragmentFrameAt(clip: Clip, rel: number): number {
  const fps = clip.fragmentMeta?.fps ?? 60
  const f = Math.round((Math.max(0, Math.min(clip.duration, rel)) * (clip.speed || 1) + clip.inPoint) * fps)
  const last = (clip.fragmentMeta?.durationInFrames ?? Infinity) - 1
  return Math.max(0, Math.min(last, f))
}

/** Monotonic paint counter of a captured fragment (0 = nothing yet). */
export function captureVersion(fragmentId: string): number {
  return frames.get(fragmentId)?.version ?? 0
}

/** Push a sync to every capture right now (skips the 120 ms debounce). */
export function pokeCaptureSync() {
  reconcileNow?.()
}

const animActive = (a?: Anim) =>
  !!a && (Math.abs(a.value) > 1e-6 || (a.keyframes?.length ?? 0) > 0)

/** GL-only features on this clip — the iframe overlay can't show them. */
export function fragmentNeedsCapture(track: Track, clip: Clip, project?: Project): boolean {
  if (ownNeedsCapture(track, clip)) return true
  if (!project) return false
  // An iframe is DOM stacked OVER the GL canvas, so a fragment shown that way
  // is drawn above everything the compositor draws — including clips on the
  // tracks above it. An opaque background fragment under screencast cards hid
  // the cards completely in the preview (the export, composited on the GPU,
  // was right). Such a fragment goes through pixel capture, i.e. into the GL
  // stack at its own track's depth. Fragments above that are iframes
  // themselves are fine: FragmentOverlays stacks those in track order.
  const idx = project.tracks.findIndex((t) => t.id === track.id)
  const end = clip.start + clip.duration
  for (let i = 0; i < idx; i++) {
    const t = project.tracks[i]
    if (t.kind !== 'video' || t.muted) continue
    for (const c of t.clips) {
      if (c.start >= end || c.start + c.duration <= clip.start) continue
      if (c.kind !== 'remotion' || ownNeedsCapture(t, c)) return true
    }
  }
  return false
}

/** what forces capture by the clip itself: GL-only features, blending transitions */
function ownNeedsCapture(track: Track, clip: Clip): boolean {
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
      if (!forceAll && !fragmentNeedsCapture(track, clip, project)) continue
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

export function wireFragmentCapture() {
  window.kadr.onFragmentCaptureLog?.(({ id, level, msg }) => {
    ;(level === 'error' ? logError : logWarn)('захват фрагмента', `${id}: ${msg}`)
  })
  window.kadr.onFragmentFrame(({ id, w, h, data }) => {
    if (!active.has(id)) return
    frames.set(id, {
      data: data instanceof Uint8Array ? data : new Uint8Array(data),
      w,
      h,
      version: ++paintSeq
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
    window.kadr.fragmentCaptureSync(fragmentId, {
      kadr: true,
      type: 'sync',
      frame: fragmentFrameAt(clip, rel),
      playing: s.playing && inside,
      volume: vol
    })
    // a capture window has no parent to say 'ready' to, so the parameters
    // ride along with every sync (the page ignores a repeat)
    postParams(fragmentId)
  }
  const postParams = (fragmentId: string) => {
    window.kadr.fragmentCaptureSync(fragmentId, {
      kadr: true, type: 'params', values: useFragmentParams.getState().live[fragmentId] ?? {}
    })
  }
  useFragmentParams.subscribe((st, prev) => {
    for (const id of active.keys()) if (st.live[id] !== prev.live[id]) postParams(id)
  })

  // One pass at a time. Passes used to overlap (a store change and the
  // 400 ms ticker both start one), and a pass that had already marked a
  // fragment as active could still be awaiting the dev server when the next
  // one decided it was no longer wanted: that one "stopped" a window main had
  // not created yet, and the first then created it anyway — a capture window
  // nobody tracked, rendering until the app quit.
  const reconcileOnce = async () => {
    const s = useEditor.getState()
    const want = wanted(s.project, s.playhead)
    for (const id of [...active.keys()]) {
      if (!want.has(id)) {
        active.delete(id)
        frames.delete(id)
        void window.kadr.fragmentCaptureStop(id)
      }
    }
    // windows already running first: a cold start below can take seconds
    for (const [id, { clip, track }] of want) if (active.has(id)) syncOne(id, clip, track)
    for (const [id, { clip }] of want) {
      if (active.has(id)) continue
      active.set(id, { clipId: clip.id })
      try {
        const url = await ensureFragmentServer()
        const [cw, ch] = captureSize(clip, s.project)
        await window.kadr.fragmentCaptureStart(
          id, `${url}/?comp=${encodeURIComponent(id)}`, cw, ch, clip.fragmentMeta?.fps ?? 60
        )
      } catch {
        active.delete(id)
        continue
      }
      // the world may have moved on while the window was starting
      const now = useEditor.getState()
      const still = wanted(now.project, now.playhead).get(id)
      if (!still) {
        active.delete(id)
        frames.delete(id)
        void window.kadr.fragmentCaptureStop(id)
        continue
      }
      syncOne(id, still.clip, still.track)
    }
  }
  let running: Promise<void> | null = null
  let again = false
  const reconcile = (): Promise<void> => {
    if (running) { again = true; return running }
    running = (async () => {
      try {
        do { again = false; await reconcileOnce() } while (again)
      } finally {
        running = null
      }
    })()
    return running
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
