// Vertical frequency meter next to the preview: low bands at the bottom,
// green→yellow→red gradient by level, red border flash on clipping.
import { useEffect, useRef, useState } from 'react'
import { getAnalyser } from '@/engine/audio'
import { useT } from '@/i18n'

const BANDS = 28
const SIGNAL_THRESHOLD = 2
const HIDE_AFTER_SILENCE_MS = 1200

export function AudioMeter() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [visible, setVisible] = useState(false)
  const t = useT()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const analyser = getAnalyser()
    const freq = new Uint8Array(analyser.frequencyBinCount)
    const wave = new Uint8Array(analyser.fftSize)
    let raf = 0
    let clipUntil = 0
    let lastSignalAt = 0
    let meterVisible = false

    const setMeterVisible = (next: boolean) => {
      if (meterVisible === next) return
      meterVisible = next
      setVisible(next)
    }

    const draw = () => {
      raf = requestAnimationFrame(draw)
      const ctx = canvas.getContext('2d')!
      const W = canvas.width
      const H = canvas.height
      analyser.getByteFrequencyData(freq)
      analyser.getByteTimeDomainData(wave)

      let peak = 0
      for (let i = 0; i < freq.length; i++) peak = Math.max(peak, freq[i])
      const now = performance.now()
      if (peak > SIGNAL_THRESHOLD) {
        lastSignalAt = now
        setMeterVisible(true)
      } else if (meterVisible && now - lastSignalAt > HIDE_AFTER_SILENCE_MS) {
        setMeterVisible(false)
      }

      // overload detector: waveform samples touching the rails
      for (let i = 0; i < wave.length; i++) {
        if (wave[i] <= 1 || wave[i] >= 254) {
          clipUntil = now + 600
          break
        }
      }
      const clipping = now < clipUntil

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

  return (
    <canvas
      ref={canvasRef}
      className={`audio-meter${visible ? '' : ' is-silent'}`}
      aria-hidden={!visible}
      title={t('audioMeterTitle')}
      aria-label={t('audioMeterTitle')}
    />
  )
}
