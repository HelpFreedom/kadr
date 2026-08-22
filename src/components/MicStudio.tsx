import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  VoiceEffectProfile,
  VoiceoverCustomVoice,
  VoiceoverStatus,
  VoiceoverVersion
} from '@shared/types'
import {
  DEFAULT_VOICEOVER_SETTINGS,
  mergeVoiceChoices
} from '@shared/voiceover'
import { useEditor, useSettings, findClip } from '@/state/store'
import { importFiles } from '@/engine/mediaImport'
import { normalizeClip } from '@/engine/normalize'
import { transcribeFlow } from '@/engine/subtitles'
import { analyseVoiceRanges, preferredVoiceMime } from '@/engine/voice'
import { VoiceoverSetup } from './VoiceoverStudio'
import { VoiceCloneStudio } from './VoiceCloneStudio'
import { VoiceLibraryStudio } from './VoiceLibraryStudio'

type Tab = 'record' | 'leveling' | 'noise' | 'compressor' | 'delay' | 'cut' | 'subtitles' | 'regenerate'

const DEFAULT_FX: VoiceEffectProfile = {
  inputGain: 1,
  leveling: { enabled: true, targetLufs: -14 },
  noiseReduction: { enabled: true, highPassHz: 75 },
  compressor: { enabled: false, threshold: -18, ratio: 3, attack: 0.01, release: 0.2 },
  delay: { enabled: false, time: 0.18, feedback: 0.2, mix: 0.12 }
}

interface AudioGraph {
  context: AudioContext
  analyser: AnalyserNode
  destination: MediaStreamAudioDestinationNode
  close(): void
}

function makeGraph(stream: MediaStream, fx: VoiceEffectProfile): AudioGraph {
  const context = new AudioContext()
  const source = context.createMediaStreamSource(stream)
  const input = context.createGain()
  input.gain.value = fx.inputGain
  source.connect(input)
  let tail: AudioNode = input

  if (fx.noiseReduction.enabled && fx.noiseReduction.highPassHz > 0) {
    const highPass = context.createBiquadFilter()
    highPass.type = 'highpass'
    highPass.frequency.value = fx.noiseReduction.highPassHz
    highPass.Q.value = 0.7
    tail.connect(highPass)
    tail = highPass
  }
  if (fx.compressor.enabled) {
    const compressor = context.createDynamicsCompressor()
    compressor.threshold.value = fx.compressor.threshold
    compressor.knee.value = 12
    compressor.ratio.value = fx.compressor.ratio
    compressor.attack.value = fx.compressor.attack
    compressor.release.value = fx.compressor.release
    tail.connect(compressor)
    tail = compressor
  }

  const bus = context.createGain()
  if (fx.delay.enabled && fx.delay.mix > 0) {
    const dry = context.createGain()
    const wet = context.createGain()
    const delay = context.createDelay(2)
    const feedback = context.createGain()
    dry.gain.value = 1 - fx.delay.mix
    wet.gain.value = fx.delay.mix
    delay.delayTime.value = fx.delay.time
    feedback.gain.value = fx.delay.feedback
    tail.connect(dry).connect(bus)
    tail.connect(delay)
    delay.connect(wet).connect(bus)
    delay.connect(feedback).connect(delay)
  } else {
    tail.connect(bus)
  }

  const analyser = context.createAnalyser()
  analyser.fftSize = 1024
  analyser.smoothingTimeConstant = 0.68
  const destination = context.createMediaStreamDestination()
  bus.connect(analyser)
  analyser.connect(destination)
  return {
    context,
    analyser,
    destination,
    close: () => {
      try { source.disconnect() } catch { /* already gone */ }
      void context.close()
    }
  }
}

function slider(
  label: string, value: number, set: (value: number) => void,
  min: number, max: number, step: number, suffix = ''
) {
  return (
    <label className="mic-slider">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => set(Number(e.target.value))} />
      <b>{value}{suffix}</b>
    </label>
  )
}

