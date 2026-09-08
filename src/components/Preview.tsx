import { useEffect, useRef } from 'react'
import { Player } from '@/engine/player'
import { registerPreviewCanvas } from '@/engine/snapshot'
import { usePopout } from '@/engine/popout'
import { useT } from '@/i18n'
import { useEditor, projectDuration } from '@/state/store'
import { AudioMeter } from './AudioMeter'
import { FragmentOverlays } from './FragmentOverlays'
import { FragmentGizmo } from './FragmentGizmo'

export function Preview() {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const playerRef = useRef<Player | null>(null)
  const popped = usePopout((s) => s.win)
  const width = useEditor((s) => s.project.width)
  const height = useEditor((s) => s.project.height)
  const loading = useEditor((s) => s.previewLoading)
  const gpuLost = useEditor((s) => s.previewGpuLost)

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
      setGpuLost: (lost) => useEditor.getState().setPreviewGpuLost(lost),
      duration: () => projectDuration(useEditor.getState().project)
    })
    player.attach(canvas)
    playerRef.current = player
    registerPreviewCanvas(canvas, player)
    return () => {
      registerPreviewCanvas(null, null)
      playerRef.current = null
      player.detach()
    }
  }, [])

  // detaching the preview moves this canvas into another window; the clock
  // has to be re-scheduled there at once instead of waiting for the old
  // window's next (possibly throttled) frame
  useEffect(() => {
    playerRef.current?.kick()
  }, [popped])

  return (
    <div className="preview">
      <div className="preview-canvas-wrap">
        <canvas ref={canvasRef} width={width} height={height} />
        <FragmentOverlays canvas={canvasRef} />
        <FragmentGizmo canvas={canvasRef} />
        {loading && !gpuLost && (
          <div className="preview-loading">
            <div className="spinner" />
          </div>
        )}
        {gpuLost && <div className="preview-gpu-lost">{t('gpuLost')}</div>}
      </div>
      <AudioMeter />
    </div>
  )
}
