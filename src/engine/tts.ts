// ElevenLabs voice-over: settings, and the flow that turns a text into an
// audio clip on the timeline.
//
// The API key is deliberately absent from this file and from the settings
// store: it lives in the main process (electron/tts.ts) and the renderer can
// only set it or ask whether one exists. Everything here is scriptable through
// kadr_eval, so anything held here is effectively public to the page.
import { create } from 'zustand'
import { useEditor, uid } from '../state/store'
import { dirOf, baseOf } from '@shared/paths'
import { parseSrt } from './subtitles'
import type { MediaAsset, TextDoc, TtsParams, TtsSettings, TtsVoice, VoiceRun } from '@shared/types'

export const TTS_DEFAULTS: TtsSettings = {
  voiceId: '',
  modelId: 'eleven_multilingual_v2',
  stability: 0.5,
  similarityBoost: 0.5,
  style: 0,
  speakerBoost: true,
  speed: 1,
  outputFormat: 'mp3_44100_128',
  // the 10% speed-up of the user's own script; off until asked for, so a first
  // run does not silently change the pace of the voice
  tempo: 1.1,
  tempoEnabled: false,
  defectCheck: false,
  regenerateOnConfirm: true,
  ttsqcPython: '',
  proxy: ''
}

/** Models offered in the dialog. Others still work — the id is a free field. */
export const TTS_MODELS = [
  { id: 'eleven_multilingual_v2', name: 'Multilingual v2' },
  { id: 'eleven_flash_v2_5', name: 'Flash v2.5' },
  { id: 'eleven_turbo_v2_5', name: 'Turbo v2.5' }
]

// ---------------------------------------------------------------------------
// settings: userData file is the source of truth, localStorage a warm cache
// (same scheme as pose/fx presets — a second app instance can lock the
// renderer profile and silently lose writes)

const TTS_LS_KEY = 'kadr.ttsSettings'
const TTS_FILE = 'tts-settings'

/**
 * Heal whatever comes back from disk, a script or an old version.
 *
 * The same lesson as sanitizeProject: these settings feed a dialog that renders
 * numbers, and one non-object (a `null` from an empty store, a scalar written by
 * kadr_eval) used to throw during render and take the whole editor white. A
 * settings file is never worth an unusable editor.
 */
