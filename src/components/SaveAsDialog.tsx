import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useT } from '@/i18n'
import type { ProjectPackageOptions } from '@shared/types'

interface SaveAsDialogState {
  open: boolean
  busy: boolean
}

const useSaveAsDialog = create<SaveAsDialogState>(() => ({ open: false, busy: false }))
let finishRequest: ((options: ProjectPackageOptions | null) => void) | null = null

export function requestSaveAsOptions(): Promise<ProjectPackageOptions | null> {
  finishRequest?.(null)
  useSaveAsDialog.setState({ open: true })
  return new Promise((resolve) => { finishRequest = resolve })
}

export function setSaveAsBusy(busy: boolean) {
  useSaveAsDialog.setState({ busy })
}

function finish(options: ProjectPackageOptions | null) {
  useSaveAsDialog.setState({ open: false })
  const resolve = finishRequest
  finishRequest = null
  resolve?.(options)
}

export function SaveAsDialog() {
  const t = useT()
  const open = useSaveAsDialog((state) => state.open)
  const busy = useSaveAsDialog((state) => state.busy)
  const [includeDependencies, setIncludeDependencies] = useState(false)
  const [zip, setZip] = useState(false)

  useEffect(() => {
    if (!open) return
    setIncludeDependencies(false)
    setZip(false)
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  if (busy) {
    return (
      <div className="modal-back">
        <div className="modal save-as-modal">
          <h2>{t('saveAsPackaging')}</h2>
          <div className="dim">{t('saveAsPackagingHint')}</div>
          <progress className="save-as-progress" />
        </div>
      </div>
    )
  }
  if (!open) return null
  return (
    <div className="modal-back" onClick={() => finish(null)}>
      <div className="modal save-as-modal" onClick={(event) => event.stopPropagation()}>
        <h2>{t('saveAsTitle')}</h2>
        <div className="dim save-as-description">{t('saveAsDescription')}</div>
        <label className="save-as-option">
          <input
            type="checkbox"
            checked={includeDependencies}
            onChange={(event) => setIncludeDependencies(event.target.checked)}
          />
          <span>
            <b>{t('saveWithDependencies')}</b>
            <small>{t('saveWithDependenciesHint')}</small>
          </span>
        </label>
        <label className="save-as-option">
          <input
            type="checkbox"
            checked={zip}
            onChange={(event) => setZip(event.target.checked)}
          />
          <span>
            <b>{t('packZip')}</b>
            <small>{t('packZipHint')}</small>
          </span>
        </label>
        <div className="modal-actions">
          <button onClick={() => finish(null)}>{t('cancel')}</button>
          <button
            className="primary"
            onClick={() => finish({ includeDependencies, zip })}
          >
            {t('continueSave')}
          </button>
        </div>
      </div>
    </div>
  )
}
