import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useEditor, projectDuration } from '@/state/store'
import { autoCaptions, CAPTION_DEFAULTS, type CaptionStyle } from '@/engine/captions'
import { useT } from '@/i18n'

export const useCaptionsUi = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

export function CaptionsDialog() {
  const t = useT()
  const open = useCaptionsUi((s) => s.open)
  const range = useEditor((s) => s.range)
  const [style, setStyle] = useState<CaptionStyle>({ ...CAPTION_DEFAULTS })
  const [maxWords, setMaxWords] = useState(3)
  const [model, setModel] = useState('large-v3')
  const [language, setLanguage] = useState('auto')
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

  if (!open) return null
  const dur = projectDuration(useEditor.getState().project)
  const target = range ?? { start: 0, end: dur }
  const patch = (p: Partial<CaptionStyle>) => setStyle((s) => ({ ...s, ...p }))

  const close = () => {
    if (running) return
    setError('')
    setLiveText('')
    setProgress(0)
    useCaptionsUi.getState().setOpen(false)
  }

  async function run() {
    setRunning(true)
    setError('')
    setProgress(0)
    setLiveText('')
    try {
      await autoCaptions({ range, style, maxWords, model, language })
      setRunning(false)
      useCaptionsUi.getState().setOpen(false)
    } catch (err) {
      setRunning(false)
      setError(String((err as Error)?.message ?? err))
    }
  }

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal captions-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('capTitle')}</h2>
        <div className="insp-field">
          <span>{t('capTarget')}</span>
          <span>
            {range
              ? `${t('trSourceRange')}: ${range.start.toFixed(1)}–${range.end.toFixed(1)} c`
              : `${t('capWhole')} (0–${target.end.toFixed(1)} c)`}
          </span>
        </div>
        <label className="insp-field">
          <span>{t('trModel')}</span>
          <select value={model} disabled={running} onChange={(e) => setModel(e.target.value)}>
            <option value="large-v3">large-v3 — {t('trBest')}</option>
            <option value="medium">medium — {t('trFaster')}</option>
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
          <select value={maxWords} disabled={running} onChange={(e) => setMaxWords(Number(e.target.value))}>
            <option value={1}>{t('trSplit1')}</option>
            <option value={2}>2 {t('trSplitWords')}</option>
            <option value={3}>3 {t('trSplitWords')}</option>
            <option value={4}>4 {t('trSplitWords')}</option>
          </select>
        </label>
        <label className="insp-field">
          <span>{t('capFont')}</span>
          <select
            value={style.fontFamily}
            disabled={running}
            onChange={(e) => patch({ fontFamily: e.target.value })}
          >
            <option value="sans-serif">Sans</option>
            <option value="'Arial Black', sans-serif">Arial Black</option>
            <option value="serif">Serif</option>
            <option value="monospace">Mono</option>
          </select>
        </label>
        <label className="insp-field">
          <span>{t('fxSize')}</span>
          <input
            type="number"
            min={16}
            max={300}
            value={style.fontSize}
            disabled={running}
            onChange={(e) => patch({ fontSize: Number(e.target.value) || 64 })}
          />
        </label>
        <label className="insp-field">
          <span>{t('bold')}</span>
          <input
            type="checkbox"
            checked={style.bold}
            disabled={running}
            onChange={(e) => patch({ bold: e.target.checked })}
          />
        </label>
        <label className="insp-field">
          <span>{t('color')}</span>
          <input type="color" value={style.color} disabled={running}
            onChange={(e) => patch({ color: e.target.value })} />
        </label>
        <label className="insp-field">
          <span>{t('capHighlightColor')}</span>
          <input type="color" value={style.highlightColor} disabled={running}
            onChange={(e) => patch({ highlightColor: e.target.value })} />
        </label>
        <label className="insp-field">
          <span>{t('capEntrance')}</span>
          <select value={style.entrance} disabled={running}
            onChange={(e) => patch({ entrance: e.target.value as CaptionStyle['entrance'] })}>
            <option value="pop">{t('capPop')}</option>
            <option value="rise">{t('capRise')}</option>
            <option value="fade">{t('capFade')}</option>
            <option value="none">{t('capNone')}</option>
          </select>
        </label>
        <label className="insp-field">
          <span>{t('capHighlight')}</span>
          <select value={style.highlight} disabled={running}
            onChange={(e) => patch({ highlight: e.target.value as CaptionStyle['highlight'] })}>
            <option value="color">{t('capHlColor')}</option>
            <option value="pop">{t('capHlPop')}</option>
            <option value="box">{t('capHlBox')}</option>
            <option value="none">{t('capNone')}</option>
          </select>
        </label>
        <label className="insp-field">
          <span>{t('capSpeed')}</span>
          <input
            type="range"
            min={0.5}
            max={2}
            step={0.1}
            value={style.speed}
            disabled={running}
            onChange={(e) => patch({ speed: Number(e.target.value) })}
          />
          <span className="fx-val">{style.speed.toFixed(1)}×</span>
        </label>
        <div className="dim">{t('capMouseHint')}</div>
        {running && (
          <div className="export-progress">
            <progress value={progress} max={1} />
            <div className="dim tr-live">{liveText || t('trWorking')}</div>
          </div>
        )}
        {error && <div className="tr-error">{error}</div>}
        <div className="modal-actions">
          {running ? (
            <button onClick={() => window.kadr.transcribeCancel()}>{t('cancel')}</button>
          ) : (
            <>
              <button onClick={close}>{t('cancel')}</button>
              <button className="primary" onClick={run}>{t('capRun')}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
