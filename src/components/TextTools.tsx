import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type {
  MediaAsset, SubCue, TextDoc, VoiceoverCustomVoice, VoiceoverStatus, VoiceoverVersion
} from '@shared/types'
import {
  DEFAULT_VOICEOVER_SETTINGS, mergeVoiceChoices
} from '@shared/voiceover'
import { uid, useEditor, useSettings, type TimedVoiceoverInsert } from '@/state/store'
import {
  transcribeFlow, type TranscribeFlowOpts,
  parseSrt, cuesToSrt, srtTime, parseSrtTime, docTimeToProject, transcribeErrorMessage
} from '@/engine/subtitles'
import { useT } from '@/i18n'
import { VoiceoverSetup } from './VoiceoverStudio'

/** UI state shared by MediaBin, Timeline and App: what's open right now. */
interface TextUiState {
  transcribeTarget: TranscribeFlowOpts['target'] | null
  openDocId: string | null
  openTranscribe(target: TranscribeFlowOpts['target']): void
  closeTranscribe(): void
  openDoc(id: string | null): void
}

export const useTextUi = create<TextUiState>((set) => ({
  transcribeTarget: null,
  openDocId: null,
  openTranscribe: (target) => set({ transcribeTarget: target }),
  closeTranscribe: () => set({ transcribeTarget: null }),
  openDoc: (id) => set({ openDocId: id })
}))

// ------------------------------------------------------------------ dialog

