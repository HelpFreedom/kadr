// Running the defect detector over a voice-over, and the user's verdicts.
import { create } from 'zustand'
import { useEditor, uid } from '../state/store'
import { activity } from './autosave'
import { useTtsSettings } from './tts'
import { flushVerdicts, flushAllVerdicts } from './voiceLearn'
import type { AudioDefect, RawDefect, VoiceRun } from '@shared/types'

const HIDE_KEY = 'kadr.defectsHidden'

interface VoiceUiState {
  /** defectId → 0..1 while a regeneration is in flight. Deliberately NOT a
      persisted state: after a crash 'regenerating' on disk would be a lie. */
  busy: Record<string, number>
  phase: 'idle' | 'check' | 'regen'
  progress: number
  stage: string
  error: string
  /** live preview while the user drags a span over a voice-over clip */
  marking: { trackId: string; from: number; to: number } | null
  /** hide every audio mark — the timeline gets busy once a check has run */
  hidden: boolean
}

export const useVoiceUi = create<VoiceUiState>(() => ({
  busy: {}, phase: 'idle', progress: 0, stage: '', error: '',
  marking: null,
  hidden: (() => {
    try { return localStorage.getItem(HIDE_KEY) === '1' } catch { return false }
  })()
}))

export function setDefectsHidden(hidden: boolean): void {
  useVoiceUi.setState({ hidden })
  try { localStorage.setItem(HIDE_KEY, hidden ? '1' : '0') } catch { /* cache only */ }
}

