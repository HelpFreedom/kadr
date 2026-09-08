// The training corpus: the user's verdicts on their way back to the detector.
//
// Timing matters more than it looks. ttsqc matches a verdict to its flag by the
// `play` span (train._same, tolerance 0.06 s), and a splice shifts every later
// time in the project. So the corpus is flushed BEFORE anything moves — before
// a regeneration and before a re-check — while the coordinates still line up
// with the run's own defects.json.
import { useEditor } from '../state/store'
import { useTtsSettings } from './tts'
import type { AudioDefect, VerdictRow, UserMarkRow, VoiceLearnResult, VoiceRun } from '@shared/types'

const verdictOf = (d: AudioDefect): 'yes' | 'no' | null =>
  d.state === 'confirmed' || d.state === 'done' ? 'yes'
  : d.state === 'rejected' ? 'no'
  : null

/**
 * Write one run's decisions into its corpus directory.
 *
 * Detector findings and hand-placed marks go to DIFFERENT files on purpose.
 * ttsqc silently drops verdict rows that match no flag, and once they outnumber
 * the matching ones it throws away the whole FILE — the genuine labels with it
 * (measured: 20 unmatched of 40 rows still passes, 21 voids everything).
 */
export async function flushVerdicts(runId?: string):
  Promise<{ verdicts: number; marks: number; droppedMarks?: number } | null> {
  const st = useEditor.getState()
  const runs = st.project.voiceRuns ?? []
  const run: VoiceRun | undefined = runId ? runs.find((r) => r.id === runId) : runs[0]
  if (!run?.runDir) return null

  const mine = (st.project.defects ?? []).filter((d) => d.runId === run.id)
  const verdicts: VerdictRow[] = []
  const marks: UserMarkRow[] = []
  for (const d of mine) {
    if (d.origin === 'user') {
      // «просто перегенерировать» — не утверждение о дефекте и в корпус не идёт
      if (d.cls !== 'redo') marks.push({ id: d.id, a0: d.src[0], a1: d.src[1], words: d.words })
      continue
    }
    if (!d.detectorId) continue
    const v = verdictOf(d)
    if (v === null) continue          // undecided is not a training example
    // `play` verbatim — that is the field the matcher keys on, and it is the
    // one field a splice deliberately never rewrites
    const play = d.play ?? d.src
    verdicts.push({ id: d.detectorId, t0: play[0], t1: play[1], a0: d.src[0], a1: d.src[1], verdict: v })
  }
  if (!verdicts.length && !marks.length) return { verdicts: 0, marks: 0 }
  // длительность нужна main, чтобы понять, к какой версии файла относятся
  // a0/a1: после склейки они уже не в координатах разобранного звука
  return window.kadr.voiceVerdicts({
    runDir: run.runDir, verdicts, marks, audioDuration: run.duration
  })
}

/** Flush every run that has a corpus directory — used before a re-check. */
export async function flushAllVerdicts(): Promise<void> {
  for (const r of useEditor.getState().project.voiceRuns ?? []) {
    if (r.runDir) await flushVerdicts(r.id).catch(() => { /* corpus is best-effort */ })
  }
}

/** What the corpus holds, without touching the model. */
export function learnStatus(): Promise<VoiceLearnResult> {
  return window.kadr.voiceLearn({ dry: true, python: useTtsSettings.getState().settings.ttsqcPython })
}

/**
 * Retrain. Deliberately never automatic: the model file is shared with the
 * user's own console ttsqc, retraining is from scratch, and a bad round of
 * labelling would degrade both. The previous model is backed up first.
 */
export function retrain(): Promise<VoiceLearnResult> {
  return window.kadr.voiceLearn({ dry: false, python: useTtsSettings.getState().settings.ttsqcPython })
}
