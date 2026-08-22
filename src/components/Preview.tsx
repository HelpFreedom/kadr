import { useCallback, useEffect, useRef } from 'react'
import { Player } from '@/engine/player'
import { previewHitsAt } from '@/engine/previewHitTest'
import { registerPreviewCanvas } from '@/engine/snapshot'
import { useEditor, projectDuration } from '@/state/store'
import { AudioMeter } from './AudioMeter'
import { FragmentOverlays } from './FragmentOverlays'
import { FragmentGizmo } from './FragmentGizmo'

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const clickCycle = useRef<{
    x: number
    y: number
    ids: string[]
    index: number
    time: number
  } | null>(null)
  const width = useEditor((s) => s.project.width)
  const height = useEditor((s) => s.project.height)
  const loading = useEditor((s) => s.previewLoading)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const player = new Player({
      getState: () => {
        const s = useEditor.getState()
        return { project: s.project, playhead: s.playhead, playing: s.playing }
      },
      setPlayhead: (t) => useEditor.getState().setPlayhead(t),
      setPlaying: (p) => useEditor.getState().setPlaying(p),
      setLoading: (l) => useEditor.getState().setPreviewLoading(l),
      duration: () => projectDuration(useEditor.getState().project)
    })
    player.attach(canvas)
    registerPreviewCanvas(canvas, player)
    return () => {
      registerPreviewCanvas(null, null)
      player.detach()
    }
  }, [])

  const selectAt = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    if (!rect.width || !rect.height) return
    const st = useEditor.getState()
    const x = (clientX - rect.left) * st.project.width / rect.width
    const y = (clientY - rect.top) * st.project.height / rect.height
    const hits = previewHitsAt(st.project, st.playhead, x, y)
    if (!hits.length) {
      clickCycle.current = null
      st.select([])
      return
    }

    const ids = hits.map((clip) => clip.id)
    const previous = clickCycle.current
    const now = performance.now()
    const samePoint = previous && Math.hypot(previous.x - x, previous.y - y) < 8
    const sameStack = previous && previous.ids.length === ids.length &&
      previous.ids.every((id, i) => id === ids[i])
    const sameSelection = previous && st.selection[0] === previous.ids[previous.index]
    const index = previous && samePoint && sameStack && sameSelection && now - previous.time < 1400
      ? (previous.index + 1) % ids.length
      : 0
    clickCycle.current = { x, y, ids, index, time: now }
    st.select([ids[index]])
  }, [])

  return (
    <div className="preview">
      <div className="preview-canvas-wrap">
        <canvas
          ref={canvasRef}
          width={width}
          height={height}
          onPointerDown={(e) => {
            if (e.button === 0) selectAt(e.clientX, e.clientY)
          }}
        />
        <FragmentOverlays canvas={canvasRef} />
        <FragmentGizmo canvas={canvasRef} onPick={selectAt} />
        {loading && (
          <div className="preview-loading">
            <div className="spinner" />
          </div>
        )}
      </div>
      <AudioMeter />
    </div>
  )
}
