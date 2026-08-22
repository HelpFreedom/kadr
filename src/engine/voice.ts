export interface AutoCutOptions {
  /** minimum silence that may become a cut */
  silenceSeconds: number
  /** chunks shorter than this are joined to a neighbour */
  minChunkSeconds: number
  /** continuous speech is split when it grows beyond this */
  maxChunkSeconds: number
  /** silence detector threshold in dBFS */
  thresholdDb: number
  /** a little room around each spoken phrase */
  paddingSeconds?: number
}

export interface VoiceRange {
  start: number
  end: number
}

export function preferredVoiceMime(): { mime: string; extension: string } {
  const variants = [
    ['audio/webm;codecs=opus', 'webm'],
    ['audio/ogg;codecs=opus', 'ogg'],
    ['audio/webm', 'webm']
  ] as const
  for (const [mime, extension] of variants) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mime)) {
      return { mime, extension }
    }
  }
  return { mime: '', extension: 'webm' }
}

/**
 * Find speech islands without changing their project-time positions. Long
 * silences disappear from the clip bodies, but the resulting clips retain
 * the original gaps so a take stays in sync with the video it was read to.
 */
export function analyseVoiceRanges(buffer: AudioBuffer, opts: AutoCutOptions): VoiceRange[] {
  const duration = buffer.duration
  if (!Number.isFinite(duration) || duration <= 0.05) return []
  const requestedWindowSeconds = 0.02
  const windowSamples = Math.max(32, Math.round(buffer.sampleRate * requestedWindowSeconds))
  const windowSeconds = windowSamples / buffer.sampleRate
  const windows = Math.ceil(buffer.length / windowSamples)
  const threshold = Math.pow(10, Math.min(-6, opts.thresholdDb) / 20)
  const active = new Uint8Array(windows)

  for (let w = 0; w < windows; w++) {
    const from = w * windowSamples
    const to = Math.min(buffer.length, from + windowSamples)
    let energy = 0
    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      const data = buffer.getChannelData(ch)
      let sum = 0
      for (let i = from; i < to; i++) sum += data[i] * data[i]
      energy = Math.max(energy, Math.sqrt(sum / Math.max(1, to - from)))
    }
    if (energy >= threshold) active[w] = 1
  }

  let first = -1
  let last = -1
  for (let i = 0; i < active.length; i++) {
    if (!active[i]) continue
    if (first < 0) first = i
    last = i
  }
  // Never erase an apparently silent take: the threshold can be wrong for a
  // very quiet microphone, and keeping the source is the recoverable choice.
  if (first < 0) return [{ start: 0, end: duration }]

  const silenceWindows = Math.max(1, Math.round(opts.silenceSeconds / windowSeconds))
  const padding = Math.max(0, opts.paddingSeconds ?? 0.12)
  const raw: VoiceRange[] = []
  let groupStart = first
  let lastActive = first
  for (let i = first + 1; i <= last; i++) {
    if (!active[i]) continue
    if (i - lastActive - 1 >= silenceWindows) {
      raw.push({
        start: Math.max(0, groupStart * windowSeconds - padding),
        end: Math.min(duration, (lastActive + 1) * windowSeconds + padding)
      })
      groupStart = i
    }
    lastActive = i
  }
  raw.push({
    start: Math.max(0, groupStart * windowSeconds - padding),
    end: Math.min(duration, (lastActive + 1) * windowSeconds + padding)
  })

  const min = Math.max(0.2, opts.minChunkSeconds)
  const max = Math.max(min, opts.maxChunkSeconds)
  // Give very short phrases some surrounding room instead of joining them
  // across a potentially huge silence. Midpoints keep neighbouring phrases
  // from overlapping while still allowing a phrase to reach the requested
  // minimum duration when the timeline has enough room.
  const prepared = raw.map((range, index) => {
    const current = { ...range }
    const length = current.end - current.start
    if (length >= min) return current

    const previous = raw[index - 1]
    const next = raw[index + 1]
    const leftLimit = previous ? (previous.end + current.start) / 2 : 0
    const rightLimit = next ? (current.end + next.start) / 2 : duration
    let needed = min - length
    const left = Math.min(current.start - leftLimit, needed / 2)
    const right = Math.min(rightLimit - current.end, needed - left)
    current.start -= left
    current.end += right
    needed -= left + right

    if (needed > 0) {
      const extraLeft = Math.min(current.start - leftLimit, needed)
      current.start -= extraLeft
      needed -= extraLeft
    }
    if (needed > 0) current.end += Math.min(rightLimit - current.end, needed)
    return current
  })

  const out: VoiceRange[] = []
  for (const range of prepared) {
    const length = range.end - range.start
    let parts = Math.max(1, Math.ceil(length / max))
    // If the requested minimum and maximum cannot both be satisfied, prefer
    // one slightly longer chunk over producing a tiny unusable tail.
    if (length / parts < min) parts = Math.max(1, Math.floor(length / min))
    const partLength = length / parts
    for (let part = 0; part < parts; part++) {
      out.push({
        start: range.start + part * partLength,
        end: part === parts - 1 ? range.end : range.start + (part + 1) * partLength
      })
    }
  }
  return out
}