export function sanitizeTtsSettings(v: unknown): TtsSettings {
  const src = (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as Partial<TtsSettings>
  const num = (x: unknown, d: number, lo: number, hi: number) =>
    typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d
  const str = (x: unknown, d: string) => (typeof x === 'string' ? x : d)
  return {
    voiceId: str(src.voiceId, TTS_DEFAULTS.voiceId),
    modelId: str(src.modelId, TTS_DEFAULTS.modelId) || TTS_DEFAULTS.modelId,
    stability: num(src.stability, TTS_DEFAULTS.stability, 0, 1),
    similarityBoost: num(src.similarityBoost, TTS_DEFAULTS.similarityBoost, 0, 1),
    style: num(src.style, TTS_DEFAULTS.style ?? 0, 0, 1),
    speakerBoost: typeof src.speakerBoost === 'boolean' ? src.speakerBoost : !!TTS_DEFAULTS.speakerBoost,
    speed: num(src.speed, TTS_DEFAULTS.speed ?? 1, 0.5, 2),
    outputFormat: str(src.outputFormat, TTS_DEFAULTS.outputFormat ?? 'mp3_44100_128'),
    tempo: num(src.tempo, TTS_DEFAULTS.tempo, 0.25, 4),
    tempoEnabled: !!src.tempoEnabled,
    defectCheck: !!src.defectCheck,
    regenerateOnConfirm:
      typeof src.regenerateOnConfirm === 'boolean' ? src.regenerateOnConfirm : TTS_DEFAULTS.regenerateOnConfirm,
    ttsqcPython: str(src.ttsqcPython, ''),
    proxy: str(src.proxy, '')
  }
}

function loadTtsCache(): TtsSettings {
  try {
    const raw = localStorage.getItem(TTS_LS_KEY)
    return sanitizeTtsSettings(raw ? JSON.parse(raw) : null)
  } catch {
    return { ...TTS_DEFAULTS }
  }
}

function persistTts(settings: TtsSettings) {
  window.kadr.writeUserStore(TTS_FILE, settings).catch(() => { /* disk hiccup */ })
  try {
    localStorage.setItem(TTS_LS_KEY, JSON.stringify(settings))
  } catch { /* cache only */ }
}

interface TtsSettingsState {
  settings: TtsSettings
  update(patch: Partial<TtsSettings>): void
}

export const useTtsSettings = create<TtsSettingsState>((set) => ({
  settings: loadTtsCache(),
  update: (patch) =>
    set((s) => {
      const settings = sanitizeTtsSettings({ ...s.settings, ...patch })
      persistTts(settings)
      return { settings }
    })
}))

;(async () => {
  try {
    const fromFile = await window.kadr.readUserStore(TTS_FILE)
    if (fromFile && typeof fromFile === 'object') {
      const settings = sanitizeTtsSettings(fromFile)
      useTtsSettings.setState({ settings })
      try {
        localStorage.setItem(TTS_LS_KEY, JSON.stringify(settings))
      } catch { /* cache only */ }
    }
  } catch { /* file store unavailable — cache keeps working */ }
})()

/** Params actually sent to the API: settings plus any per-call override. */
export function ttsParams(over?: Partial<TtsParams>): TtsParams {
  const s = sanitizeTtsSettings(useTtsSettings.getState().settings)
  return {
    voiceId: s.voiceId,
    modelId: s.modelId,
    stability: s.stability,
    similarityBoost: s.similarityBoost,
    style: s.style,
    speakerBoost: s.speakerBoost,
    speed: s.speed,
    outputFormat: s.outputFormat,
    ...over
  }
}

/** The speed-up to apply to a NEW voice-over. An existing one keeps its own —
    see VoiceRun.tempo, which regeneration reads instead of this. */
export function ttsTempo(): number {
  const s = sanitizeTtsSettings(useTtsSettings.getState().settings)
  return s.tempoEnabled && s.tempo > 0 ? s.tempo : 1
}

export async function loadVoices(): Promise<TtsVoice[]> {
  return window.kadr.ttsVoices(useTtsSettings.getState().settings.proxy)
}

// ---------------------------------------------------------------------------
// the flow

export interface SpeakOpts {
  /** exactly one source: literal text, a project text doc, or a file on disk */
  text?: string
  textDocId?: string
  path?: string
  /** timeline second to place the clip at; default = playhead */
  at?: number
  trackId?: string | null
  /** base name for the produced files; default = the source's name */
  name?: string
  /** directory for the wav; default = next to the project, else asked for */
  dir?: string
  params?: Partial<TtsParams>
  /** override the speed-up; default = current settings */
  tempo?: number
}

export interface SpeakResult {
  runId: string
  assetId: string
  clipId: string
  trackId: string
  path: string
  scriptPath: string
  duration: number
  tempo: number
  chunks: number
}

const sanitizeName = (s: string) =>
  s.replace(/\.[a-z0-9]{1,5}$/i, '').replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'voice'

/**
 * base.flac, base.1.flac, … — never clobber a take the user may still want.
 *
 * FLAC, а не wav: сжатие БЕЗ ПОТЕРЬ, поэтому рез, `acrossfade` и повторные
 * перегенерации остаются посемпловыми, а 12 минут речи занимают ~29 МБ вместо
 * 142 (стерео-PCM) или 71 (моно-PCM). Уже существующие .wav-озвучки читаются и
 * склеиваются как прежде — меняется только то, что пишется заново.
 */
async function freeVoiceFile(base: string): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const p = i === 0 ? `${base}.flac` : `${base}.${i}.flac`
    if ((await window.kadr.statFile(p)) === null) return p
  }
  return `${base}.${Date.now()}.flac`
}

