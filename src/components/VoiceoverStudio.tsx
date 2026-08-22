import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type {
  MediaAsset,
  VoiceoverCustomVoice,
  VoiceoverInstallProgress,
  VoiceoverProgress,
  VoiceoverSettings,
  VoiceoverStatus,
  VoiceoverVersion
} from '@shared/types'
import {
  DEFAULT_VOICEOVER_SETTINGS,
  getVoiceoverVoice,
  mergeVoiceChoices,
  normalizeVoiceoverSettings,
} from '@shared/voiceover'
import { findClip, useEditor } from '@/state/store'
import { VoiceCloneStudio } from './VoiceCloneStudio'
import { VoiceLibraryStudio } from './VoiceLibraryStudio'

export { DEFAULT_VOICEOVER_SETTINGS } from '@shared/voiceover'

export const useVoiceoverUi = create<{
  clipId: string | null
  open(clipId: string): void
  close(): void
}>((set) => ({
  clipId: null,
  open: (clipId) => set({ clipId }),
  close: () => set({ clipId: null })
}))

const versionAsset = (
  id: string,
  path: string,
  name: string,
  probed: Omit<MediaAsset, 'id'>
): MediaAsset => ({ ...probed, id, path, name, kind: 'audio' })

function VoicePlayer({ version, label }: { version: VoiceoverVersion; label: string }) {
  const [failed, setFailed] = useState(false)

  useEffect(() => setFailed(false), [version.id, version.path])

  return (
    <div className="voice-player">
      <audio
        key={`${version.id}:${version.path}`}
        aria-label={label}
        controls
        crossOrigin="anonymous"
        preload="metadata"
        src={window.kadr.fileUrl(version.path)}
        onCanPlay={() => setFailed(false)}
        onError={() => setFailed(true)}
      />
      {failed && <span className="voice-player-error">Не удалось открыть аудио. Закройте окно дублей и попробуйте снова.</span>}
    </div>
  )
}

const formatSize = (bytes: number) => bytes >= 1024 ** 3
  ? `${(bytes / 1024 ** 3).toFixed(1)} ГБ`
  : `${Math.round(bytes / 1024 ** 2)} МБ`

export function VoiceoverSetup({
  status,
  settings,
  onReady,
  ru = true
}: {
  status: VoiceoverStatus | null
  settings: VoiceoverSettings
  onReady: (status: VoiceoverStatus) => void
  ru?: boolean
}) {
  const [licenseAccepted, setLicenseAccepted] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [installProgress, setInstallProgress] = useState<VoiceoverInstallProgress | null>(null)
  const [installError, setInstallError] = useState('')

  useEffect(() => window.kadr.onVoiceoverInstallProgress((progress) => {
    setInstallProgress(progress)
    if (progress.stage === 'error') setInstallError(progress.message)
  }), [])

  if (!status) return (
    <div className="voice-setup-checking" role="status">
      <span className="voice-check-spinner" aria-hidden="true" />
      <div>
        <b>{ru ? 'Проверяю F5‑TTS…' : 'Checking F5-TTS…'}</b>
        <span>{ru
          ? 'При первом запуске загрузка Python и PyTorch может занять несколько секунд.'
          : 'On first launch, loading Python and PyTorch can take a few seconds.'}</span>
      </div>
    </div>
  )
  if (status.ready) return null
  const percent = Math.round((installProgress?.progress ?? 0) * 100)
  const transfer = installProgress?.downloadedBytes && installProgress.totalBytes
    ? `${formatSize(installProgress.downloadedBytes)} / ${formatSize(installProgress.totalBytes)}`
    : ''

  const install = async () => {
    if (!licenseAccepted || installing) return
    setInstalling(true)
    setInstallError('')
    setInstallProgress({ stage: 'preparing', progress: 0.01,
      message: ru ? 'Начинаю установку…' : 'Starting installation…' })
    try {
      onReady(await window.kadr.voiceoverInstall(settings))
    } catch (error) {
      setInstallError(String(error instanceof Error ? error.message : error))
    } finally {
      setInstalling(false)
    }
  }

  return (
    <div className="voice-setup-required">
      <b>{ru ? 'Локальная переозвучка не настроена' : 'Local voiceover is not configured'}</b>
      <span>{status.reason}</span>
      <span>{ru
        ? 'Kadr установит изолированный Python, F5‑TTS, русскую модель и 11 голосов. Потребуется интернет и около 5 ГБ свободного места.'
        : 'Kadr will install an isolated Python, F5-TTS, the Russian model and 11 voices. Internet access and about 5 GB of free space are required.'}</span>
      <label className="voice-license-confirm">
        <input type="checkbox" checked={licenseAccepted} disabled={installing}
          onChange={(event) => setLicenseAccepted(event.target.checked)} />
        <span>{ru
          ? 'Понимаю, что русская модель имеет лицензию CC BY‑NC 4.0 и не предназначена для коммерческого использования.'
          : 'I understand that the Russian model is CC BY-NC 4.0 and is not intended for commercial use.'}</span>
      </label>
      {installing && installProgress && (
        <div className="voice-install-progress">
          <div><span>{installProgress.message}</span><b>{transfer || `${percent}%`}</b></div>
          <progress value={Math.max(0.01, installProgress.progress)} max={1} />
        </div>
      )}
      {installError && <span className="voice-install-error">{installError}</span>}
      {installing ? (
        <button className="voice-install-cancel" onClick={() => void window.kadr.voiceoverInstallCancel()}>
          {ru ? 'Отменить установку' : 'Cancel installation'}
        </button>
      ) : (
        <button className="voice-install" disabled={!licenseAccepted} onClick={() => void install()}>
          {ru ? 'Установить F5‑TTS' : 'Install F5-TTS'}
        </button>
      )}
    </div>
  )
}

