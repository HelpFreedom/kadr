import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { VoiceoverCustomVoice } from '@shared/types'
import { useEditor } from '@/state/store'

export function VoiceLibraryStudio({
  open,
  voices,
  ru,
  onClose,
  onEdit,
  onDeleted
}: {
  open: boolean
  voices: VoiceoverCustomVoice[]
  ru: boolean
  onClose: () => void
  onEdit: (voice: VoiceoverCustomVoice) => void
  onDeleted: (voiceId: string) => void
}) {
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [error, setError] = useState('')

  if (!open) return null

  const remove = async (voice: VoiceoverCustomVoice) => {
    setDeletingId(voice.id)
    setError('')
    try {
      await window.kadr.voiceCloneDelete(voice.id)
      const state = useEditor.getState()
      state.pushHistory('hVoiceClone')
      useEditor.setState({
        project: {
          ...state.project,
          voiceClones: (state.project.voiceClones ?? []).filter((item) => item.id !== voice.id)
        }
      })
      onDeleted(voice.id)
      setConfirmId(null)
    } catch (cause) {
      setError(String(cause instanceof Error ? cause.message : cause))
    } finally {
      setDeletingId(null)
    }
  }

  return createPortal(
    <div className="modal-back voice-library-back" onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => { event.stopPropagation(); if (!deletingId) onClose() }}>
      <div className="modal voice-library-studio" onClick={(event) => event.stopPropagation()}>
        <div className="clone-head">
          <div>
            <h2>{ru ? 'Управление голосами' : 'Voice management'}</h2>
            <span>{ru ? `${voices.length} пользовательских` : `${voices.length} custom`}</span>
          </div>
          <button disabled={!!deletingId} onClick={onClose}>✕</button>
        </div>
        <div className="voice-library-scroll">
          {!voices.length && <div className="voice-library-empty">
            {ru ? 'Пользовательских голосов пока нет. Создайте первый клон из файла или микрофона.' : 'No custom voices yet. Clone one from a file or microphone.'}
          </div>}
          {voices.map((voice) => (
            <article className="voice-library-item" key={voice.id}>
              <div className="voice-library-copy">
                <div><b>{voice.name}</b><span>{voice.source === 'microphone' ? '● MIC' : '▣ FILE'}</span></div>
                <p>{voice.description || (ru ? 'Без описания' : 'No description')}</p>
                <small>{voice.referenceText
                  ? (ru ? 'Текст референса подтверждён' : 'Reference text confirmed')
                  : (ru ? '⚠ Текст референса не подтверждён' : '⚠ Reference text not confirmed')}</small>
              </div>
              {confirmId === voice.id ? (
                <div className="voice-library-confirm">
                  <span>{ru ? 'Удалить голос из библиотеки и проекта?' : 'Delete from the library and project?'}</span>
                  <button disabled={!!deletingId} onClick={() => setConfirmId(null)}>{ru ? 'Нет' : 'No'}</button>
                  <button className="danger" disabled={!!deletingId} onClick={() => void remove(voice)}>
                    {deletingId === voice.id ? (ru ? 'Удаляю…' : 'Deleting…') : (ru ? 'Удалить' : 'Delete')}
                  </button>
                </div>
              ) : (
                <div className="voice-library-actions">
                  <button disabled={!!deletingId} onClick={() => onEdit(voice)}>
                    {ru ? 'Изменить / заменить исходник' : 'Edit / replace source'}
                  </button>
                  <button className="danger" disabled={!!deletingId} onClick={() => setConfirmId(voice.id)}>
                    {ru ? 'Удалить' : 'Delete'}
                  </button>
                </div>
              )}
            </article>
          ))}
          {error && <div className="clone-status error">{error}</div>}
        </div>
      </div>
    </div>,
    document.body
  )
}
