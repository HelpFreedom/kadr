import { useEffect, useRef, useState } from 'react'
import { useEditor } from '@/state/store'
import { evalAnim } from '@/engine/anim'
import { measureTextContent } from '@/engine/previewHitTest'
import { rebaseAnim } from './animUtils'
import type { Clip, MediaAsset } from '@shared/types'

/**
 * Mouse control for every visible layer in the preview. Native text/images,
 * media and Remotion fragments all write through the same clip.transform.
 */
export function FragmentGizmo({
  canvas,
  onPick
}: {
  canvas: React.RefObject<HTMLCanvasElement>
  onPick?: (clientX: number, clientY: number) => void
}) {
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

  const found: { clip: Clip; asset?: MediaAsset } | null = (() => {
    if (!selId) return null
    for (const track of project.tracks) {
      const clip = track.clips.find((c) => c.id === selId)
      if (!clip || track.kind !== 'video') continue
      const asset = clip.assetId ? project.assets.find((a) => a.id === clip.assetId) : undefined
      if (clip.kind === 'media' && (!asset || asset.kind === 'audio')) return null
      return { clip, asset }
    }
    return null
  })()
  const active = !!found && playhead >= found.clip.start - 1e-9 &&
    playhead < found.clip.start + found.clip.duration

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
  const { clip, asset } = found

  const disp = rect.w / Math.max(1, project.width)
  const rel = Math.max(0, Math.min(clip.duration, playhead - clip.start))
  const scaleAnim = evalAnim(clip.transform.scale, rel)
  const sourceW = clip.kind === 'remotion'
    ? clip.fragmentMeta?.width ?? project.width
    : clip.kind === 'media'
      ? asset?.width ?? project.width
      : project.width
  const sourceH = clip.kind === 'remotion'
    ? clip.fragmentMeta?.height ?? project.height
    : clip.kind === 'media'
      ? asset?.height ?? project.height
      : project.height
  const fit = clip.kind === 'text'
    ? 1
    : Math.min(project.width / Math.max(1, sourceW), project.height / Math.max(1, sourceH))
  const scale = scaleAnim * fit * disp
  const x = evalAnim(clip.transform.x, rel) * disp
  const y = evalAnim(clip.transform.y, rel) * disp
  let contentW = sourceW
  let contentH = sourceH
  let contentOffsetX = 0
  if (clip.kind === 'text' && clip.textStyle) {
    const bounds = measureTextContent(clip.text ?? '', clip.textStyle, project.width)
    contentW = bounds.width
    contentH = bounds.height
    contentOffsetX = bounds.centerX - project.width / 2
  }
  const boxW = Math.max(28, contentW * scale)
  const boxH = Math.max(22, contentH * scale)
  const left = rect.left + rect.w / 2 + x + contentOffsetX * scale - boxW / 2
  const top = rect.top + rect.h / 2 + y - boxH / 2

  const st = () => useEditor.getState()
  const writeTransform = (px: number, py: number, ps: number) => {
    const c = st().project.tracks.flatMap((t) => t.clips).find((cc) => cc.id === clip.id)
    if (!c) return
    st().updateClip(c.id, {
      transform: {
        ...c.transform,
        x: rebaseAnim(c.transform.x, px, 'offset'),
        y: rebaseAnim(c.transform.y, py, 'offset'),
        scale: rebaseAnim(c.transform.scale, ps, 'ratio')
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
  const onUp = (e: React.PointerEvent) => {
    const g = gesture.current
    gesture.current = null
    if (g?.kind === 'move' && !g.pushed) onPick?.(e.clientX, e.clientY)
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
      className={`frag-gizmo ${clip.kind}`}
      style={{ left, top, width: boxW, height: boxH }}
      onPointerDown={begin('move')}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onWheel={onWheel}
      title="Перетащите — позиция · колесо или уголок — размер"
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
