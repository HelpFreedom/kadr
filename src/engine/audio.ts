// Shared WebAudio graph for the live preview: every media element is routed
// element → per-clip gain (allows >100% volume) → master → limiter → analyser
// → output. The limiter is the export's own (shared/previewLimiter.ts, an
// AudioWorklet), so a hot mix clips in neither; `useSettings.previewLimiter`
// takes it out, and until its module has loaded the master goes straight on.
import { useSettings } from '../state/store'
import { logWarn } from './log'

let ctx: AudioContext | null = null
let master: GainNode | null = null
let analyser: AnalyserNode | null = null
let limiter: AudioWorkletNode | null = null
let limiterState: 'loading' | 'ready' | 'failed' = 'loading'
/** the worklet's URL, handed in by main.tsx: a `?worker&url` import is vite's
 *  alone, and the node checks bundle this file with esbuild */
let limiterModule = ''
export function wirePreviewLimiter(url: string) { limiterModule = url }
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
    analyser.connect(ctx.destination)
    const c = ctx
    c.audioWorklet.addModule(limiterModule).then(() => {
      limiter = new AudioWorkletNode(c, 'kadr-limiter', {
        outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit'
      })
      limiter.connect(analyser!)
      limiterState = 'ready'
      route()
    }).catch((e) => {
      limiterState = 'failed'
      logWarn('звук', 'лимитер превью не загрузился — превью звучит без него', String(e))
    })
    useSettings.subscribe((s, prev) => { if (s.previewLimiter !== prev.previewLimiter) route() })
    route()
  }
  return ctx
}

function limiterOn(): boolean {
  return !!limiter && useSettings.getState().previewLimiter
}

/** master → limiter when it is loaded and wanted, else master → analyser */
function route() {
  master!.disconnect()
  master!.connect(limiterOn() ? limiter! : analyser!)
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
  // the output's peak right now (the analyser's window, ~11 ms), dBFS
  let peak = 0
  if (analyser) {
    const buf = new Float32Array(analyser.fftSize)
    analyser.getFloatTimeDomainData(buf)
    for (const x of buf) peak = Math.max(peak, Math.abs(x))
  }
  return {
    routed,
    state: c?.state ?? 'none',
    limiter: limiterOn() ? 'on' : limiterState === 'ready' ? 'off' : limiterState,
    peakDb: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
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
