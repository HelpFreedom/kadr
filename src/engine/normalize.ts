// Loudness normalization: measure the clip's used source range with ffmpeg's
// EBU R128 pass (main process) and set the clip gain so playback and export
// come out at the target loudness. Non-destructive — only the gain value
// changes, one undo entry, repeated runs converge to the same gain.
import { create } from 'zustand'
import { useEditor, findClip, withLinked } from '@/state/store'

/** YouTube/streaming loudness target and the true-peak ceiling. */
export const NORMALIZE_TARGET_LUFS = -14
export const NORMALIZE_PEAK_DB = -1

export const useNormalizeUi = create<{ busy: Record<string, boolean> }>(() => ({ busy: {} }))

export interface NormalizeResult {
  clipId: string
  /** absolute gain now on the clip */
  gain: number
  gainDb: number
  /** integrated loudness of the source range before gain, LUFS */
  measuredLufs: number
  /** true peak of the source range before gain, dBTP */
  measuredTp: number
  /** true when the true-peak ceiling limited the boost */
  peakLimited: boolean
}

/**
 * Normalize a clip's loudness to `targetLufs` (default −14 LUFS) with a
 * `peakDb` true-peak ceiling (default −1 dBTP). For a linked A/V pair the
 * gain lands on the audible (audio-track) twin regardless of which half was
 * passed. Keyframed gain is refused rather than silently overwritten.
 */
export async function normalizeClip(clipId: string, opts?: {
  targetLufs?: number
  peakDb?: number
}): Promise<NormalizeResult> {
  const st = () => useEditor.getState()
  const p = st().project

  // linked pair → operate on the twin that actually sounds
  let target = findClip(p, clipId)
  if (!target) throw new Error(`clip ${clipId} not found`)
  for (const id of withLinked(p, [clipId])) {
    const f = findClip(p, id)
    if (f && f.track.kind === 'audio') target = f
  }
  const { clip } = target
  const asset = clip.assetId ? p.assets.find((a) => a.id === clip.assetId) : null
  if (!asset?.hasAudio) throw new Error('clip has no audio')
  if (clip.gain?.keyframes?.length) {
    throw new Error('clip gain is keyframed — remove the keyframes first')
  }
  if (useNormalizeUi.getState().busy[clip.id]) throw new Error('normalization already running')

  useNormalizeUi.setState((s) => ({ busy: { ...s.busy, [clip.id]: true } }))
  try {
    const targetLufs = opts?.targetLufs ?? NORMALIZE_TARGET_LUFS
    const peakDb = opts?.peakDb ?? NORMALIZE_PEAK_DB
    const start = clip.inPoint || 0
    const used = clip.duration * (clip.speed || 1)
    const dur = asset.duration > 0 ? Math.min(used, Math.max(0.1, asset.duration - start)) : used
    const { i, tp } = await window.kadr.measureLoudness(asset.path, start, dur)

    let gainDb = targetLufs - i
    const peakLimited = tp + gainDb > peakDb
    if (peakLimited) gainDb = peakDb - tp
    const gain = Math.pow(10, gainDb / 20)

    st().pushHistory('hNormalize')
    st().updateClip(clip.id, { gain: { value: gain } })
    return {
      clipId: clip.id, gain, gainDb: Math.round(gainDb * 100) / 100,
      measuredLufs: i, measuredTp: tp, peakLimited
    }
  } finally {
    useNormalizeUi.setState((s) => {
      const busy = { ...s.busy }
      delete busy[clip.id]
      return { busy }
    })
  }
}
