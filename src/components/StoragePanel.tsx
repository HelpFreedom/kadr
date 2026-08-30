import { useCallback, useEffect, useState } from 'react'
import type { StorageGroupId, StorageScan } from '@shared/types'
import { scanStorage, pruneStorage } from '@/engine/storage'
import { logError } from '@/engine/log'
import { useT, type TKey } from '@/i18n'
import { Icon } from './icons'

const NAME: Record<StorageGroupId, TKey> = {
  proxies: 'stProxies',
  decoded: 'stDecoded',
  fragments: 'stFragments',
  ttsqcCache: 'stTtsqcCache',
  reversed: 'stReversed',
  imported: 'stImported',
  voiceRuns: 'stVoiceRuns'
}
const ABOUT: Record<StorageGroupId, TKey> = {
  proxies: 'stProxiesAbout',
  decoded: 'stDecodedAbout',
  fragments: 'stFragmentsAbout',
  ttsqcCache: 'stTtsqcCacheAbout',
  reversed: 'stReversedAbout',
  imported: 'stImportedAbout',
  voiceRuns: 'stVoiceRunsAbout'
}

/** bytes → «1.4 ГБ»: the number is for a human, the unit comes from i18n */
function size(n: number, t: (k: TKey) => string): string {
  if (n < 1024) return `${n} ${t('stB')}`
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)} ${t('stKB')}`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} ${t('stMB')}`
  return `${(n / 1024 ** 3).toFixed(2)} ${t('stGB')}`
}

/** Projects are routinely all called "Untitled", so the folder is what
 *  actually tells them apart in a list. */
const shortPath = (id: string, t: (k: TKey) => string) =>
  id === '#open' ? t('stOpenProject') : id.split('/').slice(-2).join('/')

type Ask = { group: StorageGroupId; scope: 'stale' | 'project'; project?: string; files: number; bytes: number }

export function StoragePanel({ onClose }: { onClose: () => void }) {
  const t = useT()
  const [scan, setScan] = useState<StorageScan | null>(null)
  const [busy, setBusy] = useState(false)
  const [ask, setAsk] = useState<Ask | null>(null)
  const [freed, setFreed] = useState<{ removed: number; bytes: number } | null>(null)
  const [open, setOpen] = useState<StorageGroupId | null>(null)

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setScan(await scanStorage())
    } catch (err) {
      logError('хранилище', 'не удалось посчитать занятое место', err)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const run = async (a: Ask) => {
    setBusy(true)
    setAsk(null)
    try {
      const r = await pruneStorage({ group: a.group, scope: a.scope, project: a.project })
      if (r.error) logError('хранилище', `удаление отклонено: ${r.error}`)
      else setFreed({ removed: r.removed, bytes: r.bytes })
      // re-count instead of showing what was just deleted: a line that still
      // claims 2.5 GB after freeing them is simply a lie
      setScan(await scanStorage())
    } catch (err) {
      logError('хранилище', 'удалить не удалось', err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="storage-panel">
      <div className="claude-head">
        <span><Icon name="layers" size={15} /> {t('stTitle')}</span>
        <span className="dim claude-hint">
          {scan
            ? `${t('stTotal')} ${size(scan.totalBytes, t)}${
                scan.freeBytes ? ` · ${t('stFree')} ${size(scan.freeBytes, t)}` : ''}`
            : '…'}
        </span>
        <button className="icon-only" title={t('stRefresh')} aria-label={t('stRefresh')}
                disabled={busy} onClick={() => void refresh()}>
          <Icon name="reload" size={14} />
        </button>
        <button className="claude-close" title={t('close')} aria-label={t('close')} onClick={onClose}>
          <Icon name="close" size={15} />
        </button>
      </div>

      <div className="storage-body">
        {freed && (
          <div className="ln-done">
            <Icon name="check" size={14} /> {t('stFreed')} {freed.removed} · {size(freed.bytes, t)}
          </div>
        )}
        {!scan && <div className="hint">{t('stCounting')}</div>}
        {scan?.groups.map((g) => {
          const expanded = open === g.id
          return (
            <div className={`st-group${g.rebuildable ? '' : ' kept'}`} key={g.id}>
              <button className="st-head" onClick={() => setOpen(expanded ? null : g.id)}>
                <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={13} />
                <span className="st-name">{t(NAME[g.id])}</span>
                <span className={`st-tag ${g.rebuildable ? 'ok' : 'kept'}`}>
                  {t(g.rebuildable ? 'stRebuildable' : 'stKept')}
                </span>
                <span className="st-size">{size(g.bytes, t)}</span>
                <span className="st-files">{g.files}</span>
              </button>
              {expanded && (
                <div className="st-detail">
                  <div className="dim hint-inline">{t(ABOUT[g.id])}</div>
                  <div className="dim hint-inline st-dir">{g.dir}</div>
                  {g.attributed ? (
                    <>
                      {g.byProject.map((p) => (
                        <div className="st-row" key={p.id} title={p.id}>
                          <span className="st-proj">
                            {p.name}
                            <span className="st-path">{shortPath(p.id, t)}</span>
                          </span>
                          <span className="st-size">{size(p.bytes, t)}</span>
                          <span className="st-files">{p.files}</span>
                          <button
                            disabled={busy || !g.rebuildable}
                            title={g.rebuildable ? t('stDropProject') : t('stKeptHint')}
                            onClick={() => setAsk({
                              group: g.id, scope: 'project', project: p.id,
                              files: p.files, bytes: p.bytes
                            })}
                          >
                            <Icon name="trash" size={13} /> {t('stDrop')}
                          </button>
                        </div>
                      ))}
                      <div className="st-row stale">
                        <span className="st-proj">{t('stNobody')}</span>
                        <span className="st-size">{size(g.stale.bytes, t)}</span>
                        <span className="st-files">{g.stale.files}</span>
                        <button
                          disabled={busy || g.stale.files === 0}
                          title={t('stDropStale')}
                          onClick={() => setAsk({
                            group: g.id, scope: 'stale', files: g.stale.files, bytes: g.stale.bytes
                          })}
                        >
                          <Icon name="trash" size={13} /> {t('stDrop')}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="st-row">
                      <span className="st-proj">{t('stShared')}</span>
                      <span className="st-size">{size(g.bytes, t)}</span>
                      <span className="st-files">{g.files}</span>
                      <button
                        disabled={busy || g.files === 0}
                        onClick={() => setAsk({
                          group: g.id, scope: 'stale', files: g.files, bytes: g.bytes
                        })}
                      >
                        <Icon name="trash" size={13} /> {t('stDrop')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}

        {scan && (
          <div className="dim hint-inline st-known">
            {t('stKnown')} {scan.projects.map((p) => shortPath(p.id, t)).join(' · ') || '—'}
            <div>{t('stKnownHint')}</div>
          </div>
        )}
      </div>

      {ask && (
        <div className="st-confirm">
          <div className="tr-error">
            <Icon name="alert" size={15} />
            <span>
              {t(scan?.groups.find((g) => g.id === ask.group)?.rebuildable ? 'stAskRebuild' : 'stAskKept')}
              {' '}{ask.files} · {size(ask.bytes, t)}
            </span>
          </div>
          <div className="modal-actions">
            <button onClick={() => setAsk(null)}>{t('cancel')}</button>
            <button className="primary danger" disabled={busy} onClick={() => void run(ask)}>
              <Icon name="trash" /> {t('stDeleteNow')}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
