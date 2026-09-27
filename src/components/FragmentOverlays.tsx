import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Clip, Project, Track } from '@shared/types'
import { useEditor } from '@/state/store'
import { evalAnim } from '@/engine/anim'
import { fadeFactor } from '@/engine/player'
import { ensureFragmentServer, useFragmentServer } from '@/engine/fragments'
import { fragmentNeedsCapture, fragmentFrameAt } from '@/engine/fragmentCapture'
import { usePopout } from '@/engine/popout'
import { useFragmentParams } from '@/engine/fragmentParams'
import { Icon } from './icons'

/**
 * Live Remotion fragments in the preview: each active 'remotion' clip gets
 * an iframe with the workspace Player page, positioned over the GL canvas
 * with the clip's transform and synced to the editor clock via postMessage.
 * No rendering happens — the dev server hot-reloads Claude's edits live.
 */
export function FragmentOverlays({ canvas }: { canvas: React.RefObject<HTMLCanvasElement> }) {
  const project = useEditor((s) => s.project)
  const url = useFragmentServer((s) => s.url)
  const error = useFragmentServer((s) => s.error)
  const [rect, setRect] = useState<{ left: number; top: number; w: number; h: number } | null>(null)
  // the preview may be detached into a window of its own — see the observer below
  const popped = usePopout((s) => s.win)

  // fragments present anywhere in the project → make sure the server runs
  const anyFragments = project.tracks.some((t) => t.clips.some((c) => c.kind === 'remotion'))
  useEffect(() => {
    if (anyFragments) void ensureFragmentServer().catch(() => { /* shown below */ })
  }, [anyFragments])

  // track the canvas's displayed rect relative to our positioned parent
  useEffect(() => {
    const el = canvas.current
    if (!el || !anyFragments) return
    const measure = () => {
      const c = el.getBoundingClientRect()
      const p = el.parentElement!.getBoundingClientRect()
      setRect({ left: c.left - p.left, top: c.top - p.top, w: c.width, h: c.height })
    }
    measure()
    // The observer must be created in the window the canvas is in: once the
    // preview is detached (engine/popout.ts) these elements live in another
    // document, and an observer left behind in the editor's can never deliver
    // for them — Chromium reports that as «ResizeObserver loop completed with
    // undelivered notifications». `popped` in the deps rebuilds it there.
    // Measuring is deferred a frame as well (the timeline's observer has
    // always done that), so it can never start a layout pass inside the call.
    const win = el.ownerDocument.defaultView ?? window
    let raf = 0
    const ro = new win.ResizeObserver(() => {
      win.cancelAnimationFrame(raf)
      raf = win.requestAnimationFrame(measure)
    })
    ro.observe(el)
    ro.observe(el.parentElement!)
    return () => {
      try { win.cancelAnimationFrame(raf) } catch { /* window gone */ }
      ro.disconnect()
    }
  }, [canvas, anyFragments, popped])

  // Which clips have an iframe is a function of the playhead, but only its
  // CHANGES matter: selecting a string key re-renders this component when an
  // iframe comes or goes, not on every frame of playback (the frames
  // themselves follow the clock through a store subscription, below).
  const nearKey = useEditor((s) => nearClips(s.project, s.playhead).map((n) => `${n.key}:${n.clip.id}`).join(','))
  if (!anyFragments) return null
  // keep iframes mounted a bit around the clip so entry is seamless;
  // clips that need GL features render through pixel capture instead
  const near = nearKey ? nearClips(project, useEditor.getState().playhead) : []

  return (
    <>
      {error && (
        <div className="frag-error">
          <Icon name="alert" size={14} /><span>Remotion: {error}</span>
        </div>
      )}
      {url && rect && near.length > 0 && (
        <div
          className="frag-clipbox"
          style={{ left: rect.left, top: rect.top, width: rect.w, height: rect.h }}
        >
          {near.map(({ clip, track, key }) => (
            <FragmentFrame key={key} clip={clip} track={track} url={url} rect={rect} />
          ))}
        </div>
      )}
    </>
  )
}

/** Fragment clips shown as iframes around time t — BOTTOM track first: DOM
    order is stacking order, and tracks[0] is the top one (iterating it first
    put a background fragment over the title above it).

    Clips that CONTINUE one another — same fragment, same track, butt-joined,
    the second starting in the source exactly where the first ends, same
    speed — share one iframe (keyed by the first clip of the run): a long
    composition cut into clips ("one film, many windows") then plays across
    its cuts without a page load or even a seek. The entry carries the clip
    that is on screen, or else the next one. Anything else keeps an iframe of
    its own, preloaded before its cut. */
