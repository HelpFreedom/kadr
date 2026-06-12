import { useEffect, useRef } from 'react'
import { Player } from '@/engine/player'
import { useEditor, projectDuration } from '@/state/store'
import { AudioMeter } from './AudioMeter'
import { FragmentOverlays } from './FragmentOverlays'
import { FragmentGizmo } from './FragmentGizmo'

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
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
    return () => player.detach()
  }, [])

  return (
    <div className="preview">
      <div className="preview-canvas-wrap">
        <canvas ref={canvasRef} width={width} height={height} />
        <FragmentOverlays canvas={canvasRef} />
        <FragmentGizmo canvas={canvasRef} />
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
