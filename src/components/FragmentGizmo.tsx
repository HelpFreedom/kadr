import { useEffect, useRef, useState } from 'react'
import { useEditor } from '@/state/store'
import { evalAnim } from '@/engine/anim'

/**
 * Mouse control for the selected remotion clip in the preview: drag the
 * dashed box to move it, drag the corner handle or scroll the wheel to
 * scale. Writes through clip.transform — works in both the iframe overlay
 * and the pixel-capture mode, and matches the final render exactly.
 */
export function FragmentGizmo({ canvas }: { canvas: React.RefObject<HTMLCanvasElement> }) {
  const selId = useEditor((s) => s.selection[0])
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const [rect, setRect] = useState<{ left: number; top: number; w: number; h: number } | null>(null)
  const gesture = useRef<{
    kind: 'move' | 'scale'
    x0: number
    y0: number
    baseX: number
    baseY: number
    baseScale: number
    pushed: boolean
  } | null>(null)

  const found = (() => {
    if (!selId) return null
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === selId)
      if (clip) return clip.kind === 'remotion' ? clip : null
    }
    return null
  })()
  const active = !!found && playhead >= found.start - 1e-9 && playhead < found.start + found.duration

  useEffect(() => {
    const el = canvas.current
    if (!el || !active) return
    const measure = () => {
      const c = el.getBoundingClientRect()
      const p = el.parentElement!.getBoundingClientRect()
      setRect({ left: c.left - p.left, top: c.top - p.top, w: c.width, h: c.height })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [canvas, active])

  if (!found || !active || !rect) return null
  const clip = found

  const disp = rect.w / Math.max(1, project.width)
  const rel = Math.max(0, Math.min(clip.duration, playhead - clip.start))
  const fw = clip.fragmentMeta?.width ?? project.width
  const fh = clip.fragmentMeta?.height ?? project.height
  const fit = Math.min(project.width / fw, project.height / fh)
  const scaleAnim = evalAnim(clip.transform.scale, rel)
  const scale = scaleAnim * fit * disp
  const x = evalAnim(clip.transform.x, rel) * disp
  const y = evalAnim(clip.transform.y, rel) * disp
  const boxW = fw * scale
  const boxH = fh * scale
  const left = rect.left + rect.w / 2 + x - boxW / 2
  const top = rect.top + rect.h / 2 + y - boxH / 2

  const st = () => useEditor.getState()
  const writeTransform = (px: number, py: number, ps: number) => {
    const c = st().project.tracks.flatMap((t) => t.clips).find((cc) => cc.id === clip.id)
    if (!c) return
    st().updateClip(c.id, {
      transform: {
        ...c.transform,
        x: { ...c.transform.x, value: px },
        y: { ...c.transform.y, value: py },
        scale: { ...c.transform.scale, value: ps }
      }
    })
  }

  const begin = (kind: 'move' | 'scale') => (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    gesture.current = {
      kind,
      x0: e.clientX,
      y0: e.clientY,
      baseX: clip.transform.x.value,
      baseY: clip.transform.y.value,
      baseScale: clip.transform.scale.value,
      pushed: false
    }
  }
  const onMove = (e: React.PointerEvent) => {
    const g = gesture.current
    if (!g) return
    if (!g.pushed) {
      st().pushHistory('hEdit')
      g.pushed = true
    }
    const dx = (e.clientX - g.x0) / disp
    const dy = (e.clientY - g.y0) / disp
    if (g.kind === 'move') {
      writeTransform(g.baseX + dx, g.baseY + dy, g.baseScale)
    } else {
      // corner drag: scale around the center, keep proportions
      const grow = 1 + (e.clientX - g.x0 + (e.clientY - g.y0)) / 300
      writeTransform(g.baseX, g.baseY, Math.min(20, Math.max(0.05, g.baseScale * grow)))
    }
  }
  const onUp = () => {
    gesture.current = null
  }
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault()
    st().pushHistory('hEdit')
    const c = st().project.tracks.flatMap((t) => t.clips).find((cc) => cc.id === clip.id)
    if (!c) return
    const factor = Math.pow(1.05, -e.deltaY / 100)
    writeTransform(
      c.transform.x.value,
      c.transform.y.value,
      Math.min(20, Math.max(0.05, c.transform.scale.value * factor))
    )
  }

  return (
    <div
      className="frag-gizmo"
      style={{ left, top, width: boxW, height: boxH }}
      onPointerDown={begin('move')}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onWheel={onWheel}
      title="Перетащите — позиция · колесо/уголок — размер"
    >
      <div
        className="frag-gizmo-handle"
        onPointerDown={begin('scale')}
        onPointerMove={onMove}
        onPointerUp={onUp}
      />
    </div>
  )
}
