import { useState } from 'react'
import { useEditor, projectDuration } from '@/state/store'
import { useSettings } from '@/state/store'
import { snapshotFrame } from '@/engine/snapshot'
import { usePopout, togglePreviewWindow } from '@/engine/popout'
import { useT, type TKey } from '@/i18n'
import { Icon, Spinner } from './icons'
import { logWarn } from '@/engine/log'

export function formatTime(t: number, fps: number): string {
  const sign = t < 0 ? '-' : ''
  t = Math.abs(t)
  const h = Math.floor(t / 3600)
  const m = Math.floor((t % 3600) / 60)
  const s = Math.floor(t % 60)
  const f = Math.floor((t % 1) * fps)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${sign}${pad(h)}:${pad(m)}:${pad(s)}.${pad(f)}`
}

export function TransportBar() {
  const t = useT()
  const [shot, setShot] = useState<'idle' | 'busy' | 'ok' | 'fail'>('idle')
  const playing = useEditor((s) => s.playing)
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.project.fps)
  const duration = useEditor((s) => projectDuration(s.project))
  const popped = usePopout((s) => s.win) !== null
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label)
  const redoLabel = useEditor((s) => s.future[0]?.label)
  const st = useEditor.getState

  return (
    <div className="transport">
      <span className="bar-group">
        <button
          className="icon-only"
          data-act="undo"
          title={t('undo') + (undoLabel ? `: ${t(undoLabel as TKey)}` : '')}
          aria-label={t('undo')}
          disabled={!undoLabel}
          onClick={() => st().undo()}
        >
          <Icon name="undo" />
        </button>
        <button
          className="icon-only"
          data-act="redo"
          title={t('redo') + (redoLabel ? `: ${t(redoLabel as TKey)}` : '')}
          aria-label={t('redo')}
          disabled={!redoLabel}
          onClick={() => st().redo()}
        >
          <Icon name="redo" />
        </button>
      </span>
      <span className="sep" />
      <button className="icon-only" data-act="to-start" title={t('toStart')} aria-label={t('toStart')}
              onClick={() => st().setPlayhead(0)}>
        <Icon name="toStart" />
      </button>
      <button
        className="play"
        data-act="play"
        title={playing ? t('pause') : t('play')}
        aria-label={playing ? t('pause') : t('play')}
        onClick={() => st().setPlaying(!playing)}
      >
        <Icon name={playing ? 'pause' : 'play'} size={17} />
      </button>
      <button className="icon-only" data-act="to-end" title={t('toEnd')} aria-label={t('toEnd')}
              onClick={() => st().setPlayhead(projectDuration(st().project))}>
        <Icon name="toEnd" />
      </button>
      <span className="sep" />
      <button className="icon-only" data-act="split" title={t('split')} aria-label={t('split')}
              onClick={() => st().splitAtPlayhead()}>
        <Icon name="split" />
      </button>
      <button className="icon-only" data-act="delete" title={t('delete')} aria-label={t('delete')}
              onClick={() => st().deleteSelection()}>
        <Icon name="trash" />
      </button>
      <button className="icon-only" data-act="add-text" title={t('addText')} aria-label={t('addText')}
              onClick={() => st().insertTextClip(playhead)}>
        <Icon name="text" />
      </button>
      <button
        className="icon-only"
        data-act="snapshot"
        title={shot === 'fail' ? t('snapshotFail') : t('snapshot')}
        aria-label={t('snapshot')}
        disabled={shot === 'busy'}
        onClick={() => {
          setShot('busy')
          snapshotFrame({ interactive: true }).then(
            () => setShot('ok'),
            (err) => {
              if (String(err).includes('cancelled')) { setShot('idle'); return }
              logWarn('снимок', 'снимок кадра не удался', err)
              setShot('fail')
            }
          ).finally(() => setTimeout(() => setShot('idle'), 2000))
        }}
      >
        {shot === 'busy' ? <Spinner />
          : <Icon name={shot === 'ok' ? 'check' : shot === 'fail' ? 'close' : 'camera'} />}
      </button>
      <button
        className={`icon-only${popped ? ' active' : ''}`}
        data-act="popout"
        title={popped ? t('popin') : t('popout')}
        aria-label={popped ? t('popin') : t('popout')}
        onClick={() => togglePreviewWindow()}
      >
        <Icon name={popped ? 'popin' : 'popout'} />
      </button>
      <span className="time">
        {formatTime(playhead, fps)} <span className="dim">/ {formatTime(duration, fps)}</span>
        <span className="frame-counter dim">
          {' '}· {t('frameLbl')} {Math.floor(playhead * fps + 1e-6)}
          <span> / {Math.floor(duration * fps + 1e-6)}</span>
        </span>
      </span>
    </div>
  )
}

export function LangSwitch() {
  const lang = useSettings((s) => s.lang)
  const setLang = useSettings((s) => s.setLang)
  return (
    <button
      className="lang"
      data-act="lang"
      title={lang === 'ru' ? 'Язык интерфейса: русский' : 'Interface language: English'}
      onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}
    >
      <Icon name="language" size={14} /> {lang === 'ru' ? 'RU' : 'EN'}
    </button>
  )
}
