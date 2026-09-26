import { useEffect, useRef, useState } from 'react'
import type { Clip, Track } from '@shared/types'
import { useEditor } from '@/state/store'
import { evalAnim } from '@/engine/anim'
import { fadeFactor } from '@/engine/player'
import { ensureFragmentServer, useFragmentServer } from '@/engine/fragments'
import { fragmentNeedsCapture } from '@/engine/fragmentCapture'
import { usePopout } from '@/engine/popout'
import { Icon } from './icons'

/**
 * Live Remotion fragments in the preview: each active 'remotion' clip gets
 * an iframe with the workspace Player page, positioned over the GL canvas
 * with the clip's transform and synced to the editor clock via postMessage.
 * No rendering happens — the dev server hot-reloads Claude's edits live.
 */
export function FragmentOverlays({ canvas }: { canvas: React.RefObject<HTMLCanvasElement> }) {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
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

  if (!anyFragments) return null

  // keep iframes mounted a bit around the clip so entry is seamless;
  // clips that need GL features render through pixel capture instead
  // BOTTOM track first: DOM order is stacking order, and tracks[0] is the top
  // one — iterating it first put a background fragment over the title above it
  const near: { clip: Clip; track: Track }[] = []
  for (const track of [...project.tracks].reverse()) {
    if (track.kind !== 'video' || track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'remotion' || !clip.fragmentId) continue
      if (fragmentNeedsCapture(track, clip, project)) continue
      if (playhead >= clip.start - 1.5 && playhead < clip.start + clip.duration + 0.5) {
        near.push({ clip, track })
      }
    }
  }

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
          {near.map(({ clip, track }) => (
            <FragmentFrame key={clip.id} clip={clip} track={track} url={url} rect={rect} />
          ))}
        </div>
      )}
    </>
  )
}

function FragmentFrame({
  clip, track, url, rect
}: {
  clip: Clip
  track: Track
  url: string
  rect: { left: number; top: number; w: number; h: number }
}) {
  const frame = useRef<HTMLIFrameElement>(null)
  // which window this iframe is in — the preview may be detached into its own
  const popped = usePopout((s) => s.win)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const meta = clip.fragmentMeta
  const fps = meta?.fps ?? 60

  const rel = playhead - clip.start
  const active = rel >= 0 && rel < clip.duration

  // sync the embedded player to the editor clock
  useEffect(() => {
    const post = () => {
      const w = frame.current?.contentWindow
      if (!w) return
      const r = useEditor.getState().playhead - clip.start
      const inside = r >= 0 && r < clip.duration
      const vol = clip.muted || track.muted || !inside
        ? 0
        : Math.min(1, evalAnim(clip.gain, r) * track.gain * fadeFactor(clip, r))
      w.postMessage({
        kadr: true,
        type: 'sync',
        frame: Math.max(0, Math.round((Math.max(0, Math.min(clip.duration, r)) * (clip.speed || 1) + clip.inPoint) * fps)),
        playing: useEditor.getState().playing && inside,
        volume: vol
      }, '*')
    }
    post()
    // Both the ticker and the handshake belong to the window this iframe is
    // in. Detached into its own window (engine/popout.ts) the player page's
    // 'ready' reaches ITS parent — the popup — not the editor, and a timer
    // owned by a minimised editor window is throttled to about 1 Hz. Hence
    // `popped` in the deps as well: they are rebuilt where the iframe is.
    const win = frame.current?.ownerDocument.defaultView ?? window
    const timer = win.setInterval(post, 250)
    const onReady = (e: MessageEvent) => {
      if (e.data?.kadr && e.data.type === 'ready') post()
    }
    win.addEventListener('message', onReady)
    return () => {
      win.clearInterval(timer)
      win.removeEventListener('message', onReady)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, clip.start, clip.duration, clip.inPoint, clip.speed, playing, playhead, track.muted, track.gain, popped])

  // replicate the GL layer geometry: fit into the project frame, then the
  // clip transform (x/y/scale/rotation/opacity) in display pixels
  const project = useEditor.getState().project
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

  return (
    <iframe
      ref={frame}
      className="frag-frame"
      title={clip.label ?? clip.fragmentId}
      src={`${url}/?comp=${encodeURIComponent(clip.fragmentId!)}`}
      style={{
        // coordinates are relative to the clip box that hugs the canvas
        left: rect.w / 2 + x - (fw * scale) / 2,
        top: rect.h / 2 + y - (fh * scale) / 2,
        width: fw * scale,
        height: fh * scale,
        transform: rot ? `rotate(${rot}deg)` : undefined,
        opacity,
        visibility: opacity > 0.001 ? 'visible' : 'hidden'
      }}
    />
  )
}
