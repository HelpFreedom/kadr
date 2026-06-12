// Vertical frequency meter next to the preview: low bands at the bottom,
// green→yellow→red gradient by level, red border flash on clipping.
import { useEffect, useRef } from 'react'
import { getAnalyser } from '@/engine/audio'

const BANDS = 28

export function AudioMeter() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const analyser = getAnalyser()
    const freq = new Uint8Array(analyser.frequencyBinCount)
    const wave = new Uint8Array(analyser.fftSize)
    let raf = 0
    let clipUntil = 0

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const ctx = canvas.getContext('2d')!
      const W = canvas.width
      const H = canvas.height
      analyser.getByteFrequencyData(freq)
      analyser.getByteTimeDomainData(wave)

      // overload detector: waveform samples touching the rails
      for (let i = 0; i < wave.length; i++) {
        if (wave[i] <= 1 || wave[i] >= 254) {
          clipUntil = performance.now() + 600
          break
        }
      }
      const clipping = performance.now() < clipUntil

      ctx.fillStyle = '#101216'
      ctx.fillRect(0, 0, W, H)

      const bandH = H / BANDS
      // log-ish frequency mapping so lows don't dominate the column
      for (let b = 0; b < BANDS; b++) {
        const f0 = Math.floor(Math.pow(freq.length, b / BANDS))
        const f1 = Math.max(f0 + 1, Math.floor(Math.pow(freq.length, (b + 1) / BANDS)))
        let m = 0
        for (let i = f0; i < f1 && i < freq.length; i++) m = Math.max(m, freq[i])
        const v = m / 255
        if (v <= 0.004) continue
        const y = H - (b + 1) * bandH
        const hue = 120 - 120 * v // green → red
        ctx.fillStyle = `hsl(${hue}, 90%, ${40 + v * 20}%)`
        ctx.fillRect(1, y + 1, Math.max(1, (W - 2) * v), Math.max(1, bandH - 2))
      }

      if (clipping) {
        ctx.strokeStyle = '#ff3030'
        ctx.lineWidth = 4
        ctx.strokeRect(0, 0, W, H)
        ctx.fillStyle = '#ff3030'
        ctx.fillRect(0, 0, W, 4)
      }
    }
    draw()

    const ro = new ResizeObserver(() => {
      canvas.width = canvas.clientWidth * (window.devicePixelRatio || 1)
      canvas.height = canvas.clientHeight * (window.devicePixelRatio || 1)
    })
    ro.observe(canvas)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [])

  return <canvas ref={canvasRef} className="audio-meter" title="Audio spectrum / overload" />
}