function nearClips(project: Project, t: number): { clip: Clip; track: Track; key: string }[] {
  const near: { clip: Clip; track: Track; key: string }[] = []
  for (const track of [...project.tracks].reverse()) {
    if (track.kind !== 'video' || track.muted) continue
    const clips = track.clips
      .filter((c) => c.kind === 'remotion' && c.fragmentId && !fragmentNeedsCapture(track, c, project))
      .sort((a, b) => a.start - b.start)
    let run: Clip[] = []
    const flush = () => {
      if (!run.length) return
      const first = run[0], last = run[run.length - 1]
      if (t >= first.start - 1.5 && t < last.start + last.duration + 0.5) {
        const clip = run.find((c) => t < c.start + c.duration) ?? last
        near.push({ clip, track, key: first.id })
      }
      run = []
    }
    for (const c of clips) {
      const p = run[run.length - 1]
      if (p && !continues(p, c)) flush()
      run.push(c)
    }
    flush()
  }
  return near
}

/** b picks up where a stops: same fragment and speed, butt-joined on the
    timeline, and b's source starts where a's ends (within half a frame). */
function continues(a: Clip, b: Clip): boolean {
  if (a.fragmentId !== b.fragmentId || (a.speed || 1) !== (b.speed || 1)) return false
  const tol = 0.5 / (a.fragmentMeta?.fps ?? 60)
  return Math.abs(a.start + a.duration - b.start) <= tol &&
    Math.abs(a.inPoint + a.duration * (a.speed || 1) - b.inPoint) <= tol
}

type Rect = { left: number; top: number; w: number; h: number }

/** A page waiting for its cut is not quite transparent: at exactly 0 the
    compositor stops producing its frames, and bringing it back cost ~100 ms
    of nothing right after every cut (measured). 0.001 of any colour is under
    half a level of 8-bit output — nothing reaches the screen. */
const PARKED_OPACITY = 0.001

// One renderer PROCESS per iframe. Every fragment page used to come from
// 127.0.0.1 — one site, so Chromium put all of them into one process — and
// the page booting for the next cut (modules, geometry, shader compiles:
// seconds on a heavy 3D fragment) blocked the main thread of the one on
// screen: measured 0.4–0.55 s freezes right before every cut. Chromium
// resolves any *.localhost name to the loopback address itself, and each
// f<N>.localhost is a site of its own, hence a process of its own. The slot
// is the lowest one free, so the page coming in and the page going out are
// never on the same one. The dev server listens on 127.0.0.1 only, as
// before; pixel-capture windows are separate processes anyway.
// A slot is reserved while rendering and CLAIMED by the mounted iframe's
// effect; React may run a state initializer twice and keep one result (dev
// StrictMode does), so an unclaimed reservation lapses after a moment.
const slotsInUse = new Set<number>()
function acquireSlot(): number {
  let n = 0
  while (slotsInUse.has(n)) n++
  slotsInUse.add(n)
  setTimeout(() => { if (!mounted.has(n)) slotsInUse.delete(n) }, 2000)
  return n
}
const mounted = new Set<number>()
function claimSlot(n: number) {
  slotsInUse.add(n)
  mounted.add(n)
}
function releaseSlot(n: number) {
  mounted.delete(n)
  slotsInUse.delete(n)
}
function slotOrigin(url: string, slot: number): string {
  try {
    const u = new URL(url)
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') return url
    u.hostname = `f${slot}.localhost`
    return u.origin
  } catch {
    return url
  }
}

/** The iframe's box at time t: the GL layer geometry — fit into the project
    frame, then the clip transform (x/y/scale/rotation/opacity) — in display
    pixels, relative to the clip box that hugs the canvas. */
function frameLayout(clip: Clip, track: Track, rect: Rect, project: Project, t: number) {
  const meta = clip.fragmentMeta
  const rel = t - clip.start
  const active = rel >= 0 && rel < clip.duration
  const disp = rect.w / Math.max(1, project.width)
  const fw = meta?.width ?? project.width
  const fh = meta?.height ?? project.height
  const fit = Math.min(project.width / fw, project.height / fh)
  const r2 = Math.max(0, Math.min(clip.duration, rel))
  const scale = evalAnim(clip.transform.scale, r2) * fit * disp
  const x = evalAnim(clip.transform.x, r2) * disp
  const y = evalAnim(clip.transform.y, r2) * disp
  const rot = evalAnim(clip.transform.rotation, r2)
  const opacity = active
    ? evalAnim(clip.transform.opacity, r2) * fadeFactor(clip, r2) * Math.min(1, track.gain)
    : 0
  return {
    left: rect.w / 2 + x - (fw * scale) / 2,
    top: rect.h / 2 + y - (fh * scale) / 2,
    width: fw * scale,
    height: fh * scale,
    rot,
    opacity,
    /** displayed size ÷ composition size — the page renders 3D at this */
    scale
  }
}

