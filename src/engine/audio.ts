// Shared WebAudio graph for the live preview: every media element is routed
// element → per-clip gain (allows >100% volume) → master → analyser → output.
let ctx: AudioContext | null = null
let master: GainNode | null = null
let analyser: AnalyserNode | null = null
const gains = new WeakMap<HTMLMediaElement, GainNode>()
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
/** elements routed into the graph right now (see audioStats) */
let routed = 0

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
    sources.set(el, src)
    routed++
  } catch { /* already attached to another context */ }
}

/**
 * Take an element out of the graph for good (the pool is dropping it). A
 * source node stays connected — and is processed on every render quantum —
 * for as long as it is wired to the master, even with its element paused
 * and unreferenced: playing a 19-minute project through left 1080 of them
 * on the graph, and corrective seeks grew from none to more than one a second
 * by the end (see MediaPool.evictFar).
 */
export function detachAudio(el: HTMLMediaElement) {
  const g = gains.get(el)
  if (!g) return
  try { sources.get(el)?.disconnect() } catch { /* already */ }
  try { g.disconnect() } catch { /* already */ }
  gains.delete(el)
  sources.delete(el)
  routed--
}

/** Per-clip volume; values above 1 boost beyond the source level. */
export function setElementGain(el: HTMLMediaElement, v: number) {
  const g = gains.get(el)
  // a non-finite value throws inside WebAudio and kills the caller's rAF
  // loop — no gain glitch is worth losing playback for the whole session
  if (g) g.gain.value = Number.isFinite(v) ? Math.max(0, v) : 0
}

export function isRouted(el: HTMLMediaElement): boolean {
  return gains.has(el)
}

export function getAnalyser(): AnalyserNode {
  ensureAudio()
  return analyser!
}

/**
 * What the preview's audio graph carries and how its output is doing — for
 * the debug panel, the embedded Claude and tests. `playback` is Chromium's
 * AudioContext.playbackStats: underrunEvents / underrunDuration are the
 * glitches you hear (the device asked for audio the graph had not made).
 */
export function audioStats() {
  const c = ctx
  const ps = c && (c as unknown as { playbackStats?: Record<string, number> }).playbackStats
  return {
    routed,
    state: c?.state ?? 'none',
    playback: ps ? {
      underrunEvents: ps.underrunEvents, underrunDuration: ps.underrunDuration,
      totalDuration: ps.totalDuration, averageLatency: ps.averageLatency, maximumLatency: ps.maximumLatency
    } : null
  }
}

/** Measurements and tests: the graph runs as usual, nothing reaches the speakers. */
export function silencePreview(on: boolean) {
  ensureAudio()
  master!.gain.value = on ? 0 : 1
}
