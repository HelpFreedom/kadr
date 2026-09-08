import { useEffect, useRef, useState } from 'react'
import type { ExportProgress } from '@shared/types'
import { PRESETS } from '@/presets'
import { startExport, type ExportHandle } from '@/engine/exporter'
import { useVoiceUi } from '@/engine/voiceCheck'
import { useEditor } from '@/state/store'
import { useT } from '@/i18n'
import { Icon } from './icons'
import { Modal } from './Modal'

type Status =
  | { kind: 'idle' }
  | { kind: 'running'; phase: ExportProgress['phase']; progress: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string }
  | { kind: 'cancelled' }

export function ExportDialog() {
  const checking = useVoiceUi((v) => v.phase === 'check')
  const t = useT()
  const open = useEditor((s) => s.exportOpen)
  const range = useEditor((s) => s.range)
  const [presetId, setPresetId] = useState(PRESETS[0].id)
  const [motionBlur, setMotionBlur] = useState(true)
  const [frameBlending, setFrameBlending] = useState(true)
  const [fastEncoder, setFastEncoder] = useState(false)
  const [nvenc, setNvenc] = useState(false)
  const [nvencOk, setNvencOk] = useState(false)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const handle = useRef<ExportHandle | null>(null)

  useEffect(() => {
    if (open) void window.kadr.nvencAvailable().then(setNvencOk)
  }, [open])

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

  async function begin() {
    const preset = PRESETS.find((p) => p.id === presetId)!
    const s = useEditor.getState()
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
      {
        motionBlur,
        frameBlending,
        // NVENC uses the raw ffmpeg path, so it overrides the webcodecs option
        encoder: fastEncoder && !(nvenc && nvencOk) ? 'webcodecs' : 'x264',
        nvenc: nvenc && nvencOk
      }
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
        : status.phase === 'video'
          ? t('renderingVideo')
          : t('mixingAudio')
      : ''

  return (
    <Modal
      title={t('export')}
      onClose={close}
      closeDisabled={running}
      titleIcon={<Icon name="download" size={17} />}
      wide
      actions={
        running ? (
          <button onClick={cancel}>{t('cancel')}</button>
        ) : (
          <>
            <button onClick={close}>{t('close')}</button>
            <button className="primary" disabled={checking} onClick={begin}
                    title={checking ? t('dfLong') : undefined}>
              <Icon name="download" /> {t('startExport')}
            </button>
          </>
        )
      }
    >
      <label className="insp-field">
        <span>{t('preset')}</span>
        <select value={presetId} disabled={running} onChange={(e) => setPresetId(e.target.value)}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </label>
      <div className="insp-field">
        <span>{t('duration')}</span>
        <span>
          {range
            ? `${t('exportRange')}: ${range.start.toFixed(2)}–${range.end.toFixed(2)} c`
            : t('wholeProject')}
        </span>
      </div>
      {!range && <div className="dim">{t('rangeHint')}</div>}
      <label className="anim-check export-mb">
        <input
          type="checkbox"
          checked={motionBlur}
          disabled={running}
          onChange={(e) => setMotionBlur(e.target.checked)}
        />
        {t('motionBlur')}
      </label>
      <label className="anim-check export-mb" title={t('frameBlendingHint')}>
        <input
          type="checkbox"
          checked={frameBlending}
          disabled={running}
          onChange={(e) => setFrameBlending(e.target.checked)}
        />
        {t('frameBlending')}
      </label>
      <label className="anim-check export-mb" title={t('fastEncoderHint')}>
        <input
          type="checkbox"
          checked={fastEncoder}
          disabled={running}
          onChange={(e) => setFastEncoder(e.target.checked)}
        />
        {t('fastEncoder')}
      </label>
      <label className="anim-check export-mb" title={t('nvencHint')}>
        <input
          type="checkbox"
          checked={nvenc && nvencOk}
          disabled={running || !nvencOk}
          onChange={(e) => setNvenc(e.target.checked)}
        />
        {t('nvenc')}{!nvencOk ? ` — ${t('nvencNA')}` : ''}
      </label>

      {status.kind === 'running' && (
        <div className="export-progress">
          <div>{phaseLabel}</div>
          <progress value={status.progress} max={1} />
          <div className="dim">{Math.round(status.progress * 100)}%</div>
        </div>
      )}
      {status.kind === 'done' && (
        <div className="export-ok"><Icon name="check" /> {t('exportDone')}</div>
      )}
      {status.kind === 'cancelled' && <div className="dim">{t('exportCancelled')}</div>}
      {status.kind === 'error' && (
        <div className="export-err">
          <Icon name="alert" size={15} />
          <span>{t('exportError')}: {status.message}</span>
        </div>
      )}
    </Modal>
  )
}