async function sha1(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function findRun(runId?: string, assetId?: string): VoiceRun {
  const runs = useEditor.getState().project.voiceRuns ?? []
  const run = runId ? runs.find((r) => r.id === runId)
    : assetId ? runs.find((r) => r.assetId === assetId)
    : runs[runs.length - 1]
  if (!run) throw new Error('это не озвучка Kadr: разбирать нечего')
  return run
}

/**
 * The script must still be byte-for-byte what was synthesised.
 *
 * ttsqc addresses a defect by script WORD INDEX, and the phrase to regenerate
 * by character offset into this file. Edit it and every one of those numbers
 * silently points somewhere else — so a mismatch is refused, never patched up.
 */
async function assertScriptFresh(run: VoiceRun): Promise<void> {
  const text = await window.kadr.readTextFile(run.scriptPath)
  if (text === null) throw new Error(`не найден сценарий озвучки: ${run.scriptPath}`)
  if (run.scriptHash && (await sha1(text)) !== run.scriptHash) {
    throw new Error('сценарий изменился после озвучки — индексы слов больше не совпадают. ' +
                    'Переозвучьте текст или верните файл сценария.')
  }
}

function toDefect(run: VoiceRun, raw: RawDefect): AudioDefect {
  return {
    id: uid(),
    runId: run.id,
    assetId: run.assetId,
    origin: 'detector',
    detectorId: raw.id,
    cls: raw.class,
    tier: raw.tier,
    confidence: raw.confidence,
    words: raw.words,
    evidence: raw.evidence,
    text: raw.text,
    contextBefore: raw.context_before,
    contextAfter: raw.context_after,
    play: raw.play,
    src: [raw.audio[0], raw.audio[1]],
    phrase: raw.phrase,
    state: 'proposed'
  }
}

export interface CheckOpts {
  runId?: string
  assetId?: string
  device?: string
  minConfidence?: number
  maxFlags?: number
  edgeWords?: number
}

/** Analyse a voice-over and replace this run's findings with what came back. */
export async function checkVoice(opts: CheckOpts = {}):
  Promise<{ runId: string; defects: number; trust: number; runDir: string }> {
  const st = () => useEditor.getState()
  if (activity.exporting) {
    throw new Error('идёт экспорт — разбор и экспорт не поделят видеокарту, дождитесь конца')
  }
  if (useVoiceUi.getState().phase !== 'idle') throw new Error('разбор уже идёт')

  const run = findRun(opts.runId, opts.assetId)
  const asset = st().project.assets.find((a) => a.id === run.assetId)
  if (!asset) throw new Error('аудио озвучки пропало из проекта')
  await assertScriptFresh(run)

  // разбор заменит находки прогона — решения по ним надо сохранить ДО этого,
  // иначе они исчезнут вместе с находками
  await flushVerdicts(run.id).catch(() => { /* корпус — не повод срывать разбор */ })
  useVoiceUi.setState({ phase: 'check', progress: 0, stage: 'start', error: '' })
  activity.voiceCheck = true
  const off = window.kadr.onVoiceProgress(({ progress, stage }) =>
    useVoiceUi.setState({ progress, stage }))
  try {
    const res = await window.kadr.voiceCheck({
      audioPath: asset.path,
      scriptPath: run.scriptPath,
      device: opts.device,
      minConfidence: opts.minConfidence,
      maxFlags: opts.maxFlags,
      edgeWords: opts.edgeWords,
      python: useTtsSettings.getState().settings.ttsqcPython
    })
    // re-check the run is still there: the analysis takes minutes and the user
    // may well have deleted the clip meanwhile (the reverseClip discipline)
    const live = (st().project.voiceRuns ?? []).find((r) => r.id === run.id)
    if (!live) throw new Error('озвучка удалена из проекта, пока шёл разбор')

    const defects = res.defects.map((raw) => toDefect(run, raw))
    st().applyCheckResult(run.id, {
      runDir: res.runDir, trust: res.trust, stats: res.stats, duration: res.duration
    }, defects)
    return { runId: run.id, defects: defects.length, trust: res.trust, runDir: res.runDir }
  } finally {
    off()
    activity.voiceCheck = false
    useVoiceUi.setState({ phase: 'idle', progress: 0, stage: '' })
  }
}

export function cancelCheck(): Promise<void> {
  return window.kadr.voiceCheckCancel()
}

/**
 * A defect the user spotted themselves.
 *
 * The editor immediately works out which phrase it falls in, using the finished
 * run — no models are loaded for this, only the stored alignment and a decode
 * of the run's own copy of the audio.
 */
/**
 * A mark the user placed by hand.
 *
 * Two kinds, and the difference matters beyond wording. 'defect' says «there is
 * a flaw here» and becomes a training example for the detector. 'redo' says
 * «this just sounds wrong to me» — the phrase is picked up and can be
 * regenerated, but nothing is claimed about a defect, so it never reaches the
 * corpus. Teaching the detector on «I did not like it» would be teaching it
 * something it cannot possibly measure.
 */
export async function addUserDefect(assetId: string, start: number, end: number,
                                    kind: 'defect' | 'redo' = 'defect'): Promise<string> {
  const st = () => useEditor.getState()
  const run = findRun(undefined, assetId)
  if (!run.runDir) {
    throw new Error('сначала выполните разбор дефектов — без него не из чего считать фразу')
  }
  const a0 = Math.max(0, Math.min(start, end))
  const a1 = Math.max(start, end)
  // длительность файла, по которому ставится отметка: драйвер сверит её с
  // разбором и откажется считать фразу по чужой версии звука
  const asset = st().project.assets.find((a) => a.id === assetId)
  const { words, phrase } = await window.kadr.voicePhraseAt({
    runDir: run.runDir, start: a0, end: a1,
    audioDuration: asset?.duration,
    python: useTtsSettings.getState().settings.ttsqcPython
  })
  const d: AudioDefect = {
    id: uid(),
    runId: run.id,
    assetId,
    origin: 'user',
    cls: kind === 'redo' ? 'redo' : 'user',
    words,
    src: [a0, a1 > a0 ? a1 : a0 + 0.15],
    phrase,
    state: 'proposed',
    note: kind === 'redo' ? 'перегенерировать по желанию' : 'отмечено вручную'
  }
  st().addUserDefect(d)
  flushAllVerdicts().catch(() => { /* corpus is best-effort */ })
  return d.id
}

/** Verdicts land in the training corpus on their own, a moment after the
    clicking stops — otherwise a session where the user judged everything but
    never ran another check would teach the detector nothing. */
let flushTimer: ReturnType<typeof setTimeout> | undefined
function scheduleFlush() {
  clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushAllVerdicts().catch(() => { /* corpus is best-effort, never blocks work */ })
  }, 1500)
}

/** The verdict itself. Regeneration is a separate, explicit step. */
export function setVerdict(ids: string | string[], isDefect: boolean): void {
  useEditor.getState().setDefectState(ids, isDefect ? 'confirmed' : 'rejected')
  scheduleFlush()
}

/** Back to undecided — for a mis-click. */
export function clearVerdict(ids: string | string[]): void {
  useEditor.getState().setDefectState(ids, 'proposed')
  scheduleFlush()
}

export function selfTestDetector() {
  return window.kadr.voiceSelfTest(useTtsSettings.getState().settings.ttsqcPython)
}
