import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useEditor } from '@/state/store'
import { speakText, loadVoices, useTtsSettings, ttsTempo, sanitizeTtsSettings, TTS_MODELS } from '@/engine/tts'
import type { TtsVoice } from '@shared/types'
import { useT } from '@/i18n'
import { Icon } from './icons'
import { Modal } from './Modal'
import { useDefectsUi } from './DefectsDialog'
import { checkVoice, useVoiceUi } from '@/engine/voiceCheck'

type SpeakTarget = { kind: 'doc'; docId: string } | { kind: 'new' }

export const useTtsUi = create<{
  settingsOpen: boolean
  speak: SpeakTarget | null
  hasKey: boolean
  openSettings(): void
  closeSettings(): void
  openSpeak(t: SpeakTarget): void
  closeSpeak(): void
  setHasKey(v: boolean): void
}>((set) => ({
  settingsOpen: false,
  speak: null,
  hasKey: false,
  openSettings: () => set({ settingsOpen: true }),
  closeSettings: () => set({ settingsOpen: false }),
  openSpeak: (speak) => set({ speak }),
  closeSpeak: () => set({ speak: null }),
  setHasKey: (hasKey) => set({ hasKey })
}))

// the badge on texts appears only once a key exists, so the flag is refreshed
// on startup and after every key change
export function refreshTtsKey() {
  window.kadr.ttsHasKey().then((v) => useTtsUi.getState().setHasKey(v)).catch(() => { /* main not up */ })
}

function Slider({ label, value, min, max, step, onChange }: {
  label: string; value: number; min: number; max: number; step: number
  onChange(v: number): void
}) {
  // a settings file written by hand or by a script can hold anything; a slider
  // is never a reason for the editor to go white
  const v = Number.isFinite(value) ? value : min
  return (
    <label className="insp-field">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={v}
             onChange={(e) => onChange(parseFloat(e.target.value))} />
      <span className="dim" style={{ width: 34, textAlign: 'right' }}>{v.toFixed(2)}</span>
    </label>
  )
}