function FragmentFrame({
  clip, track, url, rect
}: {
  clip: Clip
  track: Track
  url: string
  rect: Rect
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  // which window this iframe is in — the preview may be detached into its own
  const popped = usePopout((s) => s.win)
  const fps = clip.fragmentMeta?.fps ?? 60
  // Its own renderer process: see acquireSlot. Held for the iframe's life —
  // a new src would reload the page.
  const [slot] = useState(acquireSlot)
  useEffect(() => { claimSlot(slot); return () => releaseSlot(slot) }, [slot])
  // the display scale at mount goes into the URL (the page sizes its 3D
  // from the first frame); later changes travel by message
  const [src] = useState(() => {
    const l = frameLayout(clip, track, rect, useEditor.getState().project, useEditor.getState().playhead)
    return `${slotOrigin(url, slot)}/?comp=${encodeURIComponent(clip.fragmentId!)}&scale=${Math.min(1, l.scale).toFixed(3)}`
  })

  // Clock and geometry follow the store directly, NOT through React: a
  // re-render of every iframe on every frame of playback was the old way.
  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    let sentScale = Number(new URL(src).searchParams.get('scale')) || 1
    const post = (msg: object) => el.contentWindow?.postMessage({ kadr: true, ...msg }, '*')
    const sync = () => {
      const st = useEditor.getState()
      const r = st.playhead - clip.start
      const inside = r >= 0 && r < clip.duration
      const vol = clip.muted || track.muted || !inside
        ? 0
        : Math.min(1, evalAnim(clip.gain, r) * track.gain * fadeFactor(clip, r))
      post({
        type: 'sync',
        frame: fragmentFrameAt(clip, r),
        playing: st.playing && inside,
        volume: vol
      })
    }
    const place = () => {
      const st = useEditor.getState()
      const l = frameLayout(clip, track, rect, st.project, st.playhead)
      const s = el.style
      s.left = `${l.left}px`
      s.top = `${l.top}px`
      s.width = `${l.width}px`
      s.height = `${l.height}px`
      s.transform = l.rot ? `rotate(${l.rot}deg)` : ''
      s.opacity = String(Math.max(PARKED_OPACITY, l.opacity))
      // Hidden by opacity ONLY. With visibility:hidden the page parked for the
      // next cut had to bring its surface back when the cut came, and nothing
      // drew for ~250 ms right after every cut (measured; the same play start
      // from an already visible page: worst frame 35 ms). A parked page draws
      // nothing anyway — its 3D renders on demand (src/_kadr/three-preview).
      // a resize worth re-rendering for (never on tiny wobble: a canvas
      // resize is a reallocation, and some post-processing chains size
      // their buffers once)
      const want = Math.min(1, l.scale)
      if (Math.abs(want - sentScale) > 0.25 * sentScale) {
        sentScale = want
        post({ type: 'view', scale: want })
      }
    }
    place()
    sync()
    const unsub = useEditor.subscribe((st, prev) => {
      if (st.playhead !== prev.playhead || st.playing !== prev.playing || st.project !== prev.project) {
        place()
        sync()
      }
    })
    // Both the ticker and the handshake belong to the window this iframe is
    // in. Detached into its own window (engine/popout.ts) the player page's
    // 'ready' reaches ITS parent — the popup — not the editor, and a timer
    // owned by a minimised editor window is throttled to about 1 Hz. Hence
    // `popped` in the deps as well: they are rebuilt where the iframe is.
    const win = el.ownerDocument.defaultView ?? window
    const timer = win.setInterval(sync, 250) // a paused page that missed a message
    // parameters being dragged in the Inspector (engine/fragmentParams.ts)
    const fid = clip.fragmentId!
    const postParams = () => post({ type: 'params', values: useFragmentParams.getState().live[fid] ?? {} })
    const unsubParams = useFragmentParams.subscribe((st, prev) => {
      if (st.live[fid] !== prev.live[fid]) postParams()
    })
    const onReady = (e: MessageEvent) => {
      if (e.data?.kadr && e.data.type === 'ready' && e.source === el.contentWindow) {
        sync()
        post({ type: 'view', scale: sentScale })
        postParams()
      }
    }
    win.addEventListener('message', onReady)
    return () => {
      unsub()
      unsubParams()
      win.clearInterval(timer)
      win.removeEventListener('message', onReady)
    }
  }, [clip, track, rect, fps, src, popped])

  return (
    <iframe
      ref={frame}
      className="frag-frame"
      title={clip.label ?? clip.fragmentId}
      src={src}
    />
  )
}
