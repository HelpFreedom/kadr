import { useEffect, useRef, useState } from 'react'
import { create } from 'zustand'
import type { SubCue, TextDoc } from '@shared/types'
import { useEditor } from '@/state/store'
import {
  transcribeFlow, type TranscribeFlowOpts,
  parseSrt, cuesToSrt, srtTime, parseSrtTime, docTimeToProject
} from '@/engine/subtitles'
import { useT } from '@/i18n'

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
    setRunning(true)
    setError('')
    setLiveText('')
    setProgress(0)
    try {
      const r = await transcribeFlow({ target: target!, model, language, timecodes, maxWords })
      setRunning(false)
      useTextUi.getState().closeTranscribe()
      useTextUi.getState().openDoc(r.doc.id)
      setLiveText('')
      setProgress(0)
    } catch (err) {
      setRunning(false)
      setError(String((err as Error)?.message ?? err))
    }
  }

  function cancel() {
    window.kadr.transcribeCancel()
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

export function SubtitlePanel() {
  const t = useT()
  const docId = useTextUi((s) => s.openDocId)
  const doc = useEditor((s) => (s.project.texts ?? []).find((d) => d.id === docId) ?? null)
  const [cues, setCues] = useState<SubCue[]>([])
  const [txt, setTxt] = useState('')
  const [dirty, setDirty] = useState(false)
  const [missing, setMissing] = useState(false)
  const mtime = useRef<number | null>(null)

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

  const close = () => useTextUi.getState().openDoc(null)

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

  return (
    <div className="sub-panel">
      <div className="claude-head">
        <span>📄 {doc.name}</span>
        <span className="dim claude-hint">{doc.language ? `(${doc.language})` : ''}</span>
        <button disabled={!dirty} onClick={save}>{t('subSave')}{dirty ? ' *' : ''}</button>
        <button onClick={() => void load(doc)} title={t('subReload')}>↻</button>
        <button className="claude-close" onClick={close}>✕</button>
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
        )}
      </div>
    </div>
  )
}