export function TranscribeDialog() {
  const t = useT()
  const target = useTextUi((s) => s.transcribeTarget)
  const [model, setModel] = useState('large-v3')
  const [language, setLanguage] = useState('auto')
  const [timecodes, setTimecodes] = useState<'absolute' | 'relative'>('absolute')
  const [maxWords, setMaxWords] = useState(3)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [liveText, setLiveText] = useState('')
  const [error, setError] = useState('')
  const cancelRequested = useRef(false)

  useEffect(() => {
    if (!running) return
    return window.kadr.onTranscribeProgress((p) => {
      setProgress(p.progress)
      if (p.text) setLiveText(p.text)
    })
  }, [running])

  if (!target) return null
  const project = useEditor.getState().project
  const label = target.kind === 'asset'
    ? project.assets.find((a) => a.id === target.assetId)?.name ?? '?'
    : `${target.start.toFixed(1)}–${target.end.toFixed(1)} c`

  const close = () => {
    if (running) return
    setError('')
    setLiveText('')
    setProgress(0)
    useTextUi.getState().closeTranscribe()
  }

  async function run() {
    cancelRequested.current = false
    setRunning(true)
    setError('')
    setLiveText('')
    setProgress(0)
    try {
      const r = await transcribeFlow({ target: target!, model, language, timecodes, maxWords })
      cancelRequested.current = false
      setRunning(false)
      useTextUi.getState().closeTranscribe()
      useTextUi.getState().openDoc(r.doc.id)
      setLiveText('')
      setProgress(0)
    } catch (err) {
      setRunning(false)
      if (cancelRequested.current) {
        cancelRequested.current = false
        setError('')
        setLiveText('')
        setProgress(0)
        useTextUi.getState().closeTranscribe()
      } else {
        setError(transcribeErrorMessage(err))
      }
    }
  }

  function cancel() {
    cancelRequested.current = true
    void window.kadr.transcribeCancel()
  }

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('transcribe')}</h2>
        <div className="insp-field">
          <span>{target.kind === 'asset' ? t('trSourceFile') : t('trSourceRange')}</span>
          <span className="tr-target">{label}</span>
        </div>
        <label className="insp-field">
          <span>{t('trModel')}</span>
          <select value={model} disabled={running} onChange={(e) => setModel(e.target.value)}>
            <option value="large-v3">large-v3 — {t('trBest')}</option>
            <option value="medium">medium — {t('trFaster')}</option>
            <option value="base">base — {t('trDraft')}</option>
          </select>
        </label>
        <label className="insp-field">
          <span>{t('trLanguage')}</span>
          <select value={language} disabled={running} onChange={(e) => setLanguage(e.target.value)}>
            <option value="auto">{t('trAuto')}</option>
            <option value="ru">Русский</option>
            <option value="en">English</option>
          </select>
        </label>
        <label className="insp-field">
          <span>{t('trSplit')}</span>
          <select
            value={maxWords}
            disabled={running}
            onChange={(e) => setMaxWords(Number(e.target.value))}
          >
            <option value={1}>{t('trSplit1')}</option>
            <option value={2}>2 {t('trSplitWords')}</option>
            <option value={3}>3 {t('trSplitWords')}</option>
            <option value={4}>4 {t('trSplitWords')}</option>
            <option value={0}>{t('trSplitPhrases')}</option>
          </select>
        </label>
        {target.kind === 'range' && (
          <label className="insp-field">
            <span>{t('trTimecodes')}</span>
            <select
              value={timecodes}
              disabled={running}
              onChange={(e) => setTimecodes(e.target.value as 'absolute' | 'relative')}
            >
              <option value="absolute">{t('trAbsolute')}</option>
              <option value="relative">{t('trRelative')}</option>
            </select>
          </label>
        )}
        {running && (
          <div className="export-progress">
            <progress value={progress} max={1} />
            <div className="dim tr-live">{liveText || t('trWorking')}</div>
          </div>
        )}
        {error && <div className="tr-error">{error}</div>}
        <div className="modal-actions">
          {running ? (
            <button onClick={cancel}>{t('cancel')}</button>
          ) : (
            <>
              <button onClick={close}>{t('cancel')}</button>
              <button className="primary" onClick={run}>{t('trRun')}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------- panel

const cueSpeechText = (text: string) => text
  .replace(/<[^>]*>/g, ' ')
  .replace(/\{\\[^}]*\}/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()

export function SubtitlePanel() {
  const t = useT()
  const ru = useSettings((s) => s.lang) === 'ru'
  const docId = useTextUi((s) => s.openDocId)
  const doc = useEditor((s) => (s.project.texts ?? []).find((d) => d.id === docId) ?? null)
  const projectPath = useEditor((s) => s.projectPath)
  const projectVoices = useEditor((s) => s.project.voiceClones ?? [])
  const [cues, setCues] = useState<SubCue[]>([])
  const [txt, setTxt] = useState('')
  const [dirty, setDirty] = useState(false)
  const [missing, setMissing] = useState(false)
  const [ttsStatus, setTtsStatus] = useState<VoiceoverStatus | null>(null)
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICEOVER_SETTINGS.voiceId)
  const [globalVoices, setGlobalVoices] = useState<VoiceoverCustomVoice[]>([])
  const [voiceBusy, setVoiceBusy] = useState(false)
  const [voiceDone, setVoiceDone] = useState(0)
  const [voiceTotal, setVoiceTotal] = useState(0)
  const [voiceStageProgress, setVoiceStageProgress] = useState(0)
  const [voiceMessage, setVoiceMessage] = useState('')
  const [voiceError, setVoiceError] = useState('')
  const mtime = useRef<number | null>(null)
  const voiceJobId = useRef('')
  const voiceCancelRequested = useRef(false)
  const voices = useMemo(
    () => mergeVoiceChoices([...globalVoices, ...projectVoices]),
    [globalVoices, projectVoices]
  )
  const selectedVoice = voices.find((voice) => voice.id === voiceId) ?? voices[0]
  const voiceSettings = {
    ...DEFAULT_VOICEOVER_SETTINGS,
    voiceId: selectedVoice?.id ?? DEFAULT_VOICEOVER_SETTINGS.voiceId,
    customVoice: selectedVoice?.customVoice
  }

  const load = async (d: TextDoc) => {
    const content = await window.kadr.readTextFile(d.path)
    mtime.current = await window.kadr.statFile(d.path)
    if (content === null) {
      setMissing(true)
      setCues([])
      setTxt('')
      return
    }
    setMissing(false)
    if (d.format === 'srt') setCues(parseSrt(content))
    else setTxt(content)
    setDirty(false)
  }

  useEffect(() => {
    if (doc) void load(doc)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id])

  useEffect(() => {
    if (doc?.format !== 'srt') return
    let current = true
    setTtsStatus(null)
    setVoiceError('')
    void Promise.all([
      window.kadr.voiceoverStatus(DEFAULT_VOICEOVER_SETTINGS),
      window.kadr.voiceCloneList().catch(() => [] as VoiceoverCustomVoice[])
    ]).then(([status, customVoices]) => {
      if (!current) return
      setTtsStatus(status)
      setGlobalVoices(customVoices)
    }).catch((error) => {
      if (!current) return
      setTtsStatus({
        ready: false,
        reason: String(error instanceof Error ? error.message : error),
        configPath: '~/.config/kadr/tts.json'
      })
    })
    return () => { current = false }
  }, [doc?.id, doc?.format])

  useEffect(() => window.kadr.onVoiceoverProgress((progress) => {
    if (progress.clipId === voiceJobId.current) setVoiceStageProgress(progress.progress)
  }), [])

  // pick up external edits (e.g. Claude editing the file) while clean
  useEffect(() => {
    if (!doc) return
    const timer = setInterval(async () => {
      const m = await window.kadr.statFile(doc.path)
      if (m !== mtime.current && !dirty) {
        mtime.current = m
        void load(doc)
      }
    }, 2000)
    return () => clearInterval(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc?.id, dirty])

  if (!doc) return null

  const close = () => {
    if (!voiceBusy) useTextUi.getState().openDoc(null)
  }

  async function save() {
    if (!doc) return
    const content = doc.format === 'srt' ? cuesToSrt(cues) : txt
    await window.kadr.writeTextFile(doc.path, content)
    mtime.current = await window.kadr.statFile(doc.path)
    setDirty(false)
  }

  function seek(cue: SubCue) {
    const s = useEditor.getState()
    const pt = docTimeToProject(s.project, doc!, cue.start)
    if (pt !== null) s.setPlayhead(Math.max(0, pt))
  }

  const setCue = (i: number, patch: Partial<SubCue>) => {
    setCues((cs) => cs.map((c, j) => (j === i ? { ...c, ...patch } : c)))
    setDirty(true)
  }

  function addCue() {
    const latestEnd = cues.reduce((end, cue) => Math.max(end, cue.end), 0)
    const projectTime = useEditor.getState().playhead
    const mappedPlayhead = doc!.offset !== undefined
      ? Math.max(0, projectTime - doc!.offset)
      : doc!.assetId ? 0 : projectTime
    const start = Math.max(latestEnd, mappedPlayhead)
    setCues((current) => [...current, { start, end: start + 3, text: '' }])
    setDirty(true)
  }

  async function generateSrtVoiceover() {
    if (!doc || doc.format !== 'srt' || voiceBusy || !ttsStatus?.ready || !selectedVoice) return
    setVoiceError('')
    setVoiceMessage('')
    if (dirty) await save()

    const project = useEditor.getState().project
    const plans = cues.map((cue, cueIndex) => {
      const text = cueSpeechText(cue.text)
      const start = docTimeToProject(project, doc, cue.start)
      const end = docTimeToProject(project, doc, cue.end)
      if (!text || start === null || end === null || end <= start) return null
      return { cueIndex, text, start, duration: Math.max(0.05, end - start) }
    }).filter((plan): plan is NonNullable<typeof plan> => !!plan)

    if (!plans.length) {
      setVoiceError(t('subVoiceNoCues'))
      return
    }

    const batchId = `${Date.now().toString(36)}-${uid()}`
    const inserts: TimedVoiceoverInsert[] = []
    voiceCancelRequested.current = false
    setVoiceBusy(true)
    setVoiceDone(0)
    setVoiceTotal(plans.length)
    setVoiceStageProgress(0)
    let failure = ''

    try {
      for (let index = 0; index < plans.length; index++) {
        if (voiceCancelRequested.current) break
        const plan = plans[index]
        const jobId = `srt-${doc.id}-${batchId}-${plan.cueIndex + 1}`
        voiceJobId.current = jobId
        setVoiceStageProgress(0)
        setVoiceMessage(t('subVoiceProgress')
          .replace('{current}', String(index + 1))
          .replace('{total}', String(plans.length)))
        const generated = await window.kadr.voiceoverGenerate({
          clipId: jobId,
          projectPath,
          version: 1,
          text: plan.text,
          settings: voiceSettings
        })
        const probe = await window.kadr.probeMedia(generated.path)
        const assetId = `voice-${jobId}`
        const versionId = `take-${jobId}-1`
        const takeSettings = { ...voiceSettings, seed: generated.seed }
        const version: VoiceoverVersion = {
          id: versionId,
          number: 1,
          text: plan.text,
          path: generated.path,
          assetId,
          duration: generated.duration,
          createdAt: new Date().toISOString(),
          settings: takeSettings
        }
        const asset: MediaAsset = {
          ...probe.asset,
          id: assetId,
          path: generated.path,
          name: `${doc.name} · ${plan.cueIndex + 1}`,
          kind: 'audio'
        }
        inserts.push({
          asset,
          start: plan.start,
          duration: plan.duration,
          speed: generated.duration / plan.duration,
          label: `${plan.cueIndex + 1}. ${plan.text.slice(0, 64)}`,
          voiceover: {
            activeVersionId: versionId,
            versions: [version],
            settings: takeSettings,
            timedDuration: plan.duration
          }
        })
        setVoiceStageProgress(0)
        setVoiceDone(index + 1)
      }
    } catch (error) {
      failure = String(error instanceof Error ? error.message : error)
    }

    if (inserts.length) {
      useEditor.getState().insertTimedVoiceovers(
        inserts,
        `${ru ? 'SRT-озвучка' : 'SRT voiceover'} · ${doc.name}`
      )
    }
    voiceJobId.current = ''
    setVoiceBusy(false)
    setVoiceStageProgress(0)
    if (voiceCancelRequested.current) {
      setVoiceMessage(t('subVoicePartial')
        .replace('{done}', String(inserts.length))
        .replace('{total}', String(plans.length)))
    } else if (failure) {
      setVoiceError(`${failure}${inserts.length
        ? ` · ${t('subVoicePartial').replace('{done}', String(inserts.length)).replace('{total}', String(plans.length))}`
        : ''}`)
      setVoiceMessage('')
    } else {
      setVoiceMessage(t('subVoiceDone').replace('{count}', String(inserts.length)))
    }
  }

  function cancelSrtVoiceover() {
    voiceCancelRequested.current = true
    void window.kadr.voiceoverCancel()
  }

  return (
    <div className="sub-panel">
      <div className="claude-head">
        <span>📄 {doc.name}</span>
        <span className="dim claude-hint">{doc.language ? `(${doc.language})` : ''}</span>
        {doc.format === 'srt' && (
          <button disabled={voiceBusy} onClick={addCue}>＋ {t('subAddCue')}</button>
        )}
        <button disabled={!dirty} onClick={save}>{t('subSave')}{dirty ? ' *' : ''}</button>
        <button disabled={voiceBusy} onClick={() => void load(doc)} title={t('subReload')}>↻</button>
        <button className="claude-close" disabled={voiceBusy} onClick={close}>✕</button>
      </div>
      <div className="sub-body">
        {missing && <div className="tr-error">{t('subMissing')}: {doc.path}</div>}
        {doc.format === 'txt' ? (
          <textarea
            className="sub-txt"
            value={txt}
            onChange={(e) => {
              setTxt(e.target.value)
              setDirty(true)
            }}
          />
        ) : (
          <>
            <section className="sub-voice-box">
              <div className="sub-voice-title">
                <div><b>{t('subVoiceTitle')}</b><span>{t('subVoiceTimingHint')}</span></div>
                <select value={voiceId} disabled={voiceBusy}
                  aria-label={t('subVoiceChoice')} onChange={(event) => setVoiceId(event.target.value)}>
                  {voices.map((voice) => (
                    <option key={voice.id} value={voice.id}>
                      {voice.number ? `№${voice.number} · ` : '★ '}{ru ? voice.name : voice.nameEn}
                    </option>
                  ))}
                </select>
              </div>
              <VoiceoverSetup status={ttsStatus} settings={voiceSettings} onReady={setTtsStatus} ru={ru} />
              {voiceBusy && (
                <div className="sub-voice-progress" role="status">
                  <div><span>{voiceMessage}</span><b>{voiceDone}/{voiceTotal}</b></div>
                  <progress
                    value={voiceTotal ? Math.min(1, (voiceDone + voiceStageProgress) / voiceTotal) : 0}
                    max={1}
                  />
                </div>
              )}
              {voiceError && <div className="tr-error">{voiceError}</div>}
              {!voiceBusy && voiceMessage && <div className="sub-voice-result">{voiceMessage}</div>}
              {voiceBusy ? (
                <button className="sub-voice-cancel" onClick={cancelSrtVoiceover}>{t('subVoiceCancel')}</button>
              ) : (
                <button className="primary sub-voice-generate"
                  disabled={!cues.length || !ttsStatus?.ready || missing}
                  onClick={() => void generateSrtVoiceover()}>
                  {t('subVoiceGenerate')}
                </button>
              )}
            </section>
            <div className="sub-list">
              {cues.map((c, i) => (
                <div className="sub-cue" key={i}>
                  <div className="sub-times">
                    <button className="sub-idx" title={t('subSeek')} onClick={() => seek(c)}>
                      ▸ {i + 1}
                    </button>
                    <input
                      value={srtTime(c.start)}
                      onChange={(e) => setCue(i, { start: parseSrtTime(e.target.value) })}
                    />
                    <span>→</span>
                    <input
                      value={srtTime(c.end)}
                      onChange={(e) => setCue(i, { end: parseSrtTime(e.target.value) })}
                    />
                    <button
                      className="preset-del"
                      title={t('delete')}
                      onClick={() => {
                        setCues((cs) => cs.filter((_, j) => j !== i))
                        setDirty(true)
                      }}
                    >✕</button>
                  </div>
                  <textarea
                    rows={Math.max(1, c.text.split('\n').length)}
                    value={c.text}
                    onChange={(e) => setCue(i, { text: e.target.value })}
                  />
                </div>
              ))}
              {!cues.length && !missing && <div className="hint">{t('subEmpty')}</div>}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
