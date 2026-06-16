import { useEffect, useRef, useState } from 'react'
import type { Clip, Track } from '@shared/types'
import { useEditor } from '@/state/store'
import { evalAnim } from '@/engine/anim'
import { fadeFactor } from '@/engine/player'
import { ensureFragmentServer, useFragmentServer } from '@/engine/fragments'
import { fragmentNeedsCapture } from '@/engine/fragmentCapture'

/**
 * Live Remotion fragments in the preview: each active 'remotion' clip gets
 * an iframe with the workspace Player page, positioned over the GL canvas
 * with the clip's transform and synced to the editor clock via postMessage.
 * No rendering happens — the dev server hot-reloads Claude's edits live.
 */
export function FragmentOverlays({ canvas }: { canvas: React.RefObject<HTMLCanvasElement | null> }) {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const url = useFragmentServer((s) => s.url)
  const error = useFragmentServer((s) => s.error)
  const [rect, setRect] = useState<{ left: number; top: number; w: number; h: number } | null>(null)

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
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    ro.observe(el.parentElement!)
    return () => ro.disconnect()
  }, [canvas, anyFragments])

  if (!anyFragments) return null

  // keep iframes mounted a bit around the clip so entry is seamless;
  // clips that need GL features render through pixel capture instead
  const near: { clip: Clip; track: Track }[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'remotion' || !clip.fragmentId) continue
      if (fragmentNeedsCapture(track, clip)) continue
      if (playhead >= clip.start - 1.5 && playhead < clip.start + clip.duration + 0.5) {
        near.push({ clip, track })
      }
    }
  }

  return (
    <>
      {error && <div className="frag-error">Remotion: {error}</div>}
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
    const timer = setInterval(post, 250)
    const onReady = (e: MessageEvent) => {
      if (e.data?.kadr && e.data.type === 'ready') post()
    }
    window.addEventListener('message', onReady)
    return () => {
      clearInterval(timer)
      window.removeEventListener('message', onReady)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, clip.start, clip.duration, clip.inPoint, clip.speed, playing, playhead, track.muted, track.gain])

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
