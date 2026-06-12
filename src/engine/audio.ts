// Shared WebAudio graph for the live preview: every media element is routed
// element → per-clip gain (allows >100% volume) → master → analyser → output.
let ctx: AudioContext | null = null
let master: GainNode | null = null
let analyser: AnalyserNode | null = null
const gains = new WeakMap<HTMLMediaElement, GainNode>()

export function ensureAudio(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext()
    master = ctx.createGain()
    analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    analyser.smoothingTimeConstant = 0.75
    master.connect(analyser)
    analyser.connect(ctx.destination)
  }
  return ctx
}

export function resumeAudio() {
  const c = ensureAudio()
  if (c.state === 'suspended') c.resume().catch(() => { /* needs a gesture */ })
}

/** Route an element through the graph (idempotent). */
export function attachAudio(el: HTMLMediaElement) {
  const c = ensureAudio()
  if (gains.has(el)) return
  try {
    const src = c.createMediaElementSource(el)
    const gain = c.createGain()
    src.connect(gain)
    gain.connect(master!)
    gains.set(el, gain)
  } catch { /* already attached to another context */ }
}

/** Per-clip volume; values above 1 boost beyond the source level. */
export function setElementGain(el: HTMLMediaElement, v: number) {
  const g = gains.get(el)
  if (g) g.gain.value = Math.max(0, v)
}

export function isRouted(el: HTMLMediaElement): boolean {
  return gains.has(el)
}

export function getAnalyser(): AnalyserNode {
  ensureAudio()
  return analyser!
}
