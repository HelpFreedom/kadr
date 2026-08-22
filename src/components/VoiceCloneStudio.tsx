import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type {
  VoiceClonePreview,
  VoiceCloneProcessingOptions,
  VoiceoverCustomVoice
} from '@shared/types'
import { baseOf } from '@shared/paths'
import { preferredVoiceMime } from '@/engine/voice'
import { useEditor } from '@/state/store'

const DEFAULT_PROCESSING: VoiceCloneProcessingOptions = {
  normalization: { enabled: true, targetLufs: -18 },
  noiseReduction: { enabled: false, strength: 0.5 },
  compressor: { enabled: false, thresholdDb: -18, ratio: 3 }
}

function Preview({ title, preview }: { title: string; preview: VoiceClonePreview }) {
  const [ready, setReady] = useState(false)
  const [failed, setFailed] = useState(false)
  const src = `${window.kadr.fileUrl(preview.path)}?voice-preview=${encodeURIComponent(`${preview.path}:${preview.duration}`)}`

  useEffect(() => {
    setReady(false)
    setFailed(false)
  }, [src])

  return (
    <div className={`clone-preview${ready ? ' ready' : ' loading'}`}>
      <div><b>{title}</b><span>{preview.duration.toFixed(1)} с</span></div>
      <div className="clone-preview-player">
        {!ready && !failed && <span className="clone-preview-loading"><i />Подготавливаю полное аудио…</span>}
        {failed && <span className="clone-preview-failed">Не удалось загрузить аудио целиком</span>}
        <audio key={src} controls preload="auto" src={src}
          onCanPlayThrough={() => setReady(true)}
          onError={() => setFailed(true)} />
      </div>
    </div>
  )
}

