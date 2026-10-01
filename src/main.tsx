import React from 'react'
import ReactDOM from 'react-dom/client'
import App, { openProjectAt } from './App'
import { useEditor, useSettings, usePosePresets, useFxPresets, projectDuration, uid, newClipDefaults, snapPoints } from './state/store'
import { PRESETS } from './presets'
import { startExport } from './engine/exporter'
import { evalAnim } from './engine/anim'
import { wireProxies } from './engine/proxy'
import { wireLog, useLog, logInfo, logWarn, logError, logAsText, clearLog } from './engine/log'
import {
  transcribeFlow, parseSrt, cuesToSrt, docTimeToProject, segmentsToCues
} from './engine/subtitles'
import { createFragment, ensureFragmentServer, deleteFragment, syncProjectFragments } from './engine/fragments'
import { wireFragmentCapture, fragmentNeedsCapture } from './engine/fragmentCapture'
import './styles.css'

import { wireAutosave, autosaveNow, activity } from './engine/autosave'
import { autoCaptions, captionsTsx } from './engine/captions'
import { reverseClip } from './engine/reverse'
import { importFiles, wireDropDiagnostics } from './engine/mediaImport'
import { snapshotFrame, contactSheet } from './engine/snapshot'
import { runChecks, readingTime, cameraJerks, CHECK_LIMITS, useChecksUi } from './engine/checks'
import { importModels, refreshModels, insertModelFragment, modelFragmentTsx, useModelsUi, wireModels, prepareForFragment } from './engine/models'
import { useFragmentParams, setParam, resetParams, flushParamSaves } from './engine/fragmentParams'
import { useOnion, setOnion, toggleOnion, wireOnion } from './engine/onion'
import { audioStats, silencePreview, wirePreviewLimiter } from './engine/audio'
import limiterUrl from './engine/limiter.worklet.ts?worker&url'
import { previewPoolStats } from './engine/player'
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
import { detectBeats, clearBeats, beatTimes, useBeatsUi } from './engine/beats'
import { bakeAudio, bakeState, bakePlan, refreshStaleBakes } from './engine/audioReact'
import { loadSoundLibrary, findSfx, addSound, setSoundMeta, sfxFamilies, SFX_FAMILIES, SFX_USES } from './engine/sounds'
import { useSoundsUi } from './components/SoundsDialog'

wireLog()   // first: everything below may want to report a failure
wirePreviewLimiter(limiterUrl)
wireProxies()
wireFragmentCapture()
wireExportChime()
wireAutosave()
wireDropDiagnostics()
wireModels()
wireOnion()

// Tell main which GPU WebGL really runs on (electron/gpu.ts falls back to the
// default one when the discrete GPU was asked for and this says otherwise).
{
  let name = 'none'
  try {
    const gl = document.createElement('canvas').getContext('webgl2')
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info')
      name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER))
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }
  } catch { /* 'none' */ }
  void window.kadr.gpuReport?.(name).then((mode) => logInfo('видеокарта', `${name} (${mode === 'discrete' ? 'дискретная' : 'по умолчанию'})`))
}

// Scripting surface for automation and AI integration (Claude Code / MCP):
// every editor operation is reachable from here.
;(window as any).kadrEditor = {
  useEditor, useSettings, usePosePresets, useFxPresets, projectDuration, uid, newClipDefaults,
  PRESETS, startExport, evalAnim, openProject: openProjectAt,
  transcribe: transcribeFlow, parseSrt, cuesToSrt, docTimeToProject, segmentsToCues,
  createFragment, ensureFragmentServer, deleteFragment, fragmentNeedsCapture, autoCaptions, captionsTsx, autosaveNow, activity,
  reverseClip, importFiles, snapshotFrame, contactSheet, normalizeClip, syncProjectFragments,
  runChecks, readingTime, cameraJerks, CHECK_LIMITS, useChecksUi,
  importModels, refreshModels, insertModelFragment, modelFragmentTsx, useModelsUi, prepareForFragment,
  useFragmentParams, setParam, resetParams, flushParamSaves, useOnion, setOnion, toggleOnion,
  audioStats, silencePreview, previewPoolStats,
  usePopout, openPreviewWindow, dockPreviewWindow, togglePreviewWindow,
  neonWave, neonWaveTsx, NEON_WAVE_DEFAULTS,
  speakText, useTtsSettings, ttsParams, ttsTempo, loadVoices, sanitizeTtsSettings, TTS_DEFAULTS,
  useTtsUi, useDefectsUi,
  checkVoice, cancelCheck, addUserDefect, setVerdict, clearVerdict, useVoiceUi,
  selfTestDetector, setDefectsHidden, srcToProject, spanToProject, projectToSrc, placeDefects,
  regenerateDefects, confirmDefect,
  flushVerdicts, flushAllVerdicts, learnStatus, retrain,
  scanVoiceVersions, pruneVoiceVersions,
  // music: beats as snap-able markers, the sound under a fragment baked into it,
  // and the bundled sound library (resources/, credits in resources/CREDITS.md)
  detectBeats, clearBeats, beatTimes, useBeatsUi, snapPoints,
  bakeAudio, bakeState, bakePlan, refreshStaleBakes,
  loadSoundLibrary, findSfx, addSound, setSoundMeta, sfxFamilies, SFX_FAMILIES, SFX_USES, useSoundsUi,
  // the session log, so the embedded Claude can answer "почему не сработало?"
  // by reading what actually failed instead of guessing
  useLog, logInfo, logWarn, logError, logAsText, clearLog
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
