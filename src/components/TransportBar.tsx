import { useEditor, projectDuration } from '@/state/store'
import { useSettings } from '@/state/store'
import { useT, type TKey } from '@/i18n'

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
  const playing = useEditor((s) => s.playing)
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.project.fps)
  const duration = useEditor((s) => projectDuration(s.project))
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label)
  const redoLabel = useEditor((s) => s.future[0]?.label)
  const st = useEditor.getState

  return (
    <div className="transport">
      <button
        title={t('undo') + (undoLabel ? `: ${t(undoLabel as TKey)}` : '')}
        disabled={!undoLabel}
        onClick={() => st().undo()}
      >
        ↶
      </button>
      <button
        title={t('redo') + (redoLabel ? `: ${t(redoLabel as TKey)}` : '')}
        disabled={!redoLabel}
        onClick={() => st().redo()}
      >
        ↷
      </button>
      <span className="sep" />
      <button title={t('toStart')} onClick={() => st().setPlayhead(0)}>⏮</button>
      <button
        className="play"
        title={playing ? t('pause') : t('play')}
        onClick={() => st().setPlaying(!playing)}
      >
        {playing ? '⏸' : '▶'}
      </button>
      <button title={t('toEnd')} onClick={() => st().setPlayhead(projectDuration(st().project))}>
        ⏭
      </button>
      <span className="sep" />
      <button title={t('split')} onClick={() => st().splitAtPlayhead()}>✂</button>
      <button title={t('delete')} onClick={() => st().deleteSelection()}>🗑</button>
      <button title={t('addText')} onClick={() => st().insertTextClip(playhead)}>T+</button>
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
    <button className="lang" onClick={() => setLang(lang === 'ru' ? 'en' : 'ru')}>
      {lang === 'ru' ? 'RU' : 'EN'}
    </button>
  )
}