export function VoiceCloneStudio({
  open,
  onClose,
  onCreated,
  ru,
  editVoice
}: {
  open: boolean
  onClose: () => void
  onCreated: (voice: VoiceoverCustomVoice) => void
  ru: boolean
  editVoice?: VoiceoverCustomVoice
}) {
  const [source, setSource] = useState<'file' | 'microphone'>('file')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [recording, setRecording] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [original, setOriginal] = useState<VoiceClonePreview | null>(null)
  const [processed, setProcessed] = useState<VoiceClonePreview | null>(null)
  const [sourceLabel, setSourceLabel] = useState('')
  const [options, setOptions] = useState<VoiceCloneProcessingOptions>(DEFAULT_PROCESSING)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [referenceText, setReferenceText] = useState('')
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const startedRef = useRef(0)
  const meterBarRef = useRef<HTMLElement | null>(null)
  const temporaryPathsRef = useRef(new Set<string>())
  const streamRef = useRef<MediaStream | null>(null)
  const closingRef = useRef(false)

  const rememberTemporary = (preview: VoiceClonePreview) => {
    temporaryPathsRef.current.add(preview.path)
    return preview
  }

  const discardPreviews = (...previews: (VoiceClonePreview | null)[]) => {
    const paths = previews.filter((item): item is VoiceClonePreview => !!item)
      .map((item) => item.path)
    for (const path of paths) temporaryPathsRef.current.delete(path)
    if (paths.length) void window.kadr.voiceCloneDiscard(paths)
  }

  useEffect(() => {
    closingRef.current = false
    return () => {
      closingRef.current = true
      try {
        if (recorderRef.current?.state !== 'inactive') recorderRef.current?.stop()
      } catch { /* recorder already stopped */ }
      streamRef.current?.getTracks().forEach((track) => track.stop())
      const paths = [...temporaryPathsRef.current]
      if (paths.length) void window.kadr.voiceCloneDiscard(paths)
      temporaryPathsRef.current.clear()
    }
  }, [])

  useEffect(() => { streamRef.current = stream }, [stream])

  useEffect(() => {
    if (!open || !editVoice) return
    let cancelled = false
    setSource('file')
    setName(editVoice.name)
    setDescription(editVoice.description ?? '')
    setReferenceText(editVoice.referenceText)
    setSourceLabel(editVoice.sourceLabel ?? editVoice.name)
    setBusy(true)
    setStatus(ru ? 'Загружаю сохранённый референс…' : 'Loading saved reference…')
    void window.kadr.voiceClonePrepare(editVoice.referencePath).then((result) => {
      if (cancelled) {
        void window.kadr.voiceCloneDiscard([result.path])
        return
      }
      const preview = rememberTemporary(result)
      setOriginal(preview)
      setProcessed(preview)
      setStatus(editVoice.referenceText
        ? (ru ? 'Можно изменить описание или заменить исходник' : 'Edit details or replace the source')
        : (ru ? 'У этого голоса нет подтверждённого текста. Замените исходник или введите точный текст записи.' : 'This voice has no confirmed text. Replace the source or enter the exact recording text.'))
    }).catch((cause) => {
      setError(String(cause instanceof Error ? cause.message : cause))
      setStatus('')
    }).finally(() => { if (!cancelled) setBusy(false) })
    return () => { cancelled = true }
  }, [open, editVoice?.id, ru])

  useEffect(() => {
    if (!open || source !== 'microphone') return
    let cancelled = false
    let acquired: MediaStream | null = null
    void navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        autoGainControl: false,
        noiseSuppression: false
      },
      video: false
    }).then(async (next) => {
      if (cancelled) {
        next.getTracks().forEach((track) => track.stop())
        return
      }
      acquired = next
      setStream((previous) => {
        previous?.getTracks().forEach((track) => track.stop())
        return next
      })
      const inputs = (await navigator.mediaDevices.enumerateDevices())
        .filter((device) => device.kind === 'audioinput')
      setDevices(inputs)
      if (!deviceId) setDeviceId(next.getAudioTracks()[0]?.getSettings().deviceId || inputs[0]?.deviceId || '')
    }).catch((cause) => setError(
      ru ? `Нет доступа к микрофону: ${String(cause)}` : `Microphone unavailable: ${String(cause)}`
    ))
    return () => {
      cancelled = true
      acquired?.getTracks().forEach((track) => track.stop())
    }
  }, [open, source, deviceId, ru])

  useEffect(() => {
    if (!open || source !== 'microphone' || !stream) return
    const context = new AudioContext()
    const analyser = context.createAnalyser()
    analyser.fftSize = 1024
    context.createMediaStreamSource(stream).connect(analyser)
    const data = new Float32Array(analyser.fftSize)
    let frame = 0
    let lastPaint = 0
    let smoothedDb = -60
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick)
      if (now - lastPaint < 33) return
      lastPaint = now
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (const sample of data) sum += sample * sample
      const rms = Math.sqrt(sum / data.length)
      const nextDb = Math.max(-60, Math.min(0, 20 * Math.log10(rms || 0.001)))
      smoothedDb += (nextDb - smoothedDb) * (nextDb > smoothedDb ? 0.72 : 0.28)
      const meter = Math.max(0, Math.min(1, (smoothedDb + 60) / 60))
      if (meterBarRef.current) meterBarRef.current.style.transform = `scaleX(${meter})`
    }
    frame = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(frame)
      void context.close()
    }
  }, [open, source, stream])

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setElapsed((performance.now() - startedRef.current) / 1000), 100)
    return () => clearInterval(timer)
  }, [recording])

  useEffect(() => {
    if (!open) {
      recorderRef.current?.state !== 'inactive' && recorderRef.current?.stop()
      setRecording(false)
      setStream((current) => {
        current?.getTracks().forEach((track) => track.stop())
        return null
      })
    }
  }, [open])

  useEffect(() => {
    if (!processed || processed === original) return
    discardPreviews(processed)
    setProcessed(null)
  }, [options])

  const changeSource = (next: 'file' | 'microphone') => {
    if (next === source) return
    discardPreviews(original, processed === original ? null : processed)
    setOriginal(null)
    setProcessed(null)
    setReferenceText('')
    setSourceLabel('')
    setStatus('')
    setError('')
    setElapsed(0)
    setSource(next)
  }

  const prepare = async (path: string, label: string) => {
    setBusy(true)
    setError('')
    setStatus(ru ? 'Готовлю исходник…' : 'Preparing source…')
    try {
      const result = await window.kadr.voiceClonePrepare(path)
      discardPreviews(original, processed === original ? null : processed)
      setOriginal(rememberTemporary(result))
      setProcessed(null)
      setReferenceText('')
      setSourceLabel(label)
      if (!name) setName(label.replace(/\.[^.]+$/, '').slice(0, 80))
      setStatus('')
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const chooseFile = async () => {
    const path = await window.kadr.voiceClonePickFile()
    if (path) await prepare(path, baseOf(path))
  }

  const startRecording = () => {
    if (!stream || recording || busy) return
    setError('')
    setStatus('')
    const { mime } = preferredVoiceMime()
    try {
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 192_000 } : undefined)
      chunksRef.current = []
      recorder.ondataavailable = (event) => { if (event.data.size) chunksRef.current.push(event.data) }
      recorder.onstop = () => {
        if (closingRef.current) {
          chunksRef.current = []
          return
        }
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mime || 'audio/webm' })
        if (!blob.size) {
          setError(ru ? 'Запись пуста' : 'The recording is empty')
          return
        }
        setBusy(true)
        void blob.arrayBuffer().then(async (data) => {
          const extension = preferredVoiceMime().extension
          const path = await window.kadr.saveBlobMedia(
            `voice-clone-${Date.now()}.${extension}`,
            blob.type,
            new Uint8Array(data)
          )
          const device = devices.find((item) => item.deviceId === deviceId)
          await prepare(path, device?.label || (ru ? 'Запись голоса' : 'Voice recording'))
        }).catch((cause) => setError(String(cause))).finally(() => setBusy(false))
      }
      recorderRef.current = recorder
      startedRef.current = performance.now()
      setElapsed(0)
      recorder.start(250)
      setRecording(true)
    } catch (cause) {
      setError(String(cause))
    }
  }

  const stopRecording = () => {
    if (!recording) return
    setRecording(false)
    recorderRef.current?.stop()
  }

  const execute = async () => {
    if (!original || busy) return
    setBusy(true)
    setError('')
    setStatus(ru ? 'Обрабатываю голос…' : 'Processing voice…')
    try {
      const result = rememberTemporary(await window.kadr.voiceCloneProcess(original.path, options))
      if (processed && processed !== original) discardPreviews(processed)
      setProcessed(result)
      setStatus(ru ? 'Распознаю точный текст референса…' : 'Transcribing the exact reference text…')
      try {
        const transcript = await window.kadr.voiceCloneTranscribe(result.path)
        setReferenceText(transcript)
        setStatus(ru ? 'Проверьте распознанный текст и звук до/после' : 'Check the transcript and before/after audio')
      } catch (cause) {
        setError(String(cause instanceof Error ? cause.message : cause))
        setStatus(ru ? 'Введите точный текст записи вручную' : 'Enter the exact recording text manually')
      }
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const recognize = async () => {
    if (!processed || busy) return
    setBusy(true)
    setError('')
    setStatus(ru ? 'Распознаю точный текст референса…' : 'Transcribing the exact reference text…')
    try {
      setReferenceText(await window.kadr.voiceCloneTranscribe(processed.path))
      setStatus(ru ? 'Проверьте распознанный текст перед сохранением' : 'Check the transcript before saving')
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const save = async () => {
    if (!processed || !name.trim() || !referenceText.trim() || busy) return
    setBusy(true)
    setError('')
    setStatus(ru ? 'Сохраняю клон…' : 'Saving clone…')
    try {
      const voice = await window.kadr.voiceCloneSave({
        voiceId: editVoice?.id,
        processedPath: processed.path,
        name,
        description,
        referenceText,
        source,
        sourceLabel
      })
      const state = useEditor.getState()
      state.pushHistory('hVoiceClone')
      useEditor.setState({
        project: {
          ...state.project,
          voiceClones: [...(state.project.voiceClones ?? []).filter((item) => item.id !== voice.id), voice]
        }
      })
      onCreated(voice)
      onClose()
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  return createPortal(
    <div className="modal-back clone-back"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation()
        if (!recording && !busy) onClose()
      }}>
      <div className="modal clone-studio" onClick={(event) => event.stopPropagation()}>
        <div className="clone-head">
          <div><h2>{editVoice
            ? (ru ? 'Редактирование голоса' : 'Edit voice')
            : (ru ? 'Клонирование голоса' : 'Voice cloning')}</h2><span>F5‑TTS</span></div>
          <button disabled={recording || busy} onClick={onClose}>✕</button>
        </div>

        <div className="clone-source-tabs">
          <button className={source === 'file' ? 'active' : ''} disabled={recording || busy}
            onClick={() => changeSource('file')}>{ru ? 'Из файла' : 'From file'}</button>
          <button className={source === 'microphone' ? 'active' : ''} disabled={recording || busy}
            onClick={() => changeSource('microphone')}>{ru ? 'Записать голос' : 'Record voice'}</button>
        </div>

        <div className="clone-scroll">
          {source === 'file' ? (
            <button className="clone-pick" disabled={busy} onClick={() => void chooseFile()}>
              {original ? (ru ? 'Выбрать другой файл' : 'Choose another file') : (ru ? 'Выбрать аудиофайл' : 'Choose audio file')}
            </button>
          ) : (
            <div className="clone-record-box">
              <label className="mic-field"><span>{ru ? 'Источник записи' : 'Recording source'}</span>
                <select value={deviceId} disabled={recording || busy} onChange={(event) => setDeviceId(event.target.value)}>
                  {devices.map((device, index) => <option key={device.deviceId} value={device.deviceId}>
                    {device.label || `${ru ? 'Микрофон' : 'Microphone'} ${index + 1}`}
                  </option>)}
                </select>
              </label>
              <div className="clone-meter"><i ref={meterBarRef} /></div>
              <div className="clone-record-row">
                {!recording
                  ? <button className="mic-record" disabled={!stream || busy} onClick={startRecording}>● {ru ? 'Запись' : 'Record'}</button>
                  : <button className="mic-stop" onClick={stopRecording}>■ {ru ? 'Стоп' : 'Stop'}</button>}
                <strong>{elapsed.toFixed(1)} с</strong>
              </div>
            </div>
          )}

          {original && <Preview title={ru ? 'До обработки' : 'Before processing'} preview={original} />}

          {original && <div className="clone-options">
            <h3>{ru ? 'Обработка' : 'Processing'}</h3>
            <label className="clone-option">
              <input type="checkbox" checked={options.normalization.enabled} disabled={busy}
                onChange={(event) => setOptions((old) => ({ ...old, normalization: { ...old.normalization, enabled: event.target.checked } }))} />
              <span><b>{ru ? 'Нормализация' : 'Normalization'}</b><small>{ru ? 'Выравнивает общую громкость' : 'Balances overall loudness'}</small></span>
              <select value={options.normalization.targetLufs} disabled={busy || !options.normalization.enabled}
                onChange={(event) => setOptions((old) => ({ ...old, normalization: { ...old.normalization, targetLufs: Number(event.target.value) } }))}>
                <option value={-20}>−20 LUFS</option><option value={-18}>−18 LUFS</option>
                <option value={-16}>−16 LUFS</option><option value={-14}>−14 LUFS</option>
              </select>
            </label>
            <label className="clone-option">
              <input type="checkbox" checked={options.noiseReduction.enabled} disabled={busy}
                onChange={(event) => setOptions((old) => ({ ...old, noiseReduction: { ...old.noiseReduction, enabled: event.target.checked } }))} />
              <span><b>{ru ? 'Удаление шума' : 'Noise reduction'}</b><small>{ru ? 'Убирает постоянный фоновый шум' : 'Reduces steady background noise'}</small></span>
              <select value={options.noiseReduction.strength} disabled={busy || !options.noiseReduction.enabled}
                onChange={(event) => setOptions((old) => ({ ...old, noiseReduction: { ...old.noiseReduction, strength: Number(event.target.value) } }))}>
                <option value={0.25}>{ru ? 'Лёгкое' : 'Light'}</option><option value={0.5}>{ru ? 'Среднее' : 'Medium'}</option>
                <option value={0.8}>{ru ? 'Сильное' : 'Strong'}</option>
              </select>
            </label>
            <label className="clone-option">
              <input type="checkbox" checked={options.compressor.enabled} disabled={busy}
                onChange={(event) => setOptions((old) => ({ ...old, compressor: { ...old.compressor, enabled: event.target.checked } }))} />
              <span><b>{ru ? 'Компрессор' : 'Compressor'}</b><small>{ru ? 'Смягчает перепады громкости' : 'Controls volume peaks'}</small></span>
              <select value={options.compressor.ratio} disabled={busy || !options.compressor.enabled}
                onChange={(event) => setOptions((old) => ({ ...old, compressor: { ...old.compressor, ratio: Number(event.target.value) } }))}>
                <option value={2}>2:1</option><option value={3}>3:1</option><option value={4}>4:1</option><option value={6}>6:1</option>
              </select>
            </label>
            <button className="primary clone-execute" disabled={busy} onClick={() => void execute()}>
              {busy ? (ru ? 'Обработка…' : 'Processing…') : (ru ? 'Выполнить' : 'Apply')}
            </button>
          </div>}

          {processed && <Preview title={ru ? 'После обработки' : 'After processing'} preview={processed} />}

          {processed && <div className="clone-meta">
            <label><span>{ru ? 'Название голоса' : 'Voice name'}</span>
              <input value={name} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder={ru ? 'Например, Мой голос' : 'For example, My voice'} />
            </label>
            <label><span>{ru ? 'Описание' : 'Description'}</span>
              <input value={description} maxLength={240} onChange={(event) => setDescription(event.target.value)} placeholder={ru ? 'Спокойный, уверенный…' : 'Calm, confident…'} />
            </label>
            <label><span>{ru ? 'Точный текст записи (обязательно)' : 'Exact recording text (required)'}</span>
              <textarea rows={3} value={referenceText} onChange={(event) => setReferenceText(event.target.value)}
                placeholder={ru ? 'Проверьте автоматически распознанный текст — он должен дословно совпадать с записью.' : 'Check the automatic transcript; it must exactly match the recording.'} />
            </label>
            <button className="clone-transcribe" disabled={busy} onClick={() => void recognize()}>
              ↻ {ru ? 'Распознать текст заново' : 'Transcribe again'}
            </button>
            <p>{ru ? 'Лучше всего работает чистая запись одной речи длиной 3–15 секунд. Точный текст защищает от повторения фраз из референса.' : 'A clean 3–15 second speech sample works best. An exact transcript prevents reference phrases from being repeated.'}</p>
            <button className="primary clone-save" disabled={busy || !name.trim() || !referenceText.trim()} onClick={() => void save()}>
              {editVoice ? (ru ? 'Сохранить изменения' : 'Save changes') : (ru ? 'Сделать клон' : 'Create clone')}
            </button>
          </div>}
          {(status || error) && <div className={error ? 'clone-status error' : `clone-status${busy ? ' busy' : ''}`}>
            {busy && <i className="clone-status-spinner" />}{error || status}
          </div>}
        </div>
      </div>
    </div>,
    document.body
  )
}