export function TtsSettingsDialog() {
  const t = useT()
  const open = useTtsUi((s) => s.settingsOpen)
  const hasKey = useTtsUi((s) => s.hasKey)
  const raw = useTtsSettings((s) => s.settings)
  const update = useTtsSettings((s) => s.update)
  const settings = raw && typeof raw === 'object' ? raw : sanitizeTtsSettings(null)
  const [key, setKey] = useState('')
  const [voices, setVoices] = useState<TtsVoice[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => { if (open) refreshTtsKey() }, [open])

  if (!open) return null

  async function saveKey(value: string) {
    setBusy(true); setError(''); setNote('')
    try {
      await window.kadr.ttsSetKey(value)
      setKey('')
      refreshTtsKey()
      setNote(value ? t('ttsKeySet') : t('ttsKeyNone'))
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally { setBusy(false) }
  }

  async function refreshVoices() {
    setBusy(true); setError(''); setNote('')
    try {
      const list = await loadVoices()
      setVoices(list)
      setNote(`${t('ttsTestOk')} ${list.length}`)
      if (!settings.voiceId && list.length) update({ voiceId: list[0].id })
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    } finally { setBusy(false) }
  }

  return (
    <Modal
      title={t('ttsTitle')}
      onClose={() => useTtsUi.getState().closeSettings()}
      titleIcon={<Icon name="settings" size={17} />}
      wide
      actions={
        <>
          <button disabled={busy} onClick={refreshVoices}>{t('ttsTest')}</button>
          <button className="primary" onClick={() => useTtsUi.getState().closeSettings()}>OK</button>
        </>
      }
    >

      <label className="insp-field">
        <span>{t('ttsKey')}</span>
        <input type="password" value={key} placeholder={t('ttsKeyPlaceholder')}
               onChange={(e) => setKey(e.target.value)} style={{ flex: 1 }} />
      </label>
      <div className="modal-actions" style={{ justifyContent: 'flex-start', gap: 8 }}>
        <button disabled={busy || !key.trim()} onClick={() => saveKey(key.trim())}>{t('ttsKeySave')}</button>
        <button disabled={busy || !hasKey} onClick={() => saveKey('')}>{t('ttsKeyClear')}</button>
        <span className={hasKey ? 'export-ok' : 'dim'}>
          {hasKey && <Icon name="check" size={14} />}
          {hasKey ? t('ttsKeySet') : t('ttsKeyNone')}
        </span>
      </div>
      <div className="dim hint-inline">{t('ttsKeyHint')}</div>

      <label className="insp-field">
        <span>{t('ttsVoice')}</span>
        {voices.length ? (
          <select value={settings.voiceId} onChange={(e) => update({ voiceId: e.target.value })} style={{ flex: 1 }}>
            {voices.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        ) : (
          <input value={settings.voiceId} placeholder="voice id"
                 onChange={(e) => update({ voiceId: e.target.value })} style={{ flex: 1 }} />
        )}
        <button disabled={busy} onClick={refreshVoices}>{t('ttsVoiceRefresh')}</button>
      </label>

      <label className="insp-field">
        <span>{t('ttsModel')}</span>
        <select value={settings.modelId} onChange={(e) => update({ modelId: e.target.value })} style={{ flex: 1 }}>
          {TTS_MODELS.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          {!TTS_MODELS.some((m) => m.id === settings.modelId) &&
            <option value={settings.modelId}>{settings.modelId}</option>}
        </select>
      </label>

      <Slider label={t('ttsStability')} value={settings.stability} min={0} max={1} step={0.05}
              onChange={(stability) => update({ stability })} />
      <Slider label={t('ttsSimilarity')} value={settings.similarityBoost} min={0} max={1} step={0.05}
              onChange={(similarityBoost) => update({ similarityBoost })} />
      <Slider label={t('ttsStyle')} value={settings.style ?? 0} min={0} max={1} step={0.05}
              onChange={(style) => update({ style })} />
      <Slider label={t('ttsSpeed')} value={settings.speed ?? 1} min={0.7} max={1.2} step={0.01}
              onChange={(speed) => update({ speed })} />
      <label className="insp-field">
        <span>{t('ttsSpeakerBoost')}</span>
        <input type="checkbox" checked={!!settings.speakerBoost}
               onChange={(e) => update({ speakerBoost: e.target.checked })} />
      </label>

      <label className="insp-field">
        <span>{t('ttsTempo')}</span>
        <input type="checkbox" checked={settings.tempoEnabled}
               onChange={(e) => update({ tempoEnabled: e.target.checked })} />
        <input type="number" min={0.5} max={2} step={0.05} value={settings.tempo}
               disabled={!settings.tempoEnabled} style={{ width: 70 }}
               onChange={(e) => update({ tempo: parseFloat(e.target.value) || 1 })} />
      </label>
      <div className="dim hint-inline">{t('ttsTempoHint')}</div>
      {settings.tempoEnabled && Math.abs(settings.tempo - 1) < 1e-6 && (
        <div className="tr-error">{t('dfTempoDead')}</div>
      )}

      <label className="insp-field">
        <span>{t('ttsDefectCheck')}</span>
        <input type="checkbox" checked={settings.defectCheck}
               onChange={(e) => update({ defectCheck: e.target.checked })} />
      </label>
      <label className="insp-field">
        <span>{t('ttsRegenOnConfirm')}</span>
        <input type="checkbox" checked={settings.regenerateOnConfirm}
               onChange={(e) => update({ regenerateOnConfirm: e.target.checked })} />
      </label>

      <label className="insp-field">
        <span>{t('ttsPython')}</span>
        <input value={settings.ttsqcPython} placeholder="python3.11"
               onChange={(e) => update({ ttsqcPython: e.target.value })} style={{ flex: 1 }} />
      </label>
      <div className="dim hint-inline">{t('ttsPythonHint')}</div>
      <label className="insp-field">
        <span>{t('ttsProxy')}</span>
        <input value={settings.proxy} placeholder="http://127.0.0.1:1080"
               onChange={(e) => update({ proxy: e.target.value })} style={{ flex: 1 }} />
      </label>
      <div className="dim hint-inline">{t('ttsProxyHint')}</div>

      {note && <div className="dim hint-inline">{note}</div>}
      {error && (
        <div className="tr-error"><Icon name="alert" size={15} /><span>{error}</span></div>
      )}
    </Modal>
  )
}

export function SpeakDialog() {
  const t = useT()
  const target = useTtsUi((s) => s.speak)
  const texts = useEditor((s) => s.project.texts ?? [])
  const rawSettings = useTtsSettings((s) => s.settings)
  const settings = rawSettings && typeof rawSettings === 'object' ? rawSettings : sanitizeTtsSettings(null)
  const [source, setSource] = useState<'doc' | 'file' | 'input'>('doc')
  const [docId, setDocId] = useState('')
  const [path, setPath] = useState('')
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(0)
  const [stage, setStage] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (target?.kind === 'doc') { setSource('doc'); setDocId(target.docId) }
    else if (target) setSource(texts.length ? 'doc' : 'input')
  }, [target])

  useEffect(() => {
    if (!running) return
    return window.kadr.onTtsProgress((p) => { setProgress(p.progress); setStage(p.stage) })
  }, [running])

  if (!target) return null

  const close = () => {
    if (running) return
    setError(''); setProgress(0); setStage('')
    useTtsUi.getState().closeSpeak()
  }

  async function pickFile() {
    const files = await window.kadr.openMediaDialog()
    const txt = files.find((f) => /\.(txt|srt)$/i.test(f))
    if (txt) { setPath(txt); setSource('file') }
  }

  async function run() {
    setRunning(true); setError(''); setProgress(0)
    try {
      const res = await speakText(
        source === 'doc' ? { textDocId: docId }
        : source === 'file' ? { path }
        : { text })
      setRunning(false)
      useTtsUi.getState().closeSpeak()
      // «искать дефекты после озвучки»: разбор идёт минутами и держит
      // видеокарту, поэтому он не запускается втихую — открываем окно разбора,
      // где видны стадии и есть «Прервать»
      if (settings.defectCheck) {
        useDefectsUi.getState().setOpen(true)
        checkVoice({ runId: res.runId }).catch((e) =>
          useVoiceUi.setState({ error: String((e as Error)?.message ?? e) }))
      }
    } catch (err) {
      setRunning(false)
      const msg = String((err as Error)?.message ?? err)
      if (msg !== 'cancelled') setError(msg)
    }
  }

  const ready = source === 'doc' ? !!docId : source === 'file' ? !!path : !!text.trim()
  const tempo = ttsTempo()

  return (
    <Modal
      title={t('ttsSpeakTitle')}
      onClose={close}
      titleIcon={<Icon name="speech" size={17} />}
      wide
      closeDisabled={running}
      actions={
        <>
          {running
            ? <button onClick={() => window.kadr.ttsCancel()}>{t('cancel')}</button>
            : <button onClick={close}>{t('cancel')}</button>}
          <button className="primary" disabled={running || !ready} onClick={run}>{t('ttsRun')}</button>
        </>
      }
    >

      <label className="insp-field">
        <span>{t('ttsSource')}</span>
        <select value={source} onChange={(e) => setSource(e.target.value as typeof source)} style={{ flex: 1 }}>
          <option value="doc" disabled={!texts.length}>{t('ttsSourceDoc')}</option>
          <option value="file">{t('ttsSourceFile')}</option>
          <option value="input">{t('ttsSourceInput')}</option>
        </select>
      </label>

      {source === 'doc' && (
        <label className="insp-field">
          <span> </span>
          <select value={docId} onChange={(e) => setDocId(e.target.value)} style={{ flex: 1 }}>
            <option value="">—</option>
            {texts.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
        </label>
      )}
      {source === 'file' && (
        <label className="insp-field">
          <span> </span>
          <input value={path} readOnly style={{ flex: 1 }} />
          <button onClick={pickFile}>…</button>
        </label>
      )}
      {source === 'input' && (
        <>
          <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8}
                    placeholder={t('ttsTextPlaceholder')}
                    style={{ width: '100%', resize: 'vertical' }} />
          <div className="dim hint-inline">{text.length} {t('ttsChars')}</div>
        </>
      )}

      <div className="dim hint-inline">
        {settings.voiceId || '—'} · {settings.modelId}
        {tempo !== 1 && ` · ×${tempo}`}
      </div>
      <div className="dim hint-inline">{t('ttsHint')}</div>

      {running && (
        <div className="export-progress">
          <progress value={progress} max={1} />
          <span>{stage === 'assemble' ? t('ttsAssembling') : t('ttsWorking')} {Math.round(progress * 100)}%</span>
        </div>
      )}
      {error && (
        <div className="tr-error"><Icon name="alert" size={15} /><span>{error}</span></div>
      )}
    </Modal>
  )
}
