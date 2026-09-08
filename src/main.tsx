import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { useEditor, useSettings, usePosePresets, useFxPresets, projectDuration, uid, newClipDefaults } from './state/store'
import { PRESETS } from './presets'
import { startExport } from './engine/exporter'
import { evalAnim } from './engine/anim'
import { wireProxies } from './engine/proxy'
import { wireLog, useLog, logInfo, logWarn, logError, logAsText, clearLog } from './engine/log'
import {
  transcribeFlow, parseSrt, cuesToSrt, docTimeToProject, segmentsToCues
} from './engine/subtitles'
import { createFragment, ensureFragmentServer, deleteFragment, syncProjectFragments } from './engine/fragments'
import { wireFragmentCapture } from './engine/fragmentCapture'
import './styles.css'

import { wireAutosave, autosaveNow, activity } from './engine/autosave'
import { autoCaptions, captionsTsx } from './engine/captions'
import { reverseClip } from './engine/reverse'
import { importFiles, wireDropDiagnostics } from './engine/mediaImport'
import { snapshotFrame } from './engine/snapshot'
import { usePopout, openPreviewWindow, dockPreviewWindow, togglePreviewWindow } from './engine/popout'
import { wireExportChime } from './engine/chime'
import { normalizeClip } from './engine/normalize'
import { neonWave, neonWaveTsx, NEON_WAVE_DEFAULTS } from './engine/neonWave'
import { speakText, useTtsSettings, ttsParams, ttsTempo, loadVoices, sanitizeTtsSettings, TTS_DEFAULTS } from './engine/tts'
import { useTtsUi } from './components/TtsDialog'
import { useDefectsUi } from './components/DefectsDialog'
import { checkVoice, cancelCheck, addUserDefect, setVerdict, clearVerdict, useVoiceUi, selfTestDetector, setDefectsHidden } from './engine/voiceCheck'
import { srcToProject, spanToProject, projectToSrc, placeDefects } from './engine/voiceDefects'
import { regenerateDefects, confirmDefect } from './engine/voiceRegen'
import { flushVerdicts, flushAllVerdicts, learnStatus, retrain } from './engine/voiceLearn'
import { scanVoiceVersions, pruneVoiceVersions } from './engine/voiceVersions'

wireLog()   // first: everything below may want to report a failure
wireProxies()
wireFragmentCapture()
wireExportChime()
wireAutosave()
wireDropDiagnostics()

// Scripting surface for automation and AI integration (Claude Code / MCP):
// every editor operation is reachable from here.
;(window as any).kadrEditor = {
  useEditor, useSettings, usePosePresets, useFxPresets, projectDuration, uid, newClipDefaults,
  PRESETS, startExport, evalAnim,
  transcribe: transcribeFlow, parseSrt, cuesToSrt, docTimeToProject, segmentsToCues,
  createFragment, ensureFragmentServer, deleteFragment, autoCaptions, captionsTsx, autosaveNow, activity,
  reverseClip, importFiles, snapshotFrame, normalizeClip, syncProjectFragments,
  usePopout, openPreviewWindow, dockPreviewWindow, togglePreviewWindow,
  neonWave, neonWaveTsx, NEON_WAVE_DEFAULTS,
  speakText, useTtsSettings, ttsParams, ttsTempo, loadVoices, sanitizeTtsSettings, TTS_DEFAULTS,
  useTtsUi, useDefectsUi,
  checkVoice, cancelCheck, addUserDefect, setVerdict, clearVerdict, useVoiceUi,
  selfTestDetector, setDefectsHidden, srcToProject, spanToProject, projectToSrc, placeDefects,
  regenerateDefects, confirmDefect,
  flushVerdicts, flushAllVerdicts, learnStatus, retrain,
  scanVoiceVersions, pruneVoiceVersions,
  // the session log, so the embedded Claude can answer "почему не сработало?"
  // by reading what actually failed instead of guessing
  useLog, logInfo, logWarn, logError, logAsText, clearLog
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
