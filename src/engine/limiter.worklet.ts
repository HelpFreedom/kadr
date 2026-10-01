// AudioWorklet: the preview's master limiter — the export's alimiter, ported
// in shared/previewLimiter.ts. Loaded by src/engine/audio.ts through vite's
// `?worker&url`, so the shared module is bundled in.
import { createLimiter } from '@shared/previewLimiter'

// the AudioWorkletGlobalScope, which lib.dom does not describe
declare const sampleRate: number
declare function registerProcessor(name: string, ctor: unknown): void
declare class AudioWorkletProcessor { readonly port: MessagePort }

class KadrLimiter extends AudioWorkletProcessor {
  private lim = createLimiter(sampleRate, 2)
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0]
    // no input connected = silence in; the look-ahead still drains
    if (out.length) this.lim.process(inputs[0] ?? [], out, out[0].length)
    return true
  }
}

registerProcessor('kadr-limiter', KadrLimiter)
