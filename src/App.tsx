import { useEffect, useState } from 'react'
import { SidePanel } from './components/SidePanel'
import { Preview } from './components/Preview'
import { Inspector } from './components/Inspector'
import { Timeline } from './components/Timeline'
import { TransportBar, LangSwitch } from './components/TransportBar'
import { ExportDialog } from './components/ExportDialog'
import { ClaudePanel } from './components/ClaudePanel'
import { TranscribeDialog, SubtitlePanel } from './components/TextTools'
import { CaptionsDialog } from './components/CaptionsDialog'
import { useEditor, newProject } from './state/store'
import { useT, type TKey } from './i18n'

async function saveProject() {
  const s = useEditor.getState()
  let path = s.projectPath
  if (!path) {
    path = await window.kadr.saveProjectDialog(s.project.name)
    if (!path) return
  }
  await window.kadr.writeProject(path, s.project)
  s.setProjectPath(path)
}

/** Always ask for a (new) location; the project lives there from now on. */
async function saveProjectAs() {
  const s = useEditor.getState()
  const path = await window.kadr.saveProjectDialog(s.project.name)
  if (!path) return
  await window.kadr.writeProject(path, s.project)
  s.setProjectPath(path)
}

async function openProject() {
  const path = await window.kadr.openProjectDialog()
  if (!path) return
  const p = await window.kadr.readProject(path)
  useEditor.getState().setProject(p, path)
}

const TL_MIN = 160

export default function App() {
  const t = useT()
  const name = useEditor((s) => s.project.name)
  const undoLabel = useEditor((s) => s.past[s.past.length - 1]?.label)
  const redoLabel = useEditor((s) => s.future[0]?.label)
  const [tlHeight, setTlHeight] = useState(() =>
    Math.min(Number(localStorage.getItem('kadr.tlh')) || 330, window.innerHeight - 220)
  )
  const [claudeOpen, setClaudeOpen] = useState(false)
  const [sideW, setSideW] = useState(() =>
    Math.min(640, Math.max(200, Number(localStorage.getItem('kadr.sidew')) || 280))
  )

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
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
        s.pasteAtPlayhead()
      } else if (e.code === 'KeyU') {
        s.toggleLinkSelection()
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
    return () => window.removeEventListener('keydown', onKey)
  }, [])

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
        <span className="project-name">{name}</span>
        <span className="flex1" />
        <button title={undoTitle} disabled={!undoLabel} onClick={() => useEditor.getState().undo()}>
          ↶ {t('undoShort')}
        </button>
        <button title={redoTitle} disabled={!redoLabel} onClick={() => useEditor.getState().redo()}>
          ↷ {t('redoShort')}
        </button>
        <button onClick={() => useEditor.getState().setProject(newProject())}>{t('newProject')}</button>
        <button onClick={openProject}>{t('open')}</button>
        <button onClick={saveProject} title="Ctrl+S">{t('save')}</button>
        <button onClick={saveProjectAs} title="Ctrl+Shift+S">{t('saveAs')}</button>
        <button className="primary" onClick={() => useEditor.getState().setExportOpen(true)}>
          {t('export')}
        </button>
        <button
          className={claudeOpen ? 'claude-btn active' : 'claude-btn'}
          title={t('claudeTitle')}
          onClick={() => setClaudeOpen((v) => !v)}
        >
          🤖 Claude
        </button>
        <LangSwitch />
      </div>
      <div className="main-row">
        <SidePanel width={sideW} />
        <div className="h-resizer" onPointerDown={startSideResize} title="⇔" />
        <div className="center-col">
          <Preview />
          <TransportBar />
        </div>
        <Inspector />
      </div>
      <div className="v-resizer" onPointerDown={startResize} title="⇕" />
      <Timeline height={tlHeight} />
      <ExportDialog />
      <TranscribeDialog />
      <SubtitlePanel />
      <CaptionsDialog />
      {claudeOpen && <ClaudePanel onClose={() => setClaudeOpen(false)} />}
    </div>
  )
}
