import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { SidePanel } from './components/SidePanel'
import { Preview } from './components/Preview'
import { Inspector } from './components/Inspector'
import { Timeline } from './components/Timeline'
import { TransportBar, LangSwitch } from './components/TransportBar'
import { ExportDialog } from './components/ExportDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { ClaudePanel } from './components/ClaudePanel'
import { TranscribeDialog, SubtitlePanel } from './components/TextTools'
import { CaptionsDialog } from './components/CaptionsDialog'
import { ProjectFormatDialog, type Dims } from './components/ProjectFormatDialog'
import { NeonWaveDialog } from './components/NeonWaveDialog'
import { TtsSettingsDialog, SpeakDialog, refreshTtsKey } from './components/TtsDialog'
import { DefectsDialog } from './components/DefectsDialog'
import { DebugPanel } from './components/DebugPanel'
import { StoragePanel } from './components/StoragePanel'
import { Icon } from './components/icons'
import { modalsOpen } from './components/Modal'
import { rememberProject } from './engine/storage'
import { usePopout, previewHost, setPreviewSlot, dockPreviewWindow } from './engine/popout'
import { useEditor, newProject } from './state/store'
import {
  dropPayload,
  dropUsable,
  importDrop,
  importFiles,
  setProjectFormatResolver
} from './engine/mediaImport'
import { syncProjectFragments } from './engine/fragments'
import { useT, type TKey } from './i18n'
import { create } from 'zustand'
import { baseOf } from '@shared/paths'
import type { Project } from '@shared/types'
import { logError, useLog } from '@/engine/log'

// Save feedback: which project snapshot is on disk (the dirty dot) and a
// transient "saved" flash in the topbar.
const useSaveUi = create<{
  savedProject: Project | null
  flash: { key: TKey; detail: string; error: boolean } | null
}>(() => ({ savedProject: null, flash: null }))

let flashTimer: ReturnType<typeof setTimeout> | undefined
function flashSave(key: TKey, detail: string, error = false) {
  useSaveUi.setState({ flash: { key, detail, error } })
  clearTimeout(flashTimer)
  flashTimer = setTimeout(() => useSaveUi.setState({ flash: null }), 3000)
}

/** remember what's on disk now — the dirty dot goes away until the next edit */
export function markProjectSaved(p: Project) {
  useSaveUi.setState({ savedProject: p })
}

async function writeAndConfirm(path: string) {
  const s = useEditor.getState()
  try {
    await window.kadr.writeProject(path, s.project)
    s.setProjectPath(path)
    markProjectSaved(s.project)
    flashSave('saved', baseOf(path))
    void rememberProject(path)
    // fragments follow the project: loose workspace folders move next to
    // the .kadr file (first save, save-as to a new place)
    void syncProjectFragments(s.project, path)
  } catch (err) {
    flashSave('saveError', String(err), true)
  }
}

async function saveProject() {
  const s = useEditor.getState()
  let path = s.projectPath
  if (!path) {
    path = await window.kadr.saveProjectDialog(s.project.name)
    if (!path) return
  }
  await writeAndConfirm(path)
}

/** Always ask for a (new) location; the project lives there from now on. */
async function saveProjectAs() {
  const s = useEditor.getState()
  const path = await window.kadr.saveProjectDialog(s.project.name)
  if (!path) return
  await writeAndConfirm(path)
}

async function openProject() {
  const path = await window.kadr.openProjectDialog()
  if (!path) return
  const p = await window.kadr.readProject(path)
  useEditor.getState().setProject(p, path)
  markProjectSaved(useEditor.getState().project)
  void rememberProject(path)
  // restore workspace symlinks for fragments living next to the .kadr file
  // (project moved from another machine / cleaned workspace)
  void syncProjectFragments(useEditor.getState().project, path)
}

const TL_MIN = 160

