import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useEditor, useSettings, usePosePresets, useFxPresets, projectDuration, uid } from './state/store'
import { PRESETS } from './presets'
import { startExport } from './engine/exporter'
import { evalAnim } from './engine/anim'
import { wireProxies } from './engine/proxy'
import {
  transcribeFlow, parseSrt, cuesToSrt, docTimeToProject, segmentsToCues
} from './engine/subtitles'
import { createFragment, ensureFragmentServer, deleteFragment } from './engine/fragments'
import { wireFragmentCapture } from './engine/fragmentCapture'
import './styles.css'

import { wireAutosave, autosaveNow, activity } from './engine/autosave'
import { autoCaptions, captionsTsx } from './engine/captions'
import { reverseClip } from './engine/reverse'
import { importFiles, wireDropDiagnostics } from './engine/mediaImport'

wireProxies()
wireFragmentCapture()
wireAutosave()
wireDropDiagnostics()

// Scripting surface for automation and AI integration (Claude Code / MCP):
// every editor operation is reachable from here.
;(window as any).kadrEditor = {
  useEditor, useSettings, usePosePresets, useFxPresets, projectDuration, uid, PRESETS, startExport, evalAnim,
  transcribe: transcribeFlow, parseSrt, cuesToSrt, docTimeToProject, segmentsToCues,
  createFragment, ensureFragmentServer, deleteFragment, autoCaptions, captionsTsx, autosaveNow, activity,
  reverseClip, importFiles
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
