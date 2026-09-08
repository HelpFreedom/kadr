// Render-done chime: a short, gentle two-note signal when an export
// finishes, loud enough to hear from across the room. WebAudio only — no
// asset files; Electron's autoplay policy allows it without a gesture.
export function playDoneChime() {
  try {
    const ctx = new AudioContext()
    const t0 = ctx.currentTime + 0.02
    const note = (freq: number, at: number, dur: number, peak: number) => {
      const osc = ctx.createOscillator()
      const gain = ctx.createGain()
      osc.type = 'sine'
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0, at)
      gain.gain.linearRampToValueAtTime(peak, at + 0.02)
      gain.gain.exponentialRampToValueAtTime(0.001, at + dur)
      osc.connect(gain).connect(ctx.destination)
      osc.start(at)
      osc.stop(at + dur + 0.05)
    }
    note(660, t0, 0.45, 0.22)
    note(880, t0 + 0.18, 0.7, 0.22)
    setTimeout(() => void ctx.close(), 1600)
    ;(window as unknown as { __kadrChimeAt?: number }).__kadrChimeAt = Date.now()
  } catch { /* audio device busy/absent — silence is fine */ }
}

/** Chime once per finished export — UI dialog and MCP exports alike. */
export function wireExportChime() {
  window.kadr.onExportProgress((p) => {
    if (p.phase === 'done') playDoneChime()
  })
}
