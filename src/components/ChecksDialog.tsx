// «Проверка»: run the checks of src/engine/checks.ts over the fragment clips
// and list what they found; a click on a line puts the playhead there.
import { useState } from 'react'
import { useEditor } from '@/state/store'
import { runChecks, useChecksUi, CHECK_LIMITS, type CheckIssue } from '@/engine/checks'
import { useT } from '@/i18n'
import { Icon, Spinner } from './icons'
import { Modal } from './Modal'

export function ChecksDialog() {
  const t = useT()
  const open = useChecksUi((s) => s.open)
  const running = useChecksUi((s) => s.running)
  const result = useChecksUi((s) => s.result)
  const [pixels, setPixels] = useState(false)
  const [collisions, setCollisions] = useState(false)
  const [error, setError] = useState('')
  const [showInfo, setShowInfo] = useState(false)
  if (!open) return null

  const close = () => { if (!running) useChecksUi.getState().setOpen(false) }
  const run = async () => {
    setError('')
    try {
      await runChecks({ pixels, collisions })
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }
  const warns = result?.issues.filter((i) => i.level === 'warn') ?? []
  const infos = result?.issues.filter((i) => i.level === 'info') ?? []
  const shown = showInfo ? result?.issues ?? [] : warns
  const go = (i: CheckIssue) => useEditor.getState().setPlayhead(Math.max(0, i.t))

  return (
    <Modal
      title={t('checksTitle')}
      onClose={close}
      titleIcon={<Icon name="check" size={17} />}
      closeDisabled={running}
      actions={
        <>
          <button onClick={close} disabled={running}>{t('close')}</button>
          <button className="primary" onClick={run} disabled={running} data-act="checks-run">{t('checksRun')}</button>
        </>
      }
    >
      <div className="dim">{t('checksHint')}</div>
      <label className="anim-check">
        <input type="checkbox" checked={pixels} disabled={running} onChange={(e) => setPixels(e.target.checked)} />{' '}
        {t('checksPixels')}
      </label>
      <label className="anim-check">
        <input type="checkbox" checked={collisions} disabled={running} onChange={(e) => setCollisions(e.target.checked)} />{' '}
        {t('checksCollisions')}
      </label>
      <div className="dim">
        {t('checksRules')
          .replace('{beat}', String(CHECK_LIMITS.beatMs))
          .replace('{move}', String(CHECK_LIMITS.textMovePxPerSec))}
      </div>
      {running && (
        <div className="export-progress">
          <Spinner /> <span className="dim tr-live">{t('checksWorking')}</span>
        </div>
      )}
      {result && !running && (
        <>
          <div className="tr-live" data-checks-summary>
            {t('checksSummary')
              .replace('{clips}', String(result.checked.clips))
              .replace('{events}', String(result.checked.events))
              .replace('{texts}', String(result.checked.texts))
              .replace('{warns}', String(warns.length))}
            {infos.length > 0 && (
              <>
                {' · '}
                <button className="ghost" onClick={() => setShowInfo(!showInfo)}>
                  {showInfo ? t('checksHideInfo') : t('checksShowInfo').replace('{n}', String(infos.length))}
                </button>
              </>
            )}
          </div>
          {shown.length > 0 && (
            <ul className="checks-list">
              {shown.map((i, k) => (
                <li key={k} className={i.level}>
                  <button onClick={() => go(i)} title={t('checksGo')}>
                    <Icon name={i.level === 'warn' ? 'alert' : 'circle'} size={13} />
                    <span>{i.message}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!warns.length && <div className="dim">{t('checksClean')}</div>}
        </>
      )}
      {error && (
        <div className="tr-error"><Icon name="alert" size={15} /><span>{error}</span></div>
      )}
    </Modal>
  )
}
