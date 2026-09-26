// Beats → timeline markers. The analysis runs in main (audio:analyze — a port
// of librosa's beat_track, verified beat-for-beat against it, see
// shared/audioAnalysis.ts); this module decides WHAT is listened to and turns
// the answer into beat markers, which every drag then snaps to.
import { create } from 'zustand'
import { useEditor, projectDuration, withLinked, findClip } from '@/state/store'
import { pickBeats, type BeatGrid, type BeatAnalysis } from '@shared/audioAnalysis'
import type { AudioAnalysisResult, Project } from '@shared/types'
import { collectRangeAudio, type RangeAudioFilter } from './subtitles'
import { logInfo } from './log'

export type { BeatGrid }

/** transient: a detection in flight (drives the button's spinner) */
export const useBeatsUi = create<{ busy: boolean; open: boolean; setOpen(v: boolean): void }>((set) => ({
  busy: false,
  open: false,
  setOpen: (open) => set({ open })
}))

export interface DetectBeatsOpts {
  /** timeline seconds; default: the clips' span, else the in/out range, else the whole project */
  range?: { start: number; end: number }
  /** listen to these clips only (a linked video half brings its audio twin) */
  clipIds?: string[]
  /** listen to this track only */
  trackId?: string
  /** which beats become markers — default 'all' */
  grid?: BeatGrid
}

export interface DetectBeatsResult {
  tempo: number
  /** markers placed */
  placed: number
  /** beats found before the grid was applied */
  found: number
  range: { start: number; end: number }
  /** what was listened to, for the dialog and the log */
  source: 'clips' | 'track' | 'mix'
  /** set when the grid was moved onto the audible attacks (ms, negative = it was late) */
  attackShiftMs?: number
}

/** The span the beats are looked for in, and the audio filter. */
export function beatTarget(project: Project, opts: DetectBeatsOpts, editorRange: { start: number; end: number } | null) {
  let filter: RangeAudioFilter | undefined
  let source: DetectBeatsResult['source'] = 'mix'
  let range = opts.range ?? null
  if (opts.clipIds?.length) {
    const ids = withLinked(project, opts.clipIds)
    filter = { clipIds: ids }
    source = 'clips'
    if (!range) {
      const clips = ids.map((id) => findClip(project, id)?.clip).filter((c): c is NonNullable<typeof c> => !!c)
      if (clips.length) {
        range = {
          start: Math.min(...clips.map((c) => c.start)),
          end: Math.max(...clips.map((c) => c.start + c.duration))
        }
      }
    }
  } else if (opts.trackId) {
    filter = { trackIds: [opts.trackId] }
    source = 'track'
  }
  if (!range) range = editorRange ?? { start: 0, end: projectDuration(project) }
  return { range: { start: Math.max(0, range.start), end: range.end }, filter, source }
}

/**
 * Listen to the target, find the beats and lay them down as markers,
 * replacing earlier beat markers inside the same span (one undo entry). The
 * user's own markers are never touched.
 */
export async function detectBeats(opts: DetectBeatsOpts = {}): Promise<DetectBeatsResult & { analysis: AudioAnalysisResult }> {
  const st = useEditor.getState()
  const { range, filter, source } = beatTarget(st.project, opts, st.range)
  if (!(range.end - range.start > 0.5)) throw new Error('слишком короткий участок для поиска битов (нужно больше 0.5 с)')
  const segments = collectRangeAudio(st.project, range.start, range.end, filter)
  if (!segments.length) throw new Error('в выбранном участке нет звука')
  useBeatsUi.setState({ busy: true })
  try {
    const analysis = await window.kadr.audioAnalyze({ audioSegments: segments, duration: range.end - range.start })
    const grid = opts.grid ?? 'all'
    const picked = pickBeats(analysis as BeatAnalysis, grid)
    const beats = picked.map((b) => ({ time: range.start + b.time, strength: b.intensity, strong: b.strong }))
    const placed = useEditor.getState().setBeatMarkers(beats, range)
    const at = analysis.attack
    logInfo('биты', `${analysis.tempo.toFixed(1)} BPM, ${placed} меток (${grid}) на ${range.start.toFixed(2)}–${range.end.toFixed(2)} с` +
      (at ? `; сетка выровнена по атаке (${at.band === 'low' ? 'бас' : 'вся полоса'}): ${at.shiftMs > 0 ? '+' : ''}${Math.round(at.shiftMs)} мс, точно на удар ${at.snapped}/${at.total}` : ''))
    return { tempo: analysis.tempo, placed, found: analysis.beats.length, range, source, analysis, attackShiftMs: at?.shiftMs }
  } finally {
    useBeatsUi.setState({ busy: false })
  }
}

/** Remove beat markers (inside `range`, or all). */
export function clearBeats(range?: { start: number; end: number }): number {
  return useEditor.getState().clearBeatMarkers(range)
}

/** Beat markers of the project as plain times (for scripts / the embedded Claude). */
export function beatTimes(project: Project, opts: { strongOnly?: boolean } = {}): number[] {
  return (project.markers ?? [])
    .filter((m) => m.kind === 'beat' && (!opts.strongOnly || m.strong))
    .map((m) => m.time)
    .sort((a, b) => a - b)
}
