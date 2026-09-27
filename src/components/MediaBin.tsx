import { useRef, useState } from 'react'
import { useEditor } from '@/state/store'
import { useProxyProgress } from '@/engine/proxy'
import { importFiles, dropPayload, dragHasMedia, dropUsable, importDrop, useImportUi } from '@/engine/mediaImport'
import { useTextUi } from './TextTools'
import { useTtsUi } from './TtsDialog'
import { useT } from '@/i18n'
import { Icon, Spinner } from './icons'
import { Modal } from './Modal'
import { useModelsUi, insertModelFragment, prepareForFragment } from '@/engine/models'

export function MediaBin() {
  const t = useT()
  const assets = useEditor((s) => s.project.assets)
  const texts = useEditor((s) => s.project.texts ?? [])
  const ttsReady = useTtsUi((s) => s.hasKey)
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

  /** the cross on a tile removes it (or the whole selection it belongs to) */
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
            data-act="delete-selected"
            title={t('binDeleteSel')}
            onClick={() => requestDelete(sel)}
          >
            <Icon name="trash" size={13} /> {sel.length}
          </button>
        )}
        <button data-act="import" onClick={importMedia} disabled={busy || importing}>
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
              <div className="bin-audio"><Icon name="audio" size={26} /></div>
            )}
            {proxyJobs[a.id] !== undefined ? (
              <div className="proxy-badge building" title={t('proxyBuilding')}>
                <Spinner size={9} /> {Math.round(proxyJobs[a.id] * 100)}%
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
                aria-label={t('transcribe')}
                onClick={(e) => {
                  e.stopPropagation()
                  useTextUi.getState().openTranscribe({ kind: 'asset', assetId: a.id })
                }}
              >
                <Icon name="captions" size={13} />
              </button>
            )}
            {a.kind === 'video' && (
              <button
                className="tr-badge frag-media-badge"
                data-act="fragment-media"
                title={t('fragmentMediaHint')}
                aria-label={t('fragmentMediaHint')}
                onClick={(e) => {
                  e.stopPropagation()
                  void prepareForFragment(a.id)
                }}
              >
                <Icon name="film" size={13} />
              </button>
            )}
            <button
              className="bin-del"
              title={t('binDelete')}
              aria-label={t('binDelete')}
              onClick={(e) => {
                e.stopPropagation()
                requestDelete(sel.length > 1 && sel.includes(a.id) ? sel : [a.id])
              }}
            >
              <Icon name="close" size={13} />
            </button>
            <div className="bin-name">{a.name}</div>
          </div>
        ))}
      </div>
      <ModelsSection />
      {confirmIds && (
        <Modal
          title={t('binConfirmTitle')}
          className="bin-confirm"
          onClose={() => setConfirmIds(null)}
          actions={
            <>
              <button onClick={() => setConfirmIds(null)}>{t('cancel')}</button>
              <button className="primary danger" onClick={() => doDelete(confirmIds)}>
                <Icon name="trash" /> {t('delete')}
              </button>
            </>
          }
        >
          <p>
            {t('binConfirmBody')
              .replace('{files}', String(confirmIds.length))
              .replace('{clips}', String(clipsUsing(confirmIds)))}
          </p>
          <p className="dim">{t('binConfirmUndo')}</p>
        </Modal>
      )}
      {texts.length > 0 && (
        <>
          <div
            className="panel-head texts-head"
            onClick={toggleTexts}
            title={textsOpen ? t('textsCollapse') : t('textsExpand')}
          >
            <span>
              <Icon name={textsOpen ? 'chevronDown' : 'chevronRight'} size={13} />
              {t('texts')} ({texts.length})
            </span>
          </div>
          {textsOpen && (
          <div className="text-list">
            {texts.map((d) => (
              <div className="text-item" key={d.id} title={d.path}>
                <button className="text-open" onClick={() => useTextUi.getState().openDoc(d.id)}>
                  <Icon name={d.format === 'srt' ? 'srt' : 'doc'} size={13} /> {d.name}
                </button>
                {ttsReady && (
                  <button
                    className="text-speak"
                    title={t('ttsBadge')}
                    aria-label={t('ttsBadge')}
                    onClick={() => useTtsUi.getState().openSpeak({ kind: 'doc', docId: d.id })}
                  >
                    <Icon name="speech" size={14} />
                  </button>
                )}
                <button
                  className="preset-del"
                  title={t('delete')}
                  aria-label={t('delete')}
                  onClick={() => {
                    if (useTextUi.getState().openDocId === d.id) useTextUi.getState().openDoc(null)
                    useEditor.getState().removeText(d.id)
                  }}
                >
                  <Icon name="close" size={13} />
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

/**
 * The project's 3D models (kadr-lib/models): a tile per model with its
 * thumbnail and real size; a double click (or the play badge) puts a ready 3D
 * fragment on the timeline at the playhead. Fragments use them as
 * `import m from '@lib/models/<name>.glb'` + useModel(m) from '@kadr/three'.
 */
function ModelsSection() {
  const t = useT()
  const models = useModelsUi((s) => s.models)
  const busy = useModelsUi((s) => s.busy)
  const [open, setOpen] = useState(() => localStorage.getItem('kadr.modelsOpen') !== '0')
  const [err, setErr] = useState('')
  if (!models.length && !busy) return null
  const toggle = () => setOpen((v) => { localStorage.setItem('kadr.modelsOpen', v ? '0' : '1'); return !v })
  const insert = (name: string) => {
    setErr('')
    insertModelFragment(name).catch((e) => setErr(String((e as Error)?.message ?? e)))
  }
  return (
    <>
      <div className="panel-head texts-head" onClick={toggle} title={open ? t('textsCollapse') : t('textsExpand')}>
        <span>
          <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
          {t('models3d')} ({models.length}){busy > 0 && <> <Spinner size={10} /></>}
        </span>
      </div>
      {open && (
        <div className="bin-grid">
          {models.map((m) => (
            <div key={m.name} className="bin-item model" data-model={m.name}
                 title={`${m.source}\n${m.parts.length} ${t('modelParts')} · ${m.trianglesOut} ${t('modelTris')}\nimport ${m.name.replace(/[^a-zA-Z0-9_$]/g, '_')} from '@lib/models/${m.file}'`}
                 onDoubleClick={() => insert(m.name)}>
              <img src={window.kadr.fileUrl(`${m.dir}/${m.thumb}`)} alt="" crossOrigin="anonymous" />
              <button className="tr-badge" data-act="model-insert" title={t('modelInsert')} aria-label={t('modelInsert')}
                      onClick={(e) => { e.stopPropagation(); insert(m.name) }}>
                <Icon name="play" size={13} />
              </button>
              <div className="bin-name">{m.name} · {m.sizeMm.map((x) => Math.round(x)).join('×')} {t('mm')}</div>
            </div>
          ))}
        </div>
      )}
      {err && <div className="tr-error"><Icon name="alert" size={15} /><span>{err}</span></div>}
    </>
  )
}
