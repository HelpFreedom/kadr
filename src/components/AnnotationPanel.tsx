import { useMemo, useState } from 'react'
import type { AnnotationStatus } from '@shared/types'
import { useEditor } from '@/state/store'
import { useT } from '@/i18n'

type StatusFilter = 'all' | AnnotationStatus

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0].trim()
const shortTime = (seconds: number) => {
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}:${rest.toFixed(1).padStart(4, '0')}`
}

export function AnnotationPanel() {
  const t = useT()
  const tracks = useEditor((s) => s.project.tracks.filter((track) => track.kind === 'annotation'))
  const [status, setStatus] = useState<StatusFilter>('all')
  const [trackId, setTrackId] = useState('all')

  const tasks = useMemo(() => tracks
    .flatMap((track) => (track.annotations ?? []).map((annotation) => ({ track, annotation })))
    .filter(({ track, annotation }) =>
      (trackId === 'all' || track.id === trackId) &&
      (status === 'all' || annotation.status === status)
    )
    .sort((a, b) => a.annotation.start - b.annotation.start), [tracks, trackId, status])

  return (
    <div className="annotation-panel">
      <div className="panel-head annotation-panel-head">
        <span>{t('annotations')} <b>{tasks.length}</b></span>
        <button onClick={() => useEditor.getState().addTrack('annotation')}>
          {t('addAnnotationTrack')}
        </button>
      </div>
      <div className="annotation-filters">
        <select
          aria-label={t('annotationTrackFilter')}
          value={trackId}
          onChange={(e) => setTrackId(e.target.value)}
        >
          <option value="all">{t('allTracks')}</option>
          {tracks.map((track) => <option key={track.id} value={track.id}>{track.name}</option>)}
        </select>
        <div className="annotation-status-filter">
          {(['all', 'new', 'in_progress', 'done'] as StatusFilter[]).map((value) => (
            <button
              key={value}
              className={status === value ? 'active' : ''}
              onClick={() => setStatus(value)}
            >
              {t(value === 'all' ? 'annotationAll' : `annotationStatus_${value}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="annotation-list">
        {!tasks.length && <div className="annotation-empty">{t('annotationEmpty')}</div>}
        {tasks.map(({ track, annotation }) => (
          <button
            key={annotation.id}
            className={`annotation-list-item status-${annotation.status}`}
            data-annotation-list-id={annotation.id}
            onClick={() => {
              const st = useEditor.getState()
              st.setActiveAnnotationTrack(track.id)
              st.setPlayhead(annotation.start)
              st.setAnnotation(annotation.id)
            }}
          >
            <span className="annotation-list-status" />
            <span className="annotation-list-copy">
              <b>{firstLine(annotation.text) || t('annotationUntitled')}</b>
              <small>{track.name} · {shortTime(annotation.start)}–{shortTime(annotation.start + annotation.duration)}</small>
              {annotation.result && <em>{annotation.result}</em>}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
