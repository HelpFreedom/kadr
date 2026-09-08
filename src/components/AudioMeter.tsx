// Vertical frequency meter next to the preview: low bands at the bottom,
// green→yellow→red gradient by level, red border flash on clipping.
import { useEffect, useRef } from 'react'
import { getAnalyser } from '@/engine/audio'
import { token } from '@/theme'
import { useT } from '@/i18n'
import { usePopout } from '@/engine/popout'

const BANDS = 28

export function AudioMeter() {
  const t = useT()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // the preview (this canvas with it) may be detached into its own window
  const popped = usePopout((s) => s.win)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const analyser = getAnalyser()
    const freq = new Uint8Array(analyser.frequencyBinCount)
    const wave = new Uint8Array(analyser.fftSize)
    let raf = 0
    let clipUntil = 0

    // like the Player's clock, the loop runs in whatever window the canvas
    // currently sits in: detached into its own window (engine/popout.ts) the
    // meter would otherwise freeze whenever the editor window is minimised
    const view = () => canvas.ownerDocument.defaultView ?? window
    const draw = () => {
      raf = view().requestAnimationFrame(draw)
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

      ctx.fillStyle = token('--c-meter-bg', '#080a0e')
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
        ctx.strokeStyle = token('--c-clip-warn', '#ff3030')
        ctx.lineWidth = 4
        ctx.strokeRect(0, 0, W, H)
        ctx.fillStyle = token('--c-clip-warn', '#ff3030')
        ctx.fillRect(0, 0, W, 4)
      }
    }
    draw()

    // The backing store follows the element's own window: detached, the meter
    // may well sit on a monitor with a different device pixel ratio.
    const win = view()
    let fitRaf = 0
    const fit = () => {
      const dpr = win.devicePixelRatio || 1
      const w = Math.round(canvas.clientWidth * dpr)
      const h = Math.round(canvas.clientHeight * dpr)
      // writing width/height clears the canvas, so only when it really changed
      if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w
        canvas.height = h
      }
    }
    fit()
    // The OBSERVER has to belong to the window the canvas is in. Once the
    // preview is detached (engine/popout.ts) this element lives in another
    // document, and an observer left behind in the editor's can never deliver
    // for it — Chromium reports exactly that, once per move, as «ResizeObserver
    // loop completed with undelivered notifications». Hence `popped` in the
    // deps: the observer is rebuilt in the right window on every move.
    // The work is also deferred a frame (as .tl-scroll's has always been), so
    // a resize can never start another layout pass inside the callback.
    const ro = new win.ResizeObserver(() => {
      win.cancelAnimationFrame(fitRaf)
      fitRaf = win.requestAnimationFrame(fit)
    })
    ro.observe(canvas)
    return () => {
      try { view().cancelAnimationFrame(raf) } catch { /* window gone */ }
      try { win.cancelAnimationFrame(fitRaf) } catch { /* window gone */ }
      ro.disconnect()
    }
  }, [popped])

  return <canvas ref={canvasRef} className="audio-meter" title={t('meterTitle')} />
}
