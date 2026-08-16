import { useEffect, useMemo, useState } from 'react'
import { create } from 'zustand'
import type {
  MediaAsset,
  VoiceoverProgress,
  VoiceoverSettings,
  VoiceoverStatus,
  VoiceoverVersion
} from '@shared/types'
import { findClip, useEditor } from '@/state/store'

const VOICE_PROMPT =
  'A friendly adult Russian narrator with a warm, calm, confident voice and a light smile. ' +
  'Measured pace, clear standard Russian diction, medium-low pitch and a natural dynamic range. ' +
  'Sound engaging without shouting, rushing, sales energy or theatrical overacting. ' +
  'Finish every sentence completely and leave a natural final cadence.'

export const DEFAULT_VOICEOVER_SETTINGS: VoiceoverSettings = {
  modelPath: '',
  pythonPath: '',
  voicePrompt: VOICE_PROMPT,
  language: 'Russian',
  temperature: 0.45,
  topK: 30,
  topP: 0.82,
  repetitionPenalty: 1.08,
  maxTokens: 700,
  seed: 20260816,
  loudnessLufs: -16,
  truePeakDb: -1.5
}

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

export function VoiceoverStudio() {
  const clipId = useVoiceoverUi((s) => s.clipId)
  const project = useEditor((s) => s.project)
  const projectPath = useEditor((s) => s.projectPath)
  const found = clipId ? findClip(project, clipId) : null
  const clip = found?.clip
  const history = clip?.voiceover
  const versions = history?.versions ?? []
  const active = versions.find((v) => v.id === history?.activeVersionId)
  const settings = history?.settings ?? DEFAULT_VOICEOVER_SETTINGS
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<VoiceoverProgress | null>(null)
  const [error, setError] = useState('')
  const [ttsStatus, setTtsStatus] = useState<VoiceoverStatus | null>(null)

  useEffect(() => {
    if (!clipId || !clip) return
    setDraft(active?.text ?? versions.at(-1)?.text ?? clip.label ?? '')
    setProgress(null)
    setError('')
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
  }, [clipId, settings.modelPath, settings.pythonPath])

  useEffect(() => {
    if (!clipId) return
    const key = (e: KeyboardEvent) => {
      if (e.code === 'Escape' && !busy) useVoiceoverUi.getState().close()
    }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [clipId, busy])

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
      const result = await window.kadr.voiceoverGenerate({
        clipId,
        projectPath,
        version: nextVersion,
        text,
        settings
      })
      const probe = await window.kadr.probeMedia(result.path)
      const assetId = `voice-${clipId}-v${nextVersion}`
      const takeSettings = { ...settings, seed: result.seed }
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
          settings: takeSettings
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
    st.updateClip(clipId, {
      assetId: version.assetId,
      inPoint: 0,
      duration: Math.max(0.05, version.duration),
      label: `${base} · V${version.number}`,
      voiceover: {
        settings: version.settings,
        versions: current.voiceover?.versions ?? [version],
        activeVersionId: version.id
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
    <div className="voice-studio-backdrop" onPointerDown={() => !busy && useVoiceoverUi.getState().close()}>
      <section className="voice-studio" onPointerDown={(e) => e.stopPropagation()}>
        <header className="voice-studio-head">
          <div>
            <span className="voice-eyebrow">ЛОКАЛЬНАЯ ОЗВУЧКА / {clip.label ?? 'КЛИП'}</span>
            <h2>Новый дубль</h2>
          </div>
          <button className="voice-close" disabled={busy} onClick={() => useVoiceoverUi.getState().close()}>×</button>
        </header>

        <div className="voice-studio-grid">
          <div className="voice-compose">
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
              Ударение можно отметить знаком: молоко́. Параметры голоса и модели останутся прежними.
            </div>
            {ttsStatus && !ttsStatus.ready && (
              <div className="voice-setup-required">
                <b>Переозвучка отключена</b>
                <span>{ttsStatus.reason}. Инструкция и готовый промпт для установки находятся в разделе «Локальная переозвучка» файла README.md.</span>
              </div>
            )}
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
    </div>
  )
}
