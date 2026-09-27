// The onion skin over the preview (engine/onion.ts): one <video> of the chosen
// clip, fitted into the frame, translucent or in difference mode, above the
// canvas AND the fragment iframes. It never takes the mouse — the fragment
// gizmo under it has to keep working, that is what the alignment is done with.
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useEditor } from '@/state/store'
import { usePopout } from '@/engine/popout'
import { useOnion, onionFrame } from '@/engine/onion'

export function OnionSkin({ canvas }: { canvas: React.RefObject<HTMLCanvasElement> }) {
  const on = useOnion((s) => s.on)
  const clipId = useOnion((s) => s.clipId)
  const opacity = useOnion((s) => s.opacity)
  const diff = useOnion((s) => s.diff)
  const popped = usePopout((s) => s.win)
  const video = useRef<HTMLVideoElement>(null)
  const [rect, setRect] = useState<{ left: number; top: number; w: number; h: number } | null>(null)
  // the file to show: the preview's own choice — the proxy when there is one
  // (it is upright, SDR and always decodable), else the original
  const src = useEditor((s) => {
    const f = onionFrame(s.project, clipId, s.playhead)
    return f ? window.kadr.fileUrl(f.asset.proxyPath ?? f.asset.path) : null
  })

  // the canvas's displayed rect; the observer lives in the canvas's window
  // (the preview may be detached — see FragmentOverlays)
  useEffect(() => {
    const el = canvas.current
    if (!el || !on) return
    const measure = () => {
      const c = el.getBoundingClientRect()
      const p = el.parentElement!.getBoundingClientRect()
      setRect({ left: c.left - p.left, top: c.top - p.top, w: c.width, h: c.height })
    }
    measure()
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
  }, [canvas, on, popped])

  const mounted = on && !!src && !!rect
  // the clock, through a store subscription (not a React render per frame)
  useLayoutEffect(() => {
    const el = video.current
    if (!el || !on || !src) return
    const sync = () => {
      const st = useEditor.getState()
      const f = onionFrame(st.project, useOnion.getState().clipId, st.playhead)
      if (!f || el.readyState < 1) return
      const inside = st.playhead >= f.clip.start && st.playhead < f.clip.start + f.clip.duration
      if (st.playing && inside) {
        // Chromium throws outside [0.0625, 16]; beyond it the resync below seeks
        el.playbackRate = Math.max(0.0625, Math.min(16, f.speed))
        if (el.paused) void el.play().catch(() => { /* a seek interrupted it: the next sync retries */ })
        if (!el.seeking && Math.abs(el.currentTime - f.time) > 0.2) el.currentTime = f.time + 0.08 * f.speed
      } else {
        if (!el.paused) el.pause()
        if (!el.seeking && Math.abs(el.currentTime - f.time) > 1 / 240) el.currentTime = f.time
      }
    }
    sync()
    el.addEventListener('loadedmetadata', sync)
    el.addEventListener('seeked', sync) // the playhead moved on while it was seeking
    const unsub = useEditor.subscribe((st, prev) => {
      if (st.playhead !== prev.playhead || st.playing !== prev.playing || st.project !== prev.project) sync()
    })
    const unsubOnion = useOnion.subscribe((s, p) => { if (s.clipId !== p.clipId) sync() })
    return () => {
      unsub()
      unsubOnion()
      el.removeEventListener('loadedmetadata', sync)
      el.removeEventListener('seeked', sync)
      el.pause()
    }
  }, [on, src, popped, mounted])

  if (!mounted) return null
  return (
    <video
      ref={video}
      className="onion-skin"
      data-onion={clipId ?? ''}
      src={src}
      crossOrigin="anonymous"
      muted
      playsInline
      preload="auto"
      style={{
        left: rect.left, top: rect.top, width: rect.w, height: rect.h,
        opacity, mixBlendMode: diff ? 'difference' : 'normal'
      }}
    />
  )
}
