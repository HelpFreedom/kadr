import { useState } from 'react'
import { PROJECT_PRESETS } from '@/presets'
import { useT } from '@/i18n'
import { Modal } from './Modal'
import { Icon } from './icons'

export interface Dims {
  width: number
  height: number
  fps: number
}

/**
 * Pick a project canvas format. Mounted only while open (so the selection
 * resets each time). Two uses: the New Project dialog (matchVideo = null) and
 * the "media dropped into an empty project" prompt (matchVideo = the clip's
 * dimensions, offered as the preselected "match video" option).
 */
export function ProjectFormatDialog({
  matchVideo,
  title,
  applyLabel,
  onApply,
  onClose
}: {
  matchVideo: Dims | null
  title: string
  applyLabel: string
  onApply: (dims: Dims) => void
  onClose: () => void
}) {
  const t = useT()
  const [sel, setSel] = useState(matchVideo ? 'match' : PROJECT_PRESETS[0].id)

  const dims = (): Dims => {
    if (sel === 'match' && matchVideo) {
      return {
        width: matchVideo.width,
        height: matchVideo.height,
        fps: Math.round(matchVideo.fps) || 30
      }
    }
    const p = PROJECT_PRESETS.find((x) => x.id === sel) ?? PROJECT_PRESETS[0]
    return { width: p.width, height: p.height, fps: p.fps }
  }

  return (
    <Modal
      title={title}
      onClose={onClose}
      titleIcon={<Icon name="crop" size={17} />}
      wide
      actions={
        <>
          <button onClick={onClose}>{t('cancel')}</button>
          <button className="primary" onClick={() => onApply(dims())}>
            <Icon name="check" /> {applyLabel}
          </button>
        </>
      }
    >
      <label className="insp-field">
        <span>{t('format')}</span>
        <select value={sel} onChange={(e) => setSel(e.target.value)}>
          {matchVideo && (
            <option value="match">
              {t('projectMatchVideo')} ({matchVideo.width}×{matchVideo.height})
            </option>
          )}
          {PROJECT_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} ({p.width}×{p.height})
            </option>
          ))}
        </select>
      </label>
    </Modal>
  )
}
