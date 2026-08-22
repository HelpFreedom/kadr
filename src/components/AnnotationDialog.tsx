import { useEffect, useState } from 'react'
import type { AnnotationStatus } from '@shared/types'
import { findAnnotation, useEditor } from '@/state/store'
import { useT } from '@/i18n'

const statuses: AnnotationStatus[] = ['new', 'in_progress', 'done']
const displayDate = (iso?: string) => iso ? new Date(iso).toLocaleString() : '—'

export function AnnotationDialog() {
  const t = useT()
  const annotationId = useEditor((s) => s.annotationId)
  const found = useEditor((s) => annotationId ? findAnnotation(s.project, annotationId) : null)
  const [draft, setDraft] = useState('')

  useEffect(() => setDraft(found?.annotation.text ?? ''), [annotationId])
  useEffect(() => {
    if (annotationId && !found) useEditor.getState().setAnnotation(null)
  }, [annotationId, found])

  if (!annotationId || !found) return null
  const { annotation, track } = found

  const save = (status?: AnnotationStatus) => {
    const text = draft.trim()
    if (!text) return
    const patch: { text: string; status?: AnnotationStatus } = { text }
    if (status) patch.status = status
    useEditor.getState().updateAnnotation(annotation.id, patch)
  }
  const close = () => {
    if (draft.trim()) {
      if (draft.trim() !== annotation.text) save()
      useEditor.getState().setAnnotation(null)
    } else {
      useEditor.getState().deleteAnnotation(annotation.id)
    }
  }

  return (
    <div className="modal-back annotation-back" onPointerDown={(e) => {
      if (e.target === e.currentTarget) close()
    }}>
      <div
        className={`modal annotation-dialog status-${annotation.status}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="annotation-dialog-title"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close()
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && draft.trim()) {
            save()
            useEditor.getState().setAnnotation(null)
          }
        }}
      >
        <div className="annotation-dialog-head">
          <div>
            <small>{track.name} · {annotation.start.toFixed(2)}–{(annotation.start + annotation.duration).toFixed(2)}s</small>
            <h2 id="annotation-dialog-title">{t('annotationTask')}</h2>
          </div>
          <button aria-label={t('close')} onClick={close}>×</button>
        </div>
        <textarea
          autoFocus
          aria-label={t('annotationTask')}
          placeholder={t('annotationPlaceholder')}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <div className="annotation-statuses" aria-label={t('annotationStatus')}>
          {statuses.map((status) => (
            <button
              key={status}
              className={`status-${status}${annotation.status === status ? ' active' : ''}`}
              disabled={!draft.trim()}
              onClick={() => save(status)}
            >
              <span />{t(`annotationStatus_${status}`)}
            </button>
          ))}
        </div>
        {annotation.result && (
          <div className="annotation-result">
            <b>{t('annotationAgentResult')}</b>
            <p>{annotation.result}</p>
          </div>
        )}
        <dl className="annotation-meta">
          <div><dt>ID</dt><dd>{annotation.id}</dd></div>
          <div><dt>{t('annotationCreated')}</dt><dd>{displayDate(annotation.createdAt)}</dd></div>
          <div><dt>{t('annotationUpdated')}</dt><dd>{displayDate(annotation.updatedAt)}</dd></div>
          {annotation.completedAt && (
            <div><dt>{t('annotationCompleted')}</dt><dd>{displayDate(annotation.completedAt)}</dd></div>
          )}
        </dl>
        <div className="modal-actions annotation-actions">
          <button
            className="danger"
            onClick={() => useEditor.getState().deleteAnnotation(annotation.id)}
          >
            {t('annotationDelete')}
          </button>
          <span className="flex1" />
          <button onClick={close}>{t('cancel')}</button>
          <button
            className="primary"
            disabled={!draft.trim()}
            onClick={() => {
              save()
              useEditor.getState().setAnnotation(null)
            }}
          >
            {t('annotationSave')}
          </button>
        </div>
      </div>
    </div>
  )
}
