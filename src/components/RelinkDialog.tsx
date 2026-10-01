import { useState } from 'react'
import { useEditor } from '@/state/store'
import { useOffline, openRelink, relinkPick, relinkFromFolder } from '@/engine/offline'
import { useT } from '@/i18n'
import { Modal } from './Modal'
import { Icon, Spinner } from './icons'

/** The missing files of the project, one row each, and the two ways back (src/engine/offline.ts). */
export function RelinkDialog() {
  const t = useT()
  const open = useOffline((s) => s.dialog)
  const ids = useOffline((s) => s.ids)
  const assets = useEditor((s) => s.project.assets)
  const [busy, setBusy] = useState(false)
  if (!open) return null
  const missing = assets.filter((a) => ids.has(a.id))
  const act = (job: () => Promise<unknown>) => {
    setBusy(true)
    void job().finally(() => setBusy(false))
  }
  return (
    <Modal
      title={t('relinkTitle')}
      titleIcon={<Icon name="alert" />}
      onClose={() => openRelink(false)}
      actions={
        <>
          <button onClick={() => openRelink(false)} data-act="relink-close">{t('close')}</button>
          <button className="primary" disabled={busy || !missing.length} data-act="relink-folder"
                  onClick={() => act(() => relinkFromFolder())}>
            {busy ? <Spinner size={12} /> : <Icon name="folderOpen" />} {t('relinkFolder')}
          </button>
        </>
      }
    >
      {missing.length ? <p>{t('relinkBody')}</p> : <p>{t('relinkAllFound')}</p>}
      {missing.map((a) => (
        <div className="st-row" key={a.id} data-offline={a.id}>
          <span className="st-proj" title={a.path}>
            {a.name}
            <span className="st-path">{a.path}</span>
          </span>
          <button disabled={busy} data-act="relink-pick" onClick={() => act(() => relinkPick(a.id))}>
            {t('relinkPick')}
          </button>
        </div>
      ))}
    </Modal>
  )
}
