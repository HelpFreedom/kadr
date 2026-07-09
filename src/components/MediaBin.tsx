import { useRef, useState } from 'react'
import { useEditor } from '@/state/store'
import { useProxyProgress } from '@/engine/proxy'
import { importFiles, dropPayload, dragHasMedia, dropUsable, importDrop, useImportUi } from '@/engine/mediaImport'
import { useTextUi } from './TextTools'
import { useT } from '@/i18n'

export function MediaBin() {
  const t = useT()
  const assets = useEditor((s) => s.project.assets)
  const texts = useEditor((s) => s.project.texts ?? [])
  const proxyJobs = useProxyProgress((s) => s.jobs)
  const [busy, setBusy] = useState(false)
  const importing = useImportUi((s) => s.active > 0)
  const [sel, setSel] = useState<string[]>([])
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null)
  const lastClick = useRef<string | null>(null)
  const [textsOpen, setTextsOpen] = useState(() => localStorage.getItem('kadr.textsOpen') !== '0')
  const toggleTexts = () => {
    setTextsOpen((v) => {
      localStorage.setItem('kadr.textsOpen', v ? '0' : '1')
      return !v
    })
  }

  async function importMedia() {
    const paths = await window.kadr.openMediaDialog()
    if (!paths.length) return
    setBusy(true)
    try {
      await importFiles(paths, null)
    } finally {
      setBusy(false)
    }
  }

  // OS files / browser image URLs dropped onto the bin are imported
  // without timeline placement
  const onBinDrop = (e: React.DragEvent) => {
    const payload = dropPayload(e)
    if (!dropUsable(payload)) return
    e.preventDefault()
    void importDrop(payload, null)
  }

  // click selects, Ctrl toggles, Shift extends from the last clicked tile
  const clickTile = (e: React.MouseEvent, id: string) => {
    if (e.ctrlKey || e.metaKey) {
      setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]))
    } else if (e.shiftKey && lastClick.current) {
      const order = assets.map((a) => a.id)
      const i0 = order.indexOf(lastClick.current)
      const i1 = order.indexOf(id)
      if (i0 >= 0 && i1 >= 0) {
        setSel(order.slice(Math.min(i0, i1), Math.max(i0, i1) + 1))
        return // shift keeps the anchor
      }
      setSel([id])
    } else {
      setSel((s) => (s.length === 1 && s[0] === id ? [] : [id]))
    }
    lastClick.current = id
  }

  /** how many timeline clips reference these assets (for the confirm text) */
  const clipsUsing = (ids: string[]) => {
    const set = new Set(ids)
    return useEditor.getState().project.tracks
      .reduce((n, tr) => n + tr.clips.filter((c) => c.assetId && set.has(c.assetId)).length, 0)
  }

  /** ✕ on a tile removes it (or the whole selection if the tile is part of it) */
  const requestDelete = (ids: string[]) => {
    if (clipsUsing(ids) > 0) setConfirmIds(ids)
    else doDelete(ids)
  }
  const doDelete = (ids: string[]) => {
    useEditor.getState().removeAssets(ids)
    setSel((s) => s.filter((x) => !ids.includes(x)))
    setConfirmIds(null)
  }

  return (
    <div className="media-bin">
      <div className="panel-head">
        <span>{t('media')}</span>
        {sel.length > 0 && (
          <button
            className="bin-del-sel"
            title={t('binDeleteSel')}
            onClick={() => requestDelete(sel)}
          >
            ✕ {sel.length}
          </button>
        )}
        <button onClick={importMedia} disabled={busy || importing}>
          {busy || importing ? '…' : t('import')}
        </button>
      </div>
      <div
        className="bin-grid"
        onDragOver={(e) => {
          if (dragHasMedia(e)) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
          }
        }}
        onDrop={onBinDrop}
      >
        {assets.length === 0 && <div className="hint">{t('emptyBin')}</div>}
        {assets.map((a) => (
          <div
            key={a.id}
            className={sel.includes(a.id) ? 'bin-item selected' : 'bin-item'}
            title={a.path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('kadr/asset', a.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            onClick={(e) => clickTile(e, a.id)}
            onDoubleClick={() => {
              const s = useEditor.getState()
              s.insertClipFromAsset(a.id, null, s.playhead)
            }}
          >
            {a.thumbnail ? (
              <img src={a.thumbnail} alt="" />
            ) : (
              <div className="bin-audio">♪</div>
            )}
            {proxyJobs[a.id] !== undefined ? (
              <div className="proxy-badge building" title={t('proxyBuilding')}>
                ⚙ {Math.round(proxyJobs[a.id] * 100)}%
              </div>
            ) : a.proxyPath ? (
              <div className="proxy-badge" title={t('proxyReady')}>
                P
              </div>
            ) : null}
            {a.hasAudio && (
              <button
                className="tr-badge"
                title={t('transcribe')}
                onClick={(e) => {
                  e.stopPropagation()
                  useTextUi.getState().openTranscribe({ kind: 'asset', assetId: a.id })
                }}
              >
                📝
              </button>
            )}
            <button
              className="bin-del"
              title={t('binDelete')}
              onClick={(e) => {
                e.stopPropagation()
                requestDelete(sel.length > 1 && sel.includes(a.id) ? sel : [a.id])
              }}
            >
              ✕
            </button>
            <div className="bin-name">{a.name}</div>
          </div>
        ))}
      </div>
      {confirmIds && (
        <div className="modal-back" onClick={() => setConfirmIds(null)}>
          <div className="modal bin-confirm" onClick={(e) => e.stopPropagation()}>
            <h2>{t('binConfirmTitle')}</h2>
            <p>
              {t('binConfirmBody')
                .replace('{files}', String(confirmIds.length))
                .replace('{clips}', String(clipsUsing(confirmIds)))}
            </p>
            <p className="dim">{t('binConfirmUndo')}</p>
            <div className="modal-actions">
              <button onClick={() => setConfirmIds(null)}>{t('cancel')}</button>
              <button className="primary danger" onClick={() => doDelete(confirmIds)}>
                {t('delete')}
              </button>
            </div>
          </div>
        </div>
      )}
      {texts.length > 0 && (
        <>
          <div
            className="panel-head texts-head"
            onClick={toggleTexts}
            title={textsOpen ? t('textsCollapse') : t('textsExpand')}
          >
            <span>{textsOpen ? '▾' : '▸'} {t('texts')} ({texts.length})</span>
          </div>
          {textsOpen && (
          <div className="text-list">
            {texts.map((d) => (
              <div className="text-item" key={d.id} title={d.path}>
                <button className="text-open" onClick={() => useTextUi.getState().openDoc(d.id)}>
                  {d.format === 'srt' ? '🎬' : '📄'} {d.name}
                </button>
                <button
                  className="preset-del"
                  title={t('delete')}
                  onClick={() => {
                    if (useTextUi.getState().openDocId === d.id) useTextUi.getState().openDoc(null)
                    useEditor.getState().removeText(d.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          )}
        </>
      )}
    </div>
  )
}
