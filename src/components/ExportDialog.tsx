import { useEffect, useRef, useState } from 'react'
import type { ExportProgress } from '@shared/types'
import { PRESETS } from '@/presets'
import { startExport, type ExportHandle } from '@/engine/exporter'
import { useEditor, useSettings } from '@/state/store'
import { useT } from '@/i18n'
import { exportHtmlPlayer } from '@/features/htmlPlayer/export'

const HTML_PLAYER_ID = 'html-player'

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; phase: ExportProgress['phase']; progress: number }
  | { kind: 'done'; path?: string }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }

export function ExportDialog() {
  const t = useT()
  const open = useEditor((s) => s.exportOpen)
  const lang = useSettings((s) => s.lang)
  const range = useEditor((s) => s.range)
  const [presetId, setPresetId] = useState(PRESETS[0].id)
  const [motionBlur, setMotionBlur] = useState(true)
  const [frameBlending, setFrameBlending] = useState(true)
  const [fastEncoder, setFastEncoder] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const handle = useRef<ExportHandle | null>(null)

  useEffect(() => {
    return window.kadr.onExportProgress((p) => {
      if (p.phase === 'done') setStatus({ kind: 'done' })
      else if (p.phase === 'error') setStatus({ kind: 'error', message: p.message ?? '' })
      else if (p.phase === 'cancelled') setStatus({ kind: 'cancelled' })
      else setStatus({ kind: 'running', phase: p.phase, progress: p.progress })
    })
  }, [])

  if (!open) return null
  const running = status.kind === 'running'
  const htmlPlayer = presetId === HTML_PLAYER_ID

  async function begin() {
    const s = useEditor.getState()
    if (htmlPlayer) {
      const parentDir = await window.kadr.pickDirectory(t('htmlPlayerPickFolder'))
      if (!parentDir) return
      s.setPlaying(false)
      handle.current = null
      setStatus({ kind: 'running', phase: 'files', progress: 0 })
      try {
        const path = await exportHtmlPlayer(
          s.project,
          parentDir,
          lang,
          (progress) => setStatus({ kind: 'running', ...progress })
        )
        setStatus({ kind: 'done', path })
      } catch (err: any) {
        if (String(err?.message).includes('cancelled')) setStatus({ kind: 'cancelled' })
        else setStatus({ kind: 'error', message: String(err?.message ?? err) })
      }
      return
    }
    const preset = PRESETS.find((p) => p.id === presetId)!
    const ext = preset.container
    const out = await window.kadr.exportDialog(s.project.name, ext)
    if (!out) return
    s.setPlaying(false)
    setStatus({ kind: 'running', phase: 'video', progress: 0 })
    const h = startExport(
      s.project,
      preset,
      out,
      (p) => setStatus({ kind: 'running', phase: p.phase, progress: p.progress }),
      s.range,
      { motionBlur, frameBlending, encoder: fastEncoder ? 'webcodecs' : 'x264' }
    )
    handle.current = h
    h.done.catch((err) => {
      if (String(err?.message).includes('cancelled')) setStatus({ kind: 'cancelled' })
      else setStatus({ kind: 'error', message: String(err?.message ?? err) })
    })
  }

  function cancel() {
    handle.current?.cancel()
    window.kadr.exportCancel()
  }

  function close() {
    if (running) return
    setStatus({ kind: 'idle' })
    useEditor.getState().setExportOpen(false)
  }

  const phaseLabel =
    status.kind === 'running'
      ? status.phase === 'fragments'
        ? t('renderingFragments')
        : status.phase === 'files'
          ? t('copyingPlayerFiles')
          : status.phase === 'video'
            ? t('renderingVideo')
            : t('mixingAudio')
      : ''

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('export')}</h2>
        <label className="insp-field">
          <span>{t('preset')}</span>
          <select
            value={presetId}
            disabled={running}
            onChange={(e) => {
              setPresetId(e.target.value)
              setStatus({ kind: 'idle' })
            }}
          >
            {PRESETS.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
            <option value={HTML_PLAYER_ID}>{t('htmlPlayerPreset')}</option>
          </select>
        </label>
        <div className="insp-field">
          <span>{t('duration')}</span>
          <span>
            {!htmlPlayer && range
              ? `${t('exportRange')}: ${range.start.toFixed(2)}–${range.end.toFixed(2)} c`
              : t('wholeProject')}
          </span>
        </div>
        {htmlPlayer
          ? <div className="dim html-player-description">{t('htmlPlayerDescription')}</div>
          : !range && <div className="dim">{t('rangeHint')}</div>}
        {!htmlPlayer && <label className="anim-check export-mb">
          <input
            type="checkbox"
            checked={motionBlur}
            disabled={running}
            onChange={(e) => setMotionBlur(e.target.checked)}
          />
          <span className="export-mb-label">{t('motionBlur')}</span>
        </label>}
        {!htmlPlayer && <label className="anim-check export-mb" title={t('frameBlendingHint')}>
          <input
            type="checkbox"
            checked={frameBlending}
            disabled={running}
            onChange={(e) => setFrameBlending(e.target.checked)}
          />
          <span className="export-mb-label">{t('frameBlending')}</span>
        </label>}
        {!htmlPlayer && <label className="anim-check export-mb" title={t('fastEncoderHint')}>
          <input
            type="checkbox"
            checked={fastEncoder}
            disabled={running}
            onChange={(e) => setFastEncoder(e.target.checked)}
          />
          <span className="export-mb-label">{t('fastEncoder')}</span>
        </label>}

        {status.kind === 'running' && (
          <div className="export-progress">
            <div>{phaseLabel}</div>
            <progress value={status.progress} max={1} />
            <div className="dim">{Math.round(status.progress * 100)}%</div>
          </div>
        )}
        {status.kind === 'done' && (
          <div className="export-ok">
            ✓ {htmlPlayer ? t('htmlPlayerExportDone') : t('exportDone')}
            {status.path && <div className="dim export-output-path">{status.path}</div>}
          </div>
        )}
        {status.kind === 'cancelled' && <div className="dim">{t('exportCancelled')}</div>}
        {status.kind === 'error' && (
          <div className="export-err">{t('exportError')}: {status.message}</div>
        )}

        <div className="modal-actions">
          {running ? (
            <button onClick={cancel}>{t('cancel')}</button>
          ) : (
            <>
              <button className="primary" onClick={begin}>{t('startExport')}</button>
              <button onClick={close}>{t('close')}</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
