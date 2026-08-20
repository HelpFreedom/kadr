import { useEffect, useState } from 'react'
import type { GpuInfo } from '@shared/types'
import { useEditor } from '@/state/store'
import { useT } from '@/i18n'

/** Read the currently-active WebGL renderer string (e.g. "Mesa Intel(R) UHD
 *  Graphics 630 …" or an NVIDIA string) so the user can confirm a GPU switch
 *  actually took effect after relaunch. */
function activeRenderer(): string {
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    return ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
  } catch {
    return ''
  }
}

export function SettingsDialog() {
  const t = useT()
  const open = useEditor((s) => s.settingsOpen)
  const close = () => useEditor.getState().setSettingsOpen(false)

  const [gpus, setGpus] = useState<GpuInfo[]>([])
  const [node, setNode] = useState('') // '' = auto
  const [saved, setSaved] = useState('') // active choice on disk, to detect a change
  const [failed, setFailed] = useState(false) // last attempt didn't come up → reverted
  const [renderer] = useState(activeRenderer)

  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      const [list, choice] = await Promise.all([
        window.kadr.gpuList(),
        window.kadr.readUserStore('gpu') as Promise<
          { node?: string; status?: string } | null
        >
      ])
      if (!alive) return
      setGpus(list)
      // a 'failed' choice means the app reverted to auto — show Auto selected
      const active = choice?.node && choice.status !== 'failed' ? choice.node : ''
      setNode(active)
      setSaved(active)
      setFailed(Boolean(choice?.node) && choice?.status === 'failed')
    })()
    return () => {
      alive = false
    }
  }, [open])

  if (!open) return null

  const label = (g: GpuInfo) =>
    `${g.vendor} (${g.integrated ? t('gpuIntegrated') : t('gpuDiscrete')})`

  const changed = node !== saved

  // a chosen GPU is written as a 'trial': main flips it to 'failed' before the
  // window opens and back to 'ok' only once the renderer loads, so a GPU that
  // won't come up heals to auto on the next launch instead of bricking the app.
  const apply = async () => {
    await window.kadr.writeUserStore('gpu', node ? { node, status: 'trial' } : {})
    setSaved(node)
  }

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('settings')}</h2>

        <label className="insp-field">
          <span>{t('gpu')}</span>
          <select value={node} onChange={(e) => setNode(e.target.value)}>
            <option value="">{t('gpuAuto')}</option>
            {gpus.map((g) => (
              <option key={g.node} value={g.node}>{label(g)}</option>
            ))}
          </select>
        </label>

        {renderer && (
          <div className="dim">{t('gpuActive')}: {renderer}</div>
        )}
        {failed && <div className="export-err">{t('gpuFailedRevert')}</div>}
        <div className="dim">{t('gpuEncodeNote')}</div>

        {changed && (
          <div className="export-ok" style={{ marginTop: 8 }}>{t('gpuRestartHint')}</div>
        )}

        <div className="modal-actions">
          {changed ? (
            <button
              className="primary"
              onClick={async () => {
                await apply()
                window.kadr.relaunchApp()
              }}
            >
              {t('gpuApplyRestart')}
            </button>
          ) : null}
          <button onClick={close}>{t('close')}</button>
        </div>
      </div>
    </div>
  )
}