export function VoiceoverStudio() {
  const clipId = useVoiceoverUi((s) => s.clipId)
  const project = useEditor((s) => s.project)
  const projectPath = useEditor((s) => s.projectPath)
  const found = clipId ? findClip(project, clipId) : null
  const clip = found?.clip
  const history = clip?.voiceover
  const versions = history?.versions ?? []
  const active = versions.find((v) => v.id === history?.activeVersionId)
  const settings = normalizeVoiceoverSettings(history?.settings)
  const [draft, setDraft] = useState('')
  const [voiceId, setVoiceId] = useState(DEFAULT_VOICEOVER_SETTINGS.voiceId)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<VoiceoverProgress | null>(null)
  const [error, setError] = useState('')
  const [ttsStatus, setTtsStatus] = useState<VoiceoverStatus | null>(null)
  const [globalVoices, setGlobalVoices] = useState<VoiceoverCustomVoice[]>([])
  const [cloneOpen, setCloneOpen] = useState(false)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const [editVoice, setEditVoice] = useState<VoiceoverCustomVoice | undefined>()
  const embeddedVoices = useMemo(() => {
    if (project.voiceClones !== undefined) return project.voiceClones
    const result: VoiceoverCustomVoice[] = []
    if (history?.settings.customVoice) result.push(history.settings.customVoice)
    for (const version of versions) if (version.settings.customVoice) result.push(version.settings.customVoice)
    return result
  }, [project.voiceClones, history, versions])
  const voices = useMemo(() => mergeVoiceChoices([...globalVoices, ...embeddedVoices]), [globalVoices, embeddedVoices])
  const customVoices = useMemo(() => voices.flatMap((voice) => voice.customVoice ? [voice.customVoice] : []), [voices])
  const selectedVoice = voices.find((voice) => voice.id === voiceId) ?? voices[0]

  useEffect(() => {
    if (!clipId || !clip) return
    setDraft(active?.text ?? versions.at(-1)?.text ?? clip.label ?? '')
    const initialSettings = active?.settings ?? history?.settings
    setVoiceId(initialSettings?.customVoice?.id ?? getVoiceoverVoice(initialSettings?.voiceId).id)
    setProgress(null)
    setError('')
  }, [clipId])

  useEffect(() => {
    if (!clipId) return
    void window.kadr.voiceCloneList().then(setGlobalVoices).catch(() => setGlobalVoices([]))
  }, [clipId])

  useEffect(() => window.kadr.onVoiceoverProgress((p) => {
    if (p.clipId === clipId) setProgress(p)
  }), [clipId])

  useEffect(() => {
    let current = true
    setTtsStatus(null)
    if (!clipId) return () => { current = false }
    void window.kadr.voiceoverStatus(settings).then((status) => {
      if (current) setTtsStatus(status)
    }).catch(() => {
      if (current) setTtsStatus({
        ready: false,
        reason: 'Не удалось проверить TTS',
        configPath: '~/.config/kadr/tts.json'
      })
    })
    return () => { current = false }
  }, [clipId, settings.modelPath, settings.pythonPath, settings.vocabPath, settings.voicesPath])

  useEffect(() => {
    if (!clipId) return
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !busy && !cloneOpen && !libraryOpen) useVoiceoverUi.getState().close()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [clipId, busy, cloneOpen, libraryOpen])

  const nextVersion = useMemo(
    () => Math.max(0, ...versions.map((v) => v.number)) + 1,
    [versions]
  )

  if (!clipId || !clip) return null

  const generate = async () => {
    const text = draft.trim()
    if (!text || busy || !ttsStatus?.ready) return
    setBusy(true)
    setError('')
    try {
      const generationSettings = { ...settings, voiceId, customVoice: selectedVoice?.customVoice }
      const result = await window.kadr.voiceoverGenerate({
        clipId,
        projectPath,
        version: nextVersion,
        text,
        settings: generationSettings
      })
      const probe = await window.kadr.probeMedia(result.path)
      const assetId = `voice-${clipId}-v${nextVersion}`
      const takeSettings = { ...generationSettings, seed: result.seed }
      const version: VoiceoverVersion = {
        id: `take-${clipId}-${nextVersion}`,
        number: nextVersion,
        text,
        path: result.path,
        assetId,
        duration: result.duration,
        createdAt: new Date().toISOString(),
        settings: takeSettings
      }
      const st = useEditor.getState()
      st.pushHistory('hVoiceGeneration')
      st.addAsset(versionAsset(
        assetId,
        result.path,
        `${clip.label ?? 'Озвучка'} · V${nextVersion}`,
        probe.asset
      ))
      const latest = findClip(useEditor.getState().project, clipId)?.clip
      st.updateClip(clipId, {
        voiceover: {
          activeVersionId: latest?.voiceover?.activeVersionId,
          versions: [...(latest?.voiceover?.versions ?? []), version],
          settings: takeSettings,
          timedDuration: latest?.voiceover?.timedDuration
        }
      })
    } catch (err) {
      setError(String(err instanceof Error ? err.message : err))
    } finally {
      setBusy(false)
    }
  }

  const applyVersion = (version: VoiceoverVersion) => {
    const st = useEditor.getState()
    const current = findClip(st.project, clipId)?.clip
    if (!current || current.voiceover?.activeVersionId === version.id) return
    st.pushHistory('hVoiceVersion')
    const base = (current.label ?? 'Озвучка').replace(/\s*[·•-]\s*V\d+$/i, '')
    const timedDuration = current.voiceover?.timedDuration
    st.updateClip(clipId, {
      assetId: version.assetId,
      inPoint: 0,
      duration: Math.max(0.05, timedDuration ?? version.duration),
      speed: timedDuration ? Math.max(0.01, version.duration / timedDuration) : 1,
      label: `${base} · V${version.number}`,
      voiceover: {
        settings: version.settings,
        versions: current.voiceover?.versions ?? [version],
        activeVersionId: version.id,
        timedDuration
      }
    })
  }

  const percent = Math.round((progress?.progress ?? 0) * 100)
  const stage = progress?.stage === 'loading'
    ? 'Загружаю голосовую модель'
    : progress?.stage === 'mastering'
      ? 'Выравниваю громкость и финализирую'
      : 'Генерирую новый дубль'

  return (
    <div className="voice-studio-backdrop" onPointerDown={() => !busy && !cloneOpen && !libraryOpen && useVoiceoverUi.getState().close()}>
      <section className="voice-studio" onPointerDown={(e) => e.stopPropagation()}>
        <header className="voice-studio-head">
          <div>
            <span className="voice-eyebrow">ЛОКАЛЬНАЯ ОЗВУЧКА / {clip.label ?? 'КЛИП'}</span>
            <h2>Новый дубль</h2>
          </div>
          <button className="voice-close" disabled={busy || cloneOpen || libraryOpen} onClick={() => useVoiceoverUi.getState().close()}>×</button>
        </header>

        <div className="voice-studio-grid">
          <div className="voice-compose">
            <label htmlFor="voice-choice">Голос F5‑TTS</label>
            <div className="voice-choice">
              <select id="voice-choice" value={voiceId} disabled={busy}
                onChange={(event) => setVoiceId(event.target.value)}>
                {voices.map((voice) => (
                  <option key={voice.id} value={voice.id}>
                    {voice.number ? `№${voice.number} · ` : '★ '}{voice.name}
                  </option>
                ))}
              </select>
              <span>{selectedVoice?.description}</span>
            </div>
            <div className="voice-clone-actions">
              <button className="clone-open" disabled={busy} onClick={() => { setEditVoice(undefined); setCloneOpen(true) }}>
                ＋ Клонировать новый голос
              </button>
              <button className="voice-library-open" disabled={busy} onClick={() => setLibraryOpen(true)}>
                ⚙ Управление голосами
              </button>
            </div>
            <label htmlFor="voice-draft">Текст для генерации</label>
            <textarea
              id="voice-draft"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={busy}
              spellCheck
            />
            <div className="voice-hint">
              Ударение можно отметить знаком: молоко́. Перед каждым новым дублем голос можно сменить.
            </div>
            <VoiceoverSetup status={ttsStatus}
              settings={{ ...settings, voiceId, customVoice: selectedVoice?.customVoice }} onReady={setTtsStatus} />
            {error && <div className="voice-error">{error}</div>}
            {busy && (
              <div className="voice-progress">
                <div className="voice-progress-copy"><span>{stage}</span><b>{percent}%</b></div>
                <div className="voice-progress-rail"><i style={{ width: `${Math.max(4, percent)}%` }} /></div>
              </div>
            )}
            <div className="voice-actions">
              {busy ? (
                <button className="voice-cancel" onClick={() => void window.kadr.voiceoverCancel()}>Отменить</button>
              ) : (
                <button className="voice-generate" disabled={!draft.trim() || !ttsStatus?.ready} onClick={() => void generate()}>
                  <span>Сгенерировать</span><b>V{nextVersion}</b>
                </button>
              )}
            </div>
          </div>

          <aside className="voice-history">
            <div className="voice-history-title">
              <span>История дублей</span><b>{versions.length}</b>
            </div>
            {active && (
              <div className="voice-active-preview">
                <div className="voice-active-preview-head">
                  <span>Сейчас в проекте</span>
                  <b>V{active.number}</b>
                </div>
                <VoicePlayer version={active} label={`Текущая версия V${active.number}`} />
              </div>
            )}
            <div className="voice-takes">
              {[...versions].sort((a, b) => b.number - a.number).map((version) => {
                const checked = history?.activeVersionId === version.id
                return (
                  <article key={version.id} className={`voice-take ${checked ? 'active' : ''}`}>
                    <div className="voice-take-top">
                      <label className="voice-version-check" title="Применить эту версию">
                        <input type="checkbox" checked={checked} onChange={() => applyVersion(version)} />
                        <span>V{version.number}</span>
                      </label>
                      <time>{new Date(version.createdAt).toLocaleString('ru-RU')}</time>
                      <button onClick={() => void navigator.clipboard.writeText(version.text)}>Копировать</button>
                    </div>
                    <p>{version.text}</p>
                    <VoicePlayer version={version} label={`Версия V${version.number}`} />
                    <div className="voice-take-foot">
                      <span>{version.duration.toFixed(2)} сек</span>
                      <span>{version.settings.customVoice
                        ? `★ ${version.settings.customVoice.name}`
                        : `№${getVoiceoverVoice(version.settings.voiceId).number} · ${getVoiceoverVoice(version.settings.voiceId).name}`}</span>
                      <span>seed {version.settings.seed}</span>
                      {checked && <strong>В ПРОЕКТЕ</strong>}
                    </div>
                  </article>
                )
              })}
              {!versions.length && (
                <div className="voice-empty">
                  <span>V1</span>
                  Первый сгенерированный дубль появится здесь вместе с текстом и аудио.
                </div>
              )}
            </div>
          </aside>
        </div>
      </section>
      {cloneOpen && <VoiceCloneStudio open onClose={() => { setCloneOpen(false); setEditVoice(undefined) }} ru editVoice={editVoice}
        onCreated={(voice) => {
          setGlobalVoices((current) => [...current.filter((item) => item.id !== voice.id), voice])
          setVoiceId(voice.id)
        }} />}
      {libraryOpen && <VoiceLibraryStudio open voices={customVoices} ru onClose={() => setLibraryOpen(false)}
        onEdit={(voice) => { setLibraryOpen(false); setEditVoice(voice); setCloneOpen(true) }}
        onDeleted={(deletedId) => {
          setGlobalVoices((current) => current.filter((voice) => voice.id !== deletedId))
          if (voiceId === deletedId) setVoiceId(DEFAULT_VOICEOVER_SETTINGS.voiceId)
        }} />}
    </div>
  )
}