export function MicStudio({ open, onClose }: { open: boolean; onClose: () => void }) {
  const lang = useSettings((s) => s.lang)
  const ru = lang === 'ru'
  const [tab, setTab] = useState<Tab>('record')
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const [deviceId, setDeviceId] = useState('')
  const [stream, setStream] = useState<MediaStream | null>(null)
  const [fx, setFx] = useState<VoiceEffectProfile>(DEFAULT_FX)
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [levelDb, setLevelDb] = useState(-60)
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [autoCut, setAutoCut] = useState(true)
  const [silenceSeconds, setSilenceSeconds] = useState(0.8)
  const [minChunkSeconds, setMinChunkSeconds] = useState(2)
  const [maxChunkSeconds, setMaxChunkSeconds] = useState(24)
  const [thresholdDb, setThresholdDb] = useState(-42)
  const [knownText, setKnownText] = useState('')
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICEOVER_SETTINGS.voiceId)
  const [language, setLanguage] = useState('auto')
  const [currentAssetId, setCurrentAssetId] = useState<string | null>(null)
  const [currentClipId, setCurrentClipId] = useState<string | null>(null)
  const [generatedClipId, setGeneratedClipId] = useState<string | null>(null)
  const [ttsStatus, setTtsStatus] = useState<VoiceoverStatus | null>(null)
  const [globalVoices, setGlobalVoices] = useState<VoiceoverCustomVoice[]>([])
  const [cloneOpen, setCloneOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [editVoice, setEditVoice] = useState<VoiceoverCustomVoice | undefined>()
  const projectPath = useEditor((s) => s.projectPath)
  const projectVoices = useEditor((s) => s.project.voiceClones ?? [])
  const graphRef = useRef<AudioGraph | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const rawRecorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<BlobPart[]>([])
  const rawChunksRef = useRef<BlobPart[]>([])
  const startedAtRef = useRef(0)
  const timelineStartRef = useRef(0)
  const voices = useMemo(() => mergeVoiceChoices([...globalVoices, ...projectVoices]), [globalVoices, projectVoices])
  const customVoices = useMemo(() => voices.flatMap((voice) => voice.customVoice ? [voice.customVoice] : []), [voices])
  const selectedVoice = voices.find((voice) => voice.id === voiceId) ?? voices[0]

  const tabs = useMemo(() => ([
    ['record', ru ? 'Запись' : 'Record'],
    ['leveling', ru ? 'Выравнивание' : 'Leveling'],
    ['noise', ru ? 'Шум' : 'Noise'],
    ['compressor', ru ? 'Компрессор' : 'Compressor'],
    ['delay', ru ? 'Дилей' : 'Delay'],
    ['cut', ru ? 'Автонарезка' : 'Auto-cut'],
    ['subtitles', ru ? 'Субтитры' : 'Subtitles'],
    ['regenerate', ru ? 'Перегенерация' : 'Regenerate']
  ] as [Tab, string][]), [ru])

  useEffect(() => {
    if (!open) return
    let current = true
    setTtsStatus(null)
    void window.kadr.voiceoverStatus(DEFAULT_VOICEOVER_SETTINGS).then((result) => {
      if (current) setTtsStatus(result)
    }).catch((err) => {
      if (current) setTtsStatus({
        ready: false,
        reason: String(err),
        configPath: '~/.config/kadr/tts.json'
      })
    })
    return () => { current = false }
  }, [open])

  useEffect(() => {
    if (!open) return
    void window.kadr.voiceCloneList().then(setGlobalVoices).catch(() => setGlobalVoices([]))
  }, [open])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    let acquired: MediaStream | null = null
    const acquire = async () => {
      setError('')
      try {
        const next = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
            channelCount: 1,
            echoCancellation: false,
            autoGainControl: false,
            noiseSuppression: fx.noiseReduction.enabled
          },
          video: false
        })
        if (cancelled) {
          next.getTracks().forEach((track) => track.stop())
          return
        }
        acquired = next
        setStream((old) => {
          old?.getTracks().forEach((track) => track.stop())
          return next
        })
        const all = await navigator.mediaDevices.enumerateDevices()
        const inputs = all.filter((d) => d.kind === 'audioinput')
        setDevices(inputs)
        if (!deviceId) setDeviceId(next.getAudioTracks()[0]?.getSettings().deviceId || inputs[0]?.deviceId || '')
      } catch (err) {
        setError(ru ? `Нет доступа к микрофону: ${String(err)}` : `Microphone unavailable: ${String(err)}`)
      }
    }
    void acquire()
    return () => {
      cancelled = true
      acquired?.getTracks().forEach((track) => track.stop())
    }
    // Noise suppression is a capture constraint and requires a fresh stream.
  }, [open, deviceId, fx.noiseReduction.enabled, ru])

  useEffect(() => {
    if (!open || !stream) return
    graphRef.current?.close()
    graphRef.current = makeGraph(stream, fx)
    return () => {
      graphRef.current?.close()
      graphRef.current = null
    }
  }, [open, stream, fx])

  useEffect(() => {
    if (!open) return
    let raf = 0
    let last = 0
    const data = new Float32Array(1024)
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick)
      if (now - last < 70) return
      last = now
      const analyser = graphRef.current?.analyser
      if (!analyser) return
      analyser.getFloatTimeDomainData(data)
      let sum = 0
      for (const v of data) sum += v * v
      const rms = Math.sqrt(sum / data.length)
      setLevelDb(Math.max(-60, Math.min(0, 20 * Math.log10(rms || 0.001))))
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [open])

  useEffect(() => {
    if (!recording) return
    const timer = setInterval(() => setElapsed((performance.now() - startedAtRef.current) / 1000), 100)
    return () => clearInterval(timer)
  }, [recording])

  useEffect(() => () => {
    graphRef.current?.close()
    stream?.getTracks().forEach((track) => track.stop())
  }, [stream])

  const patchFx = <K extends keyof VoiceEffectProfile>(key: K, value: VoiceEffectProfile[K]) => {
    if (recording) return
    setFx((old) => ({ ...old, [key]: value }))
  }

  const startRecording = async () => {
    if (!stream || !graphRef.current || recording || busy) return
    setError('')
    setStatus('')
    const { mime } = preferredVoiceMime()
    try {
      await graphRef.current.context.resume()
      const options = mime ? { mimeType: mime, audioBitsPerSecond: 192_000 } : undefined
      const recorder = new MediaRecorder(graphRef.current.destination.stream, options)
      chunksRef.current = []
      recorder.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data) }
      recorderRef.current = recorder

      const realtimeFx = Math.abs(fx.inputGain - 1) > 0.001 || fx.noiseReduction.enabled ||
        fx.compressor.enabled || fx.delay.enabled
      if (realtimeFx) {
        const raw = new MediaRecorder(stream, options)
        rawChunksRef.current = []
        raw.ondataavailable = (e) => { if (e.data.size) rawChunksRef.current.push(e.data) }
        rawRecorderRef.current = raw
        raw.start(250)
      }
      timelineStartRef.current = useEditor.getState().playhead
      startedAtRef.current = performance.now()
      setElapsed(0)
      recorder.start(250)
      setRecording(true)
      useEditor.getState().setPlaying(true)
    } catch (err) {
      setError(String(err))
    }
  }

  const stopOne = (recorder: MediaRecorder | null, chunks: BlobPart[]) => new Promise<Blob>((resolve) => {
    if (!recorder || recorder.state === 'inactive') {
      resolve(new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' }))
      return
    }
    recorder.addEventListener('stop', () => resolve(new Blob(chunks, { type: recorder.mimeType })), { once: true })
    recorder.stop()
  })

  const stopRecording = async () => {
    if (!recording || busy) return
    // MediaRecorder's WebM output has no container duration in Chromium.
    // Keep the wall-clock duration so the imported clip is playable even
    // when ffprobe reports duration=N/A for an otherwise valid Opus stream.
    const recordedDuration = Math.max(0.05, (performance.now() - startedAtRef.current) / 1000)
    setRecording(false)
    setElapsed(recordedDuration)
    setBusy(true)
    useEditor.getState().setPlaying(false)
    setStatus(ru ? 'Сохраняю дубль…' : 'Saving take…')
    try {
      const [blob, rawBlob] = await Promise.all([
        stopOne(recorderRef.current, chunksRef.current),
        stopOne(rawRecorderRef.current, rawChunksRef.current)
      ])
      recorderRef.current = null
      rawRecorderRef.current = null
      if (!blob.size) throw new Error(ru ? 'Запись пуста' : 'The recording is empty')
      const { extension } = preferredVoiceMime()
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      let rawPath: string | undefined
      if (rawBlob.size) {
        rawPath = await window.kadr.saveBlobMedia(
          `mic-${stamp}-raw.${extension}`, rawBlob.type,
          new Uint8Array(await rawBlob.arrayBuffer())
        )
      }
      const path = await window.kadr.saveBlobMedia(
        `mic-${stamp}.${extension}`, blob.type,
        new Uint8Array(await blob.arrayBuffer())
      )
      if (!useEditor.getState().project.tracks.some((t) => t.kind === 'audio' && !t.locked)) {
        useEditor.getState().addTrack('audio')
      }
      const assetIds = await importFiles([path], { trackId: null, at: timelineStartRef.current })
      const assetId = assetIds[0]
      if (!assetId) throw new Error(ru ? 'Не удалось добавить запись в проект' : 'Could not add the recording')
      const st = useEditor.getState()
      st.updateAsset(assetId, {
        duration: recordedDuration,
        voice: {
          source: 'microphone',
          recordedAt: new Date().toISOString(),
          deviceLabel: stream?.getAudioTracks()[0]?.label,
          rawPath,
          effects: fx,
          knownText: knownText.trim() || undefined
        }
      })
      setCurrentAssetId(assetId)
      const warnings: string[] = []
      let clip = st.project.tracks.flatMap((t) => t.clips)
        .find((c) => c.assetId === assetId && Math.abs(c.start - timelineStartRef.current) < 0.05)
      if (clip) {
        st.updateClip(clip.id, { duration: recordedDuration })
        clip = findClip(useEditor.getState().project, clip.id)?.clip
        setCurrentClipId(clip?.id ?? null)
      }
      if (clip && fx.leveling.enabled) {
        setStatus(ru ? 'Выравниваю громкость…' : 'Leveling loudness…')
        try {
          await normalizeClip(clip.id, { targetLufs: fx.leveling.targetLufs })
          clip = findClip(useEditor.getState().project, clip.id)?.clip
        } catch (err) {
          warnings.push(`${ru ? 'выравнивание' : 'leveling'}: ${String(err)}`)
        }
      }
      if (clip && autoCut) {
        setStatus(ru ? 'Ищу длинные паузы…' : 'Finding long pauses…')
        const decode = new AudioContext()
        try {
          const buffer = await decode.decodeAudioData(await blob.arrayBuffer())
          const ranges = analyseVoiceRanges(buffer, {
            silenceSeconds, minChunkSeconds, maxChunkSeconds, thresholdDb
          })
          const materiallyCut = ranges.length > 1 || ranges.some((r) => r.start > 0.05 || r.end < buffer.duration - 0.05)
          if (materiallyCut) {
            const ids = useEditor.getState().splitClipIntoRanges(clip.id, ranges)
            if (ids[0]) setCurrentClipId(ids[0])
          }
        } catch (err) {
          warnings.push(`${ru ? 'автонарезка' : 'auto-cut'}: ${String(err)}`)
        } finally {
          void decode.close()
        }
      }
      setStatus(warnings.length
        ? `${ru ? 'Дубль сохранён, предупреждение' : 'Take saved, warning'} — ${warnings.join('; ')}`
        : (ru ? 'Дубль добавлен на таймлайн' : 'Take added to the timeline'))
    } catch (err) {
      setError(String(err))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const makeSubtitles = async () => {
    if (!currentAssetId || busy) return
    setBusy(true)
    setError('')
    setStatus(ru ? 'Распознаю речь…' : 'Transcribing…')
    try {
      const result = await transcribeFlow({
        target: { kind: 'asset', assetId: currentAssetId },
        language,
        maxWords: 3
      })
      setStatus(ru ? `Готово: ${result.doc.name}` : `Ready: ${result.doc.name}`)
    } catch (err) {
      setError(String(err))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async () => {
    if (!knownText.trim() || busy || !ttsStatus?.ready) return
    setBusy(true)
    setError('')
    setStatus(ru ? 'Нейросеть генерирует голос…' : 'Generating neural speech…')
    try {
      const generationSettings = {
        ...DEFAULT_VOICEOVER_SETTINGS,
        voiceId,
        customVoice: selectedVoice?.customVoice
      }
      const existing = generatedClipId
        ? findClip(useEditor.getState().project, generatedClipId)?.clip
        : null
      const previousVersions = existing?.voiceover?.versions ?? []
      const versionNumber = Math.max(0, ...previousVersions.map((v) => v.number)) + 1
      const jobClipId = generatedClipId || currentClipId || `mic-${Date.now()}`
      const generated = await window.kadr.voiceoverGenerate({
        clipId: jobClipId,
        projectPath,
        version: versionNumber,
        text: knownText.trim(),
        settings: generationSettings
      })
      const probe = await window.kadr.probeMedia(generated.path)
      const takeSettings = { ...generationSettings, seed: generated.seed }
      let assetId: string
      let targetClipId = generatedClipId

      if (!targetClipId || !existing) {
        if (!useEditor.getState().project.tracks.some((t) => t.kind === 'audio' && !t.locked)) {
          useEditor.getState().addTrack('audio')
        }
        const at = currentAssetId ? timelineStartRef.current : useEditor.getState().playhead
        const ids = await importFiles([generated.path], { trackId: null, at })
        assetId = ids[0]
        if (!assetId) throw new Error(ru ? 'Не удалось добавить сгенерированный голос' : 'Could not add generated speech')
        targetClipId = useEditor.getState().project.tracks.flatMap((t) => t.clips)
          .find((c) => c.assetId === assetId && Math.abs(c.start - at) < 0.05)?.id ?? null
        if (!targetClipId) throw new Error(ru ? 'Не найден созданный аудиоклип' : 'Generated clip was not found')
      } else {
        assetId = `mic-${targetClipId}-v${versionNumber}-${Date.now()}`
        const st = useEditor.getState()
        st.pushHistory('hVoiceGeneration')
        st.addAsset({
          ...probe.asset,
          id: assetId,
          path: generated.path,
          name: `Нейродубль · V${versionNumber}`,
          kind: 'audio'
        })
      }

      const finalClipId = targetClipId
      const version: VoiceoverVersion = {
        id: `take-${finalClipId}-${versionNumber}`,
        number: versionNumber,
        text: knownText.trim(),
        path: generated.path,
        assetId,
        duration: generated.duration,
        createdAt: new Date().toISOString(),
        settings: takeSettings
      }
      const latest = findClip(useEditor.getState().project, finalClipId)?.clip
      useEditor.getState().updateClip(finalClipId, {
        assetId,
        inPoint: 0,
        duration: Math.max(0.05, generated.duration),
        label: `Нейродубль · V${versionNumber}`,
        voiceover: {
          activeVersionId: version.id,
          versions: [...(latest?.voiceover?.versions ?? previousVersions), version],
          settings: takeSettings
        }
      })
      useEditor.getState().updateAsset(assetId, {
        voice: {
          source: 'neural-tts',
          recordedAt: new Date().toISOString(),
          knownText: knownText.trim(),
          provider: 'Local F5-TTS'
        }
      })
      setGeneratedClipId(finalClipId)
      setCurrentAssetId(assetId)
      setStatus(ru ? 'Новый вариант добавлен на таймлайн' : 'New version added to the timeline')
    } catch (err) {
      setError(String(err))
      setStatus('')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  const meter = Math.max(0, Math.min(100, ((levelDb + 60) / 60) * 100))
  const inputName = devices.find((d) => d.deviceId === deviceId)?.label || (ru ? 'Микрофон' : 'Microphone')

  return (
    <div className="modal-back mic-back" onClick={() => !recording && !busy && !cloneOpen && !libraryOpen && onClose()}>
      <div className="modal mic-studio" onClick={(e) => e.stopPropagation()}>
        <div className="mic-head">
          <div>
            <h2>🎙 {ru ? 'Студия голоса' : 'Voice Studio'}</h2>
            <span>{inputName}</span>
          </div>
          <button disabled={recording || busy || cloneOpen || libraryOpen} onClick={onClose}>✕</button>
        </div>
        <div className="mic-tabs">
          {tabs.map(([id, label]) => <button key={id} disabled={recording && id !== 'record'} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}
        </div>
        <div className="mic-body">
          <div className={`mic-pane mic-pane-${tab}`}>
          {tab === 'record' && <>
            <label className="mic-field">
              <span>{ru ? 'Микрофон' : 'Microphone'}</span>
              <select value={deviceId} disabled={recording || busy} onChange={(e) => setDeviceId(e.target.value)}>
                {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${ru ? 'Микрофон' : 'Microphone'} ${i + 1}`}</option>)}
              </select>
            </label>
            {slider(ru ? 'Входной уровень' : 'Input gain', fx.inputGain,
              (v) => patchFx('inputGain', v), 0.25, 2, 0.05, '×')}
            <div className="mic-meter" aria-label={`${Math.round(levelDb)} dBFS`}>
              <div className="mic-meter-colors" />
              <div className="mic-meter-mask" style={{ left: `${meter}%` }} />
              <i style={{ left: `${meter}%` }} />
            </div>
            <div className="mic-meter-labels"><span>−60</span><span>−18</span><span>−6</span><span>0 dBFS</span></div>
            <p className="mic-hint">{ru ? 'Говорите так, чтобы шкала чаще была зелёной или жёлтой. Красный означает перегруз.' : 'Aim for green or yellow. Red means clipping.'}</p>
            <div className="mic-record-row">
              {!recording
                ? <button className="mic-record" disabled={!stream || busy} onClick={startRecording}>● {ru ? 'Запись' : 'Record'}</button>
                : <button className="mic-stop" onClick={stopRecording}>■ {ru ? 'Стоп' : 'Stop'}</button>}
              <strong>{elapsed.toFixed(1)} s</strong>
              <span>{ru ? `Старт с ${timelineStartRef.current.toFixed(2)} с` : `Starts at ${timelineStartRef.current.toFixed(2)} s`}</span>
            </div>
          </>}

          {tab === 'leveling' && <>
            <label className="mic-toggle"><input type="checkbox" checked={fx.leveling.enabled}
              onChange={(e) => patchFx('leveling', { ...fx.leveling, enabled: e.target.checked })} />
              <b>{ru ? 'Автовыравнивание громкости' : 'Automatic loudness leveling'}</b></label>
            <p className="mic-hint">{ru ? 'После записи измеряет реальную интегральную громкость и безопасно выставляет усиление клипа. Исходник не меняется.' : 'Measures integrated loudness after recording and adjusts clip gain non-destructively.'}</p>
            {slider('Target', fx.leveling.targetLufs, (v) => patchFx('leveling', { ...fx.leveling, targetLufs: v }), -24, -9, 1, ' LUFS')}
          </>}

          {tab === 'noise' && <>
            <label className="mic-toggle"><input type="checkbox" checked={fx.noiseReduction.enabled} disabled={recording}
              onChange={(e) => patchFx('noiseReduction', { ...fx.noiseReduction, enabled: e.target.checked })} />
              <b>{ru ? 'Очистка от фонового шума' : 'Background noise reduction'}</b></label>
            <p className="mic-hint">{ru ? 'Использует шумоподавление аудиодрайвера/Chromium и срезает низкочастотный гул. Переключение переподключает микрофон.' : 'Uses the device/Chromium noise suppressor and removes low-frequency rumble.'}</p>
            {slider(ru ? 'Срезать ниже' : 'High-pass', fx.noiseReduction.highPassHz,
              (v) => patchFx('noiseReduction', { ...fx.noiseReduction, highPassHz: v }), 40, 180, 5, ' Hz')}
          </>}

          {tab === 'compressor' && <>
            <label className="mic-toggle"><input type="checkbox" checked={fx.compressor.enabled}
              onChange={(e) => patchFx('compressor', { ...fx.compressor, enabled: e.target.checked })} />
              <b>{ru ? 'Компрессор' : 'Compressor'}</b></label>
            {slider(ru ? 'Порог' : 'Threshold', fx.compressor.threshold, (v) => patchFx('compressor', { ...fx.compressor, threshold: v }), -48, -6, 1, ' dB')}
            {slider(ru ? 'Соотношение' : 'Ratio', fx.compressor.ratio, (v) => patchFx('compressor', { ...fx.compressor, ratio: v }), 1, 12, 0.5, ':1')}
            {slider('Attack', Math.round(fx.compressor.attack * 1000), (v) => patchFx('compressor', { ...fx.compressor, attack: v / 1000 }), 1, 100, 1, ' ms')}
            {slider('Release', Math.round(fx.compressor.release * 1000), (v) => patchFx('compressor', { ...fx.compressor, release: v / 1000 }), 30, 1000, 10, ' ms')}
          </>}

          {tab === 'delay' && <>
            <label className="mic-toggle"><input type="checkbox" checked={fx.delay.enabled}
              onChange={(e) => patchFx('delay', { ...fx.delay, enabled: e.target.checked })} />
              <b>{ru ? 'Дилей' : 'Delay'}</b></label>
            {slider(ru ? 'Время' : 'Time', Math.round(fx.delay.time * 1000), (v) => patchFx('delay', { ...fx.delay, time: v / 1000 }), 20, 1000, 10, ' ms')}
            {slider(ru ? 'Обратная связь' : 'Feedback', Math.round(fx.delay.feedback * 100), (v) => patchFx('delay', { ...fx.delay, feedback: v / 100 }), 0, 80, 1, '%')}
            {slider(ru ? 'Подмешивание' : 'Mix', Math.round(fx.delay.mix * 100), (v) => patchFx('delay', { ...fx.delay, mix: v / 100 }), 0, 80, 1, '%')}
          </>}

          {tab === 'cut' && <>
            <label className="mic-toggle"><input type="checkbox" checked={autoCut} onChange={(e) => setAutoCut(e.target.checked)} />
              <b>{ru ? 'Нарезать дубль после записи' : 'Cut take after recording'}</b></label>
            <p className="mic-hint">{ru ? 'Куски сохраняют исходные позиции: паузы видны как промежутки, а голос остаётся синхронным с видео.' : 'Pieces keep their original positions, preserving video sync.'}</p>
            {slider(ru ? 'Пауза для разреза' : 'Silence to cut', silenceSeconds, setSilenceSeconds, 0.2, 5, 0.1, ' s')}
            {slider(ru ? 'Минимальный кусок' : 'Minimum chunk', minChunkSeconds, setMinChunkSeconds, 0.5, 10, 0.5, ' s')}
            {slider(ru ? 'Максимальный кусок' : 'Maximum chunk', maxChunkSeconds, setMaxChunkSeconds, 5, 120, 1, ' s')}
            {slider(ru ? 'Порог тишины' : 'Silence threshold', thresholdDb, setThresholdDb, -60, -24, 1, ' dB')}
          </>}

          {tab === 'subtitles' && <>
            <h3>{ru ? 'Запись → субтитры' : 'Recording → subtitles'}</h3>
            <p className="mic-hint">{currentAssetId ? (ru ? 'Будет распознан последний дубль. Создадутся SRT и TXT в источниках проекта.' : 'The latest take will become SRT and TXT project sources.') : (ru ? 'Сначала запишите или сгенерируйте дубль.' : 'Record or generate a take first.')}</p>
            <label className="mic-field"><span>{ru ? 'Язык' : 'Language'}</span><select value={language} onChange={(e) => setLanguage(e.target.value)}><option value="auto">Auto</option><option value="ru">Русский</option><option value="en">English</option></select></label>
            <button className="primary" disabled={!currentAssetId || busy} onClick={makeSubtitles}>{ru ? 'Сконвертировать в субтитры' : 'Convert to subtitles'}</button>
          </>}

          {tab === 'regenerate' && <>
            <h3>{ru ? 'Перегенерация по тексту' : 'Regenerate from text'}</h3>
            <label className="mic-field">
              <span>{ru ? 'Голос F5‑TTS' : 'F5-TTS voice'}</span>
              <select value={voiceId} disabled={busy} onChange={(event) => setVoiceId(event.target.value)}>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.number ? `№${voice.number} · ` : '★ '}{ru ? voice.name : voice.nameEn}
                  </option>
                ))}
              </select>
            </label>
            <p className="mic-hint">{ru ? selectedVoice?.description : selectedVoice?.descriptionEn}</p>
            <div className="voice-clone-actions">
              <button className="clone-open" disabled={busy} onClick={() => { setEditVoice(undefined); setCloneOpen(true) }}>
                ＋ {ru ? 'Клонировать новый голос' : 'Clone a new voice'}
              </button>
              <button className="voice-library-open" disabled={busy} onClick={() => setLibraryOpen(true)}>
                ⚙ {ru ? 'Управление голосами' : 'Manage voices'}
              </button>
            </div>
            <textarea className="mic-text" rows={7} value={knownText} onChange={(e) => setKnownText(e.target.value)} placeholder={ru ? 'Точный текст реплики…' : 'Exact spoken text…'} />
            <VoiceoverSetup status={ttsStatus} settings={{ ...DEFAULT_VOICEOVER_SETTINGS, voiceId, customVoice: selectedVoice?.customVoice }}
              onReady={setTtsStatus} ru={ru} />
            <p className="mic-hint">{ru ? 'F5‑TTS клонирует выбранный референс. Голос можно менять перед каждым запуском; все варианты сохраняются в истории дублей.' : 'F5-TTS clones the selected reference. You can change voice before every run; every take stays in history.'}</p>
            <button className="primary" disabled={!knownText.trim() || busy || !ttsStatus?.ready} onClick={regenerate}>{ru ? 'Перегенерировать голос' : 'Regenerate voice'}</button>
          </>}
          </div>
        </div>
        {(status || error) && <div className={error ? 'mic-status error' : 'mic-status'}>{error || status}</div>}
      </div>
      {cloneOpen && <VoiceCloneStudio open onClose={() => { setCloneOpen(false); setEditVoice(undefined) }} ru={ru} editVoice={editVoice}
        onCreated={(voice) => {
          setGlobalVoices((current) => [...current.filter((item) => item.id !== voice.id), voice])
          setVoiceId(voice.id)
        }} />}
      {libraryOpen && <VoiceLibraryStudio open voices={customVoices} ru={ru} onClose={() => setLibraryOpen(false)}
        onEdit={(voice) => { setLibraryOpen(false); setEditVoice(voice); setCloneOpen(true) }}
        onDeleted={(deletedId) => {
          setGlobalVoices((current) => current.filter((voice) => voice.id !== deletedId))
          if (voiceId === deletedId) setVoiceId(DEFAULT_VOICEOVER_SETTINGS.voiceId)
        }} />}
    </div>
  )
}