export default function App() {
  const t = useT()
  const name = useEditor((s) => s.project.name)
  const project = useEditor((s) => s.project)
  const savedProject = useSaveUi((s) => s.savedProject)
  const flash = useSaveUi((s) => s.flash)
  // a fresh (empty) session isn't "unsaved work" yet
  useEffect(() => { refreshTtsKey() }, [])

  useEffect(() => {
    if (useSaveUi.getState().savedProject === null) markProjectSaved(useEditor.getState().project)
  }, [])
  const dirty = savedProject !== null && project !== savedProject
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label)
  const redoLabel = useEditor((s) => s.future[0]?.label)
  const [tlHeight, setTlHeight] = useState(() =>
    Math.min(Number(localStorage.getItem('kadr.tlh')) || 330, window.innerHeight - 220)
  )
  const [claudeOpen, setClaudeOpen] = useState(false)
  const [debugOpen, setDebugOpen] = useState(false)
  const [storageOpen, setStorageOpen] = useState(false)
  const popWin = usePopout((s) => s.win)
  // the log button stays quiet until something actually fails
  const logUnseen = useLog((s) => s.unseen)
  const [sideW, setSideW] = useState(() =>
    Math.min(640, Math.max(200, Number(localStorage.getItem('kadr.sidew')) || 280))
  )
  // New Project format dialog
  const [newProjOpen, setNewProjOpen] = useState(false)
  // "media dropped into an empty project" format prompt: the pending probe +
  // the resolver waiting for the user's pick
  const [dropFmt, setDropFmt] = useState<{ probe: Dims; resolve: (d: Dims | null) => void } | null>(null)

  useEffect(() => {
    setProjectFormatResolver((probe) => new Promise((resolve) => setDropFmt({ probe, resolve })))
    return () => setProjectFormatResolver(null)
  }, [])

  // media dropped ANYWHERE in the window is at least imported into the bin
  // (the timeline zones place clips and mark the event handled); a non-media
  // drop must not navigate the window away
  useEffect(() => {
    const over = (e: DragEvent) => e.preventDefault()
    const drop = (e: DragEvent) => {
      const handled = e.defaultPrevented
      e.preventDefault()
      if (handled || !e.dataTransfer) return
      const payload = dropPayload(e as { dataTransfer: DataTransfer })
      if (dropUsable(payload)) void importDrop(payload, null)
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      // a dialog owns the keyboard while it is open: Space on one of its
      // buttons used to press the button AND start playback behind it
      if (modalsOpen()) return
      const s = useEditor.getState()
      // e.code is keyboard-layout independent (works for ru/en)
      if (e.code === 'Space') {
        e.preventDefault()
        s.setPlaying(!s.playing)
      } else if (e.code === 'KeyS') {
        if (e.ctrlKey) {
          e.preventDefault()
          if (e.shiftKey) saveProjectAs()
          else saveProject()
        } else s.splitAtPlayhead()
      } else if (e.code === 'KeyD' || e.code === 'Delete' || e.code === 'Backspace') {
        if (s.selection.length) s.deleteSelection()
        else if (s.range) s.deleteRange()
      } else if (e.code === 'KeyZ' && e.ctrlKey) {
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
      } else if (e.code === 'KeyY' && e.ctrlKey) {
        e.preventDefault()
        s.redo()
      } else if (e.code === 'KeyC' && e.ctrlKey) {
        if (s.selection.length) s.copySelection()
        else if (s.range) s.copyRange()
      } else if (e.code === 'KeyV' && e.ctrlKey) {
        if (s.clipboard.length) {
          s.pasteAtPlayhead()
        } else {
          // nothing copied inside the editor — try the OS clipboard:
          // copied files or a copied image (e.g. from Telegram/browser)
          void window.kadr.clipboardMedia().then((paths) => {
            if (paths.length) {
              return importFiles(paths, { trackId: null, at: useEditor.getState().playhead })
            }
          }).catch((err) => logError('буфер обмена', 'вставить не удалось', err))
        }
      } else if (e.code === 'KeyU') {
        s.toggleLinkSelection()
      } else if (e.code === 'KeyM' && !e.ctrlKey && !e.altKey) {
        s.addMarker(s.playhead)
      } else if (e.code === 'ArrowLeft') {
        // step the playhead by frames; preventDefault keeps the timeline from scrolling
        e.preventDefault()
        s.setPlayhead(s.playhead - (e.shiftKey ? 1 : 1 / s.project.fps))
      } else if (e.code === 'ArrowRight') {
        e.preventDefault()
        s.setPlayhead(s.playhead + (e.shiftKey ? 1 : 1 / s.project.fps))
      } else if (e.code === 'Home') {
        e.preventDefault()
        s.setPlayhead(0)
      } else if (e.code === 'Escape') {
        if (s.animClipId) s.setAnimClip(null)
        else s.setRange(null)
      }
    }
    window.addEventListener('keydown', onKey)
    // the detached preview is a window of its own: with the focus there,
    // Space and the arrows must still drive the same transport
    popWin?.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      popWin?.removeEventListener('keydown', onKey)
    }
  }, [popWin])

  const startSideResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sideW
    const move = (ev: PointerEvent) => {
      const w = Math.min(Math.round(window.innerWidth * 0.6), Math.max(200, startW + (ev.clientX - startX)))
      setSideW(w)
      localStorage.setItem('kadr.sidew', String(w))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const startY = e.clientY
    const startH = tlHeight
    const move = (ev: PointerEvent) => {
      const h = Math.min(
        window.innerHeight - 220,
        Math.max(TL_MIN, startH + (startY - ev.clientY))
      )
      setTlHeight(h)
      localStorage.setItem('kadr.tlh', String(h))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const undoTitle = t('undo') + (undoLabel ? `: ${t(undoLabel as TKey)}` : '')
  const redoTitle = t('redo') + (redoLabel ? `: ${t(redoLabel as TKey)}` : '')

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">Kadr</span>
        <span className="project-name" title={name}>
          {name}
          {dirty && <span className="dirty-dot" title={t('unsavedChanges')} />}
        </span>
        {flash && (
          <span className={flash.error ? 'save-flash error' : 'save-flash'}>
            <Icon name={flash.error ? 'close' : 'check'} size={13} />
            {t(flash.key)}
            {flash.detail ? ` · ${flash.detail}` : ''}
          </span>
        )}
        <span className="flex1" />
        <span className="bar-group">
          <button
            className="icon-only"
            data-act="undo"
            title={undoTitle}
            aria-label={undoTitle}
            disabled={!undoLabel}
            onClick={() => useEditor.getState().undo()}
          >
            <Icon name="undo" />
          </button>
          <button
            className="icon-only"
            data-act="redo"
            title={redoTitle}
            aria-label={redoTitle}
            disabled={!redoLabel}
            onClick={() => useEditor.getState().redo()}
          >
            <Icon name="redo" />
          </button>
        </span>
        <span className="bar-group">
          <button
            data-act="new-project"
            onClick={() => {
              useEditor.getState().setProject(newProject())
              markProjectSaved(useEditor.getState().project)
            }}
          >
            <Icon name="filePlus" /> {t('newProject')}
          </button>
          <button data-act="open-project" onClick={openProject}>
            <Icon name="folderOpen" /> {t('open')}
          </button>
          <button data-act="save" onClick={saveProject} title="Ctrl+S">
            <Icon name="save" /> {t('save')}
          </button>
          <button data-act="save-as" onClick={saveProjectAs} title="Ctrl+Shift+S">{t('saveAs')}</button>
        </span>
        <button className="primary" data-act="export"
                onClick={() => useEditor.getState().setExportOpen(true)}>
          <Icon name="download" /> {t('export')}
        </button>
        <button onClick={() => setNewProjOpen(true)}>
          {t('newProject')}
        </button>
        <button
          className={`icon-only log-btn${storageOpen ? ' active' : ''}`}
          data-act="storage"
          title={t('stBtn')}
          aria-label={t('stBtn')}
          onClick={() => setStorageOpen((v) => !v)}
        >
          <Icon name="layers" />
        </button>
        <button
          className={`icon-only log-btn${logUnseen ? ' has-news' : ''}${debugOpen ? ' active' : ''}`}
          data-act="debug"
          title={t('logBtn')}
          aria-label={t('logBtn')}
          onClick={() => setDebugOpen((v) => !v)}
        >
          <Icon name="terminal" />
          {logUnseen > 0 && <span className="log-badge">{logUnseen > 99 ? '99+' : logUnseen}</span>}
        </button>
        <button
          className={claudeOpen ? 'claude-btn active' : 'claude-btn'}
          data-act="claude"
          title={t('claudeTitle')}
          onClick={() => setClaudeOpen((v) => !v)}
        >
          <Icon name="bot" /> Claude
        </button>
        <button title={t('settings')} onClick={() => useEditor.getState().setSettingsOpen(true)}>
          ⚙
        </button>
        <LangSwitch />
      </div>
      <div className="main-row">
        <SidePanel width={sideW} />
        <div className="h-resizer" onPointerDown={startSideResize} title={t('resizeCols')} />
        <div className="center-col">
          <div className={`preview-slot${popWin ? ' empty' : ''}`} ref={setPreviewSlot} />
          {popWin && (
            <div className="preview-detached">
              <Icon name="popout" size={30} />
              <span>{t('popoutHere')}</span>
              <button onClick={() => dockPreviewWindow()} data-act="popin">
                <Icon name="popin" /> {t('popoutBack')}
              </button>
            </div>
          )}
          <TransportBar />
        </div>
        <Inspector />
      </div>
      <div className="v-resizer" onPointerDown={startResize} title={t('resizeRows')} />
      <Timeline height={tlHeight} />
      <ExportDialog />
      <SettingsDialog />
      {newProjOpen && (
        <ProjectFormatDialog
          matchVideo={null}
          title={t('newProject')}
          applyLabel={t('create')}
          onApply={(d) => {
            useEditor.getState().setProject(newProject(d))
            markProjectSaved(useEditor.getState().project)
            setNewProjOpen(false)
          }}
          onClose={() => setNewProjOpen(false)}
        />
      )}
      {dropFmt && (
        <ProjectFormatDialog
          matchVideo={dropFmt.probe}
          title={t('projectFormat')}
          applyLabel={t('apply')}
          onApply={(d) => {
            dropFmt.resolve(d)
            setDropFmt(null)
          }}
          onClose={() => {
            dropFmt.resolve(null)
            setDropFmt(null)
          }}
        />
      )}
      <TranscribeDialog />
      <SubtitlePanel />
      <CaptionsDialog />
      <NeonWaveDialog />
      <TtsSettingsDialog />
      <SpeakDialog />
      <DefectsDialog />
      {claudeOpen && <ClaudePanel onClose={() => setClaudeOpen(false)} />}
      {debugOpen && <DebugPanel onClose={() => setDebugOpen(false)} />}
      {storageOpen && <StoragePanel onClose={() => setStorageOpen(false)} />}
      {/* The preview renders into one host div for the whole session; popping
          it out moves that div into another window's document, and the portal
          container never changes identity — so the GL canvas, its context and
          the fragment iframes are never rebuilt. */}
      {createPortal(<Preview />, previewHost)}
    </div>
  )
}
