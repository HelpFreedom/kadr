import { useEffect, useState } from 'react'
import type { GpuInfo } from '@shared/types'
import { useEditor } from '@/state/store'
import { useT } from '@/i18n'
import { Modal } from './Modal'
import { Icon } from './icons'

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
  const [node, setNode] = useState('') // dropdown selection ('' = auto)
  const [savedNode, setSavedNode] = useState('')
  const [savedStatus, setSavedStatus] = useState<string | undefined>(undefined)
  const [renderer] = useState(activeRenderer)

  useEffect(() => {
    if (!open) return
    let alive = true
    void (async () => {
      const [list, choice] = await Promise.all([
        window.kadr.gpuList(),
        window.kadr.readUserStore('gpu') as Promise<{ node?: string; status?: string } | null>
      ])
      if (!alive) return
      setGpus(list)
      setSavedNode(choice?.node ?? '')
      setSavedStatus(choice?.status)
      const chosen = list.find((g) => g.node === choice?.node)
      const matches = !!chosen && renderer.toUpperCase().includes(chosen.vendor.toUpperCase())
      setNode(choice?.node && (choice.status === 'ok' || matches) ? choice.node : '')
    })()
    return () => {
      alive = false
    }
  }, [open])

  if (!open) return null

  const label = (g: GpuInfo) =>
    `${g.vendor} (${g.integrated ? t('gpuIntegrated') : t('gpuDiscrete')})`

  const chosen = gpus.find((g) => g.node === savedNode)
  const rendererMatches = !!chosen && renderer.toUpperCase().includes(chosen.vendor.toUpperCase())
  // The trial GPU is actually driving the window (we can see it, and its vendor
  // shows in the live renderer) but hasn't been kept yet — offer to keep it.
  const trialPending = savedStatus !== 'ok' && !!savedNode && rendererMatches
  // A chosen GPU that didn't come up: it's on disk but the app fell back to auto.
  const reverted = savedStatus !== 'ok' && !!savedNode && !rendererMatches
  const effectiveSaved = savedNode && (savedStatus === 'ok' || trialPending) ? savedNode : ''
  const changed = node !== effectiveSaved

  const applyRestart = async () => {
    // written as a 'trial': main flips it to 'failed' before the window opens
    // and it only becomes 'ok' when the user keeps it below — so a GPU that
    // comes up blank (or not at all) heals back to auto on the next launch.
    await window.kadr.writeUserStore('gpu', node ? { node, status: 'trial' } : {})
    window.kadr.relaunchApp()
  }

  const keep = () => {
    window.kadr.gpuConfirm()
    setSavedStatus('ok')
  }

  return (
    <Modal
      title={t('settings')}
      onClose={close}
      titleIcon={<Icon name="gpu" size={17} />}
      wide
      actions={
        <>
          <button onClick={close}>{t('close')}</button>
          {trialPending && !changed && (
            <button className="primary" onClick={keep}>{t('gpuKeep')}</button>
          )}
          {changed && (
            <button className="primary" onClick={applyRestart}>
              <Icon name="again" /> {t('gpuApplyRestart')}
            </button>
          )}
        </>
      }
    >
      <label className="insp-field">
        <span>{t('gpu')}</span>
        <select value={node} onChange={(e) => setNode(e.target.value)}>
          <option value="">{t('gpuAuto')}</option>
          {gpus.map((g) => (
            <option key={g.node} value={g.node}>{label(g)}</option>
          ))}
        </select>
      </label>

      {renderer && <div className="dim hint-inline">{t('gpuActive')}: {renderer}</div>}
      {reverted && <div className="export-err">{t('gpuFailedRevert')}</div>}
      <div className="dim hint-inline">{t('gpuEncodeNote')}</div>

      {trialPending && !changed && <div className="export-ok">{t('gpuTrialAsk')}</div>}
      {changed && <div className="export-ok">{t('gpuRestartHint')}</div>}
    </Modal>
  )
}