/** srt → the spoken words only; txt → as written. */
function textOfDoc(content: string, format: 'srt' | 'txt'): string {
  if (format !== 'srt') return content
  return parseSrt(content).map((c) => c.text.replace(/\s*\n\s*/g, ' ').trim())
    .filter(Boolean).join('\n')
}

async function resolveSource(opts: SpeakOpts): Promise<{ text: string; name: string }> {
  if (opts.textDocId) {
    const doc = useEditor.getState().project.texts?.find((t) => t.id === opts.textDocId)
    if (!doc) throw new Error('текст не найден в проекте')
    const content = await window.kadr.readTextFile(doc.path)
    if (content === null) throw new Error(`не читается файл текста: ${doc.path}`)
    return { text: textOfDoc(content, doc.format), name: opts.name || doc.name }
  }
  if (opts.path) {
    const content = await window.kadr.readTextFile(opts.path)
    if (content === null) throw new Error(`не читается файл: ${opts.path}`)
    const fmt = /\.srt$/i.test(opts.path) ? 'srt' : 'txt'
    return { text: textOfDoc(content, fmt), name: opts.name || baseOf(opts.path) }
  }
  if (opts.text != null) return { text: opts.text, name: opts.name || 'voice' }
  throw new Error('нечего озвучивать: не задан ни текст, ни файл')
}

/**
 * Synthesise a text and land it on an audio track as one undoable step.
 *
 * The exact text sent to the API is written next to the audio and registered
 * as a project text document: the defect detector aligns against THAT file,
 * and its word indices are only valid while the file is unchanged.
 */
export async function speakText(opts: SpeakOpts = {}): Promise<SpeakResult> {
  const st = () => useEditor.getState()
  const { text, name } = await resolveSource(opts)
  if (!text.trim()) throw new Error('текст пуст')

  let dir = opts.dir ?? null
  if (!dir) {
    const pp = st().projectPath
    dir = pp ? dirOf(pp) : await window.kadr.pickDirectory('Куда сохранить озвучку')
    if (!dir) throw new Error('cancelled')
  }

  const base = `${dir}/${sanitizeName(name)}`
  const outPath = await freeVoiceFile(base)
  const params = ttsParams(opts.params)
  if (!params.voiceId) throw new Error('не выбран голос')
  const tempo = opts.tempo ?? ttsTempo()

  const res = await window.kadr.ttsSpeak({
    text, outPath, params, tempo,
    proxy: sanitizeTtsSettings(useTtsSettings.getState().settings).proxy
  })
  const probe = await window.kadr.probeMedia(res.path)

  const assetId = uid()
  const asset: MediaAsset = { id: assetId, ...probe.asset }
  const scriptDoc: TextDoc = {
    id: uid(),
    name: baseOf(res.scriptPath),
    path: res.scriptPath,
    format: 'txt',
    // cue-less document: it is a script, not a transcript. Absolute project
    // times would be a lie, so it stays unanchored.
    language: 'ru'
  }
  const run: VoiceRun = {
    id: uid(),
    assetId,
    scriptPath: res.scriptPath,
    scriptHash: res.scriptHash,
    duration: res.duration,
    tts: params,
    chunkRequestIds: res.requestIds,
    tempo: res.tempo,
    createdAt: Date.now()
  }

  const at = opts.at ?? st().playhead
  const placed = st().addVoiceOver({
    asset, run, texts: [scriptDoc], trackId: opts.trackId ?? null, at
  })
  if (!placed) throw new Error('не удалось положить клип на таймлайн')

  return {
    runId: run.id,
    assetId,
    clipId: placed.clipId,
    trackId: placed.trackId,
    path: res.path,
    scriptPath: res.scriptPath,
    duration: res.duration,
    tempo: res.tempo,
    chunks: res.chunks
  }
}
