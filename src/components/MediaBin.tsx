import { useState } from 'react'
import { useEditor, uid } from '@/state/store'
import { useProxyProgress } from '@/engine/proxy'
import { useTextUi } from './TextTools'
import { useT } from '@/i18n'

const EMPTY_TEXTS: never[] = []

export function MediaBin() {
  const t = useT()
  const assets = useEditor((s) => s.project.assets)
  const texts = useEditor((s) => s.project.texts ?? EMPTY_TEXTS)
  const proxyJobs = useProxyProgress((s) => s.jobs)
  const [busy, setBusy] = useState(false)
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
      const textDocs = []
      for (const path of paths) {
        const ext = path.split('.').pop()?.toLowerCase()
        if (ext === 'srt' || ext === 'txt') {
          textDocs.push({
            id: uid(),
            name: path.split('/').pop()!,
            path,
            format: ext as 'srt' | 'txt'
          })
          continue
        }
        try {
          const { asset } = await window.kadr.probeMedia(path)
          useEditor.getState().addAsset({ id: uid(), ...asset })
        } catch (err) {
          console.error('probe failed', path, err)
        }
      }
      if (textDocs.length) useEditor.getState().addTexts(textDocs)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="media-bin">
      <div className="panel-head">
        <span>{t('media')}</span>
        <button onClick={importMedia} disabled={busy}>
          {busy ? '…' : t('import')}
        </button>
      </div>
      <div className="bin-grid">
        {assets.length === 0 && <div className="hint">{t('emptyBin')}</div>}
        {assets.map((a) => (
          <div
            key={a.id}
            className="bin-item"
            title={a.path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('kadr/asset', a.id)
              e.dataTransfer.effectAllowed = 'copy'
            }}
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
            <div className="bin-name">{a.name}</div>
          </div>
        ))}
      </div>
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
