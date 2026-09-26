// Core project model shared between main and renderer processes.
// All times are in seconds, all dimensions in pixels.

export type AssetKind = 'video' | 'audio' | 'image'

/** Audacity-style waveform: per-bin peak and RMS, base64-encoded Uint8 (0..255). */
export interface WaveformData {
  /** bins per second */
  rate: number
  max: string
  rms: string
}

export interface MediaAsset {
  id: string
  path: string
  name: string
  kind: AssetKind
  duration: number // images: 0 (clip decides)
  width: number
  height: number
  fps: number
  hasAudio: boolean
  /** data: URL of a poster frame, generated on import */
  thumbnail?: string
  /** poster of the last frame (clip tails show it on the timeline) */
  thumbnailEnd?: string
  waveform?: WaveformData
  /** ffprobe codec_name of the video stream (e.g. 'h264', 'hevc') — decides
      whether Chromium can decode the source or ffmpeg must step in */
  codec?: string
  /** video carries an alpha channel (yuva pix_fmt or WebM alpha_mode tag) —
      proxies/intermediates must preserve it (VP9+alpha WebM, not H.264) */
  hasAlpha?: boolean
  /** light 540p copy used by the preview; export always reads `path` */
  proxyPath?: string
  /** this asset is a reversed render of a source range of another asset */
  reverseOf?: { assetId: string; start: number; duration: number }
}

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export interface Keyframe {
  /** time relative to clip start on the timeline */
  time: number
  value: number
  easing: Easing
}

/** A scalar property that is either static or keyframed. */
export interface Anim {
  value: number
  keyframes?: Keyframe[]
  /** Catmull-Rom spline through the keyframes instead of per-segment easing */
  smooth?: boolean
}

export interface ClipTransform {
  x: Anim // offset from center, in project px
  y: Anim
  scale: Anim // 1 = fit project frame
  rotation: Anim // degrees (Z axis)
  opacity: Anim // 0..1
  /** 3D mode (perspective): tilt around the X/Y axes and depth offset */
  rotX?: Anim
  rotY?: Anim
  z?: Anim
}

/** Whole-track motion (Vegas-style Track Motion), times are project seconds. */
export interface Transform3D {
  x: Anim
  y: Anim
  scale: Anim
  rotation: Anim
  rotX: Anim
  rotY: Anim
  z: Anim
}

/** Rectangular mask: how much of each side is cut away, 0..1 of the layer. */
export interface ClipMask {
  left: Anim
  top: Anim
  right: Anim
  bottom: Anim
}

export type MaskShapeType = 'rect' | 'ellipse' | 'triangle'

/** Drawn shape mask in layer UV space (0..1), with soft borders. */
export interface MaskShape {
  type: MaskShapeType
  cx: Anim
  cy: Anim
  w: Anim
  h: Anim
  /** soft border inward / outward, in layer-height fractions */
  featherIn: Anim
  featherOut: Anim
  /** exclude mode: the shape cuts a hole instead of keeping its inside */
  invert: boolean
}

export interface Transition {
  /** gl-transitions style id; MVP supports 'crossfade' */
  type: string
  duration: number
  params?: Record<string, number>
}

export interface Effect {
  id: string
  type: string
  enabled: boolean
  params: Record<string, number | string>
}

export interface TextStyle {
  fontFamily: string
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  align: 'left' | 'center' | 'right'
  outlineColor: string
  outlineWidth: number
  background: string // '' = none
}

export interface Clip {
  id: string
  /** source asset; text clips have no asset */
  assetId?: string
  /** 'text' = text overlay; 'remotion' = live fragment composition */
  kind: 'media' | 'text' | 'remotion'
  /** remotion clips: composition id inside the shared fragments workspace */
  fragmentId?: string
  /** remotion clips: composition geometry/timing snapshot (preview + export) */
  fragmentMeta?: FragmentSpec
  text?: string
  textStyle?: TextStyle
  /** position on the timeline */
  start: number
  duration: number
  /** offset into the source media */
  inPoint: number
  /** playback rate, 1 = normal; duration beyond source/speed loops the media */
  speed: number
  /** fade in/out lengths in timeline seconds (video opacity + audio gain) */
  fadeIn?: number
  fadeOut?: number
  gain: Anim // audio gain 0..2
  muted: boolean
  transform: ClipTransform
  mask?: ClipMask
  /** legacy single shape — superseded by maskShapes */
  maskShape?: MaskShape
  /** several drawn shapes combine: union of normal shapes minus inverted ones */
  maskShapes?: MaskShape[]
  effects: Effect[]
  /** clips created together (video + its audio) share a linkId and move as one */
  linkId?: string
  transitionIn?: Transition
  transitionOut?: Transition
  label?: string
  /**
   * remotion clips: the sound under the clip was baked into the fragment
   * (audio.json next to its entry) by «Реакция на звук». `hash` fingerprints
   * what was baked — the clip's placement and every audio segment under it —
   * so the Inspector can say «устарело» and an export can re-bake it.
   */
  audioBake?: AudioBake
}

export interface AudioBake {
  hash: string
  /** 'mix' = everything audible, otherwise the id of the one track listened to */
  source: string
  /** epoch ms */
  at: number
}

export type TrackKind = 'video' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  muted: boolean
  locked: boolean
  /** audio: volume 0..2; video: whole-track opacity 0..1 */
  gain: number
  /** video tracks: animated whole-track transform */
  motion?: Transform3D
  clips: Clip[]
}

export interface TimelineMarker {
  id: string
  /** project seconds; markers float above all tracks */
  time: number
  /** short label shown in the flag — auto-numbered 1, 2, 3…; empty for beats */
  label: string
  /**
   * absent = the user's own marker (green flag); 'beat' = a detected musical
   * beat (thin line, no flag). Both are snap targets.
   */
  kind?: 'beat'
  /** beats: strength 0..1 (brag's cue intensity) */
  strength?: number
  /** beats: an accent — among the strongest beats of the piece */
  strong?: boolean
}

export interface Project {
  version: 1
  id: string
  name: string
  width: number
  height: number
  fps: number
  /** background color of the canvas */
  background: string
  tracks: Track[]
  assets: MediaAsset[]
  /** transcripts and other text documents imported into the sources */
  texts?: TextDoc[]
  /** free-floating timeline markers (M key / addMarker), track-independent */
  markers?: TimelineMarker[]
  /** synthesised voice-overs: script, settings and detector state per asset */
  voiceRuns?: VoiceRun[]
  /** defect regions found in a voice-over, or placed there by the user */
  defects?: AudioDefect[]
}

// ---------------------------------------------------------------------------
// Pose presets: a named snapshot of one keyframe's worth of mask/transform
// values, stored app-wide (userData JSON), shared across projects.

export interface PoseShape {
  type: MaskShapeType
  invert: boolean
  cx: number
  cy: number
  w: number
  h: number
  featherIn: number
  featherOut: number
}

export interface PosePreset {
  id: string
  name: string
  kind: 'transform' | 'mask'
  /** transform pose: param key (x/y/scale/rotation/opacity/rotX/rotY/z) → value */
  values?: Record<string, number>
  /** mask pose: edge cuts and drawn shapes */
  edges?: { left: number; top: number; right: number; bottom: number }
  shapes?: PoseShape[]
}

/** Named snapshot of a clip's effect stack, shared across projects. */
export interface FxPreset {
  id: string
  name: string
  effects: Effect[]
}

// ---------------------------------------------------------------------------
// Remotion fragments

export interface FragmentSpec {
  /** human-readable name; the unique composition id derives from it */
  name: string
  width: number
  height: number
  fps: number
  durationInFrames: number
  /** transparent overlay (final render keeps alpha) vs opaque scene */
  transparent?: boolean
}

export interface FragmentInfo {
  id: string
  dir: string
  entry: string // the TSX file Claude edits
  meta: FragmentSpec
}

// ---------------------------------------------------------------------------
// Transcripts / subtitle documents

/**
 * A text document (subtitles or plain text) registered in the project's
 * sources. The content lives in the file at `path`; the project stores only
 * the reference and how its timecodes map onto the timeline.
 */
export interface TextDoc {
  id: string
  name: string
  path: string
  format: 'srt' | 'txt'
  /** whole-file transcription: cue times are source-media times of this asset */
  assetId?: string
  /** range transcription: project-time second that cue time 0 refers to
      (0 = absolute project timecodes; undefined for asset-bound docs) */
  offset?: number
  /** detected language, informational */
  language?: string
}

/** One subtitle cue (seconds). */
export interface SubCue {
  start: number
  end: number
  text: string
}

export interface TranscribeWord {
  start: number
  end: number
  word: string
  probability: number
}

export interface TranscribeSegment {
  start: number
  end: number
  text: string
  words?: TranscribeWord[]
}

export interface TranscribeResult {
  segments: TranscribeSegment[]
  language: string
  duration: number
}

export interface TranscribeRequest {
  /** mixed-down audio input: segments in timeline coordinates (start at 0) */
  audioSegments: AudioSegment[]
  duration: number
  model: string // 'large-v3' | 'medium' | ...
  language: string // 'auto' | 'ru' | 'en' | ...
}

/** Loudness envelope of a mixed range (neon-wave module): one value per frame. */
export interface EnvelopeRequest {
  /** segments in range coordinates (start at 0), as for transcription */
  audioSegments: AudioSegment[]
  duration: number
  fps: number
  /** follower attack/release in seconds; defaults = Blender's sound bake (0.005 / 0.2) */
  attack?: number
  release?: number
}

/** Music analysis of a mixed range (shared/audioAnalysis.ts). */
export interface AnalyzeRequest {
  /** segments in range coordinates (start at 0), as for transcription */
  audioSegments: AudioSegment[]
  duration: number
}

export interface AnalyzedBeat {
  /** seconds from the start of the range */
  time: number
  /** 0..1 */
  intensity: number
  strong: boolean
}

export interface AudioAnalysisResult {
  duration: number
  /** curve samples per second */
  frameRate: number
  /** BPM, 0 = nothing rhythmic found */
  tempo: number
  beats: AnalyzedBeat[]
  /** strongest phase for every-2nd / every-4th grids (heuristic downbeat) */
  accentPhase: { 2: number; 4: number }
  /** 0..1 energies at frameRate, t = 0 at index 0 */
  curves: { rms: number[]; bass: number[]; mid: number[]; treble: number[] }
  /**
   * Set when librosa's grid sat systematically off the audible attacks and was
   * moved onto them (shared/audioAnalysis.ts alignBeatsToAttacks): the median
   * offset in ms (negative = the grid was late) and how many beats went exactly
   * onto their own attack.
   */
  attack?: { band: 'low' | 'full'; shiftMs: number; snapped: number; total: number }
}

/** One sound of the library: bundled (resources/sfx) or the user's own (userData/sfx). */
export interface SfxEntry {
  /**
   * stable id: the path relative to its sfx folder, e.g.
   * "impact/impactSoft_medium_001.ogg"; the user's own sounds are prefixed
   * "user:" ("user:mine/boom.mp3") so they can never collide with a bundled one
   */
  id: string
  /** absolute path */
  path: string
  /** folder: impact | casino | interface | ui | keyboard, or a user folder (mine…) */
  family: string
  origin: 'bundled' | 'user'
  duration: number
  /**
   * seconds from the file start to the attack of its main hit — placing a
   * sound "at t" puts this moment at t (a whoosh peaks ~0.5 s in, a boom with a
   * lead-in 1.5 s in)
   */
  hit: number
  brightness?: 'warm' | 'balanced' | 'bright'
  /** how sharp/fatiguing it gets when repeated */
  hfRisk?: 'low' | 'medium' | 'high'
  envelope?: 'transient' | 'textured' | 'continuous'
  /** 'brag' = /brag's own labels; 'kadr' = computed by shared/sfxFeatures.ts */
  labelledBy: 'brag' | 'kadr'
  tags: string[]
  /** suggested uses, English keys ("major reveal", "button press", "typing"…) */
  uses: string[]
  /** a short human description, when someone wrote one */
  note?: string
}

export interface MusicEntry {
  id: string
  path: string
  name: string
  descRu: string
  descEn: string
  duration: number
  tempo: number
  author: string
  license: string
}

export interface SoundLibrary {
  root: string
  /** the user's own sound folder (userData/sfx): one subfolder per family */
  userRoot: string
  sfx: SfxEntry[]
  music: MusicEntry[]
  /** absolute path of resources/CREDITS.md */
  credits: string
}

// ---------------------------------------------------------------------------
// Text to speech (ElevenLabs)

/**
 * Synthesis parameters. There is deliberately NO api key field: the key lives
 * in the main process only (electron/tts.ts) and never reaches the renderer,
 * which is scriptable through kadr_eval.
 */
export interface TtsParams {
  voiceId: string
  modelId: string
  stability: number
  similarityBoost: number
  style?: number
  speakerBoost?: boolean
  /** ElevenLabs' own `speed` (0.7-1.2) - NOT the atempo pass below */
  speed?: number
  /** requested container/rate, e.g. 'mp3_44100_128' */
  outputFormat?: string
}

/** Everything the module remembers between sessions - the key excepted. */
export interface TtsSettings extends TtsParams {
  /** post-synthesis speed-up (the atempo=1.1 of the user's script); 1 = off */
  tempo: number
  tempoEnabled: boolean
  /** run the defect detector after synthesis */
  defectCheck: boolean
  /** regenerate a phrase as soon as the user confirms it is a defect */
  regenerateOnConfirm: boolean
  /** python >= 3.11 with torch/whisper for the detector; '' = built-in default */
  ttsqcPython: string
  /** outbound proxy override; '' = take HTTPS_PROXY from the environment */
  proxy: string
}

/**
 * A synthesised voice-over: which asset holds it, the exact script behind it,
 * and everything needed to regenerate one phrase of it identically later.
 */
export interface VoiceRun {
  id: string
  /** the audio asset; a splice rewrites this file and swaps the id */
  assetId: string
  /** the exact text that was sent to TTS, on disk */
  scriptPath: string
  /** sha1 of that file: ttsqc word indices are valid only while it matches */
  scriptHash: string
  /** detector run directory (<userData>/ttsqc-runs/...), once it has run */
  runDir?: string
  duration: number
  /** ttsqc AnalysisResult.trust / .stats, kept verbatim */
  trust?: number
  stats?: Record<string, unknown>
  tts?: TtsParams
  /** per-chunk ElevenLabs request ids, for previous_request_ids stitching */
  chunkRequestIds?: string[]
  /**
   * Speed-up applied to THIS file (1 = none). A regenerated phrase must be
   * sped up by the same factor or the tempo jumps mid-sentence, so it is read
   * from here and never from the current settings.
   */
  tempo: number
  createdAt: number
}

/** How a phrase boundary was found; decides the crossfade and how much to trust it. */
export type CutKind = 'silence' | 'gap' | 'fallback' | 'fileStart' | 'fileEnd'

/**
 * The stretch of audio a defect would be regenerated as: whole sentences, cut
 * in the middle of the silence around them.
 *
 * NOT ttsqc's `play` span — that one is padded, capped at 12 s and sometimes
 * replaced outright by "defect ±1 s"; it is a listening window, and cutting on
 * it would splice mid-word.
 */
export interface DefectPhrase {
  /** cut points, SOURCE seconds of the voice-over asset, millisecond precision */
  t0: number
  t1: number
  /** ttsqc sentence numbers, inclusive */
  sentFrom: number
  sentTo: number
  /** script word indices, [from, to) */
  wordFrom: number
  wordTo: number
  /** character range into the script FILE — the exact text to re-synthesise */
  charFrom: number
  charTo: number
  text: string
  cut: [CutKind, CutKind]
}

/** proposed → the user judges → confirmed/rejected → regenerated (done/failed).
    There is deliberately no persisted 'regenerating': after a crash it would be
    a lie. Work in flight lives in useVoiceUi.busy instead. */
export type DefectState = 'proposed' | 'confirmed' | 'rejected' | 'done' | 'failed'

/**
 * One suspected defect in a voice-over.
 *
 * Times are SOURCE seconds of `assetId`, not timeline seconds: clips get moved,
 * trimmed, split and rippled, and a timeline number would be wrong after the
 * first of those. Binding to the asset also means a regeneration — which
 * rewrites the file — is obliged to fix every clip that uses it.
 */
export interface AudioDefect {
  /** Kadr's own id; the only key the UI, undo and IPC use */
  id: string
  runId: string
  assetId: string
  origin: 'detector' | 'user'
  /** ttsqc's Defect.id ('d007') — UNIQUE ONLY WITHIN its run, never a key */
  detectorId?: string
  cls?: string
  tier?: string
  confidence?: number
  /** ttsqc's real primary key: [lo, hi) script word indices, hi===lo = insertion.
      Survives regeneration, unlike every timecode. */
  words?: [number, number]
  evidence?: Record<string, unknown>
  text?: string
  contextBefore?: string
  contextAfter?: string
  /** ttsqc's `play` span verbatim — verdicts.json must carry exactly this or
      the training matcher loses its `play` branch */
  play?: [number, number]
  /** the defect itself, source seconds */
  src: [number, number]
  phrase: DefectPhrase
  state: DefectState
  note?: string
  attempts?: number
  /** asset produced by the splice that fixed it */
  resultAssetId?: string
  judgedAt?: number
}

/** One ttsqc finding as it comes out of the driver: the detector's own JSON
    (snake_case, `class` not `cls` — its to_json() renames it) plus our phrase. */
export interface RawDefect {
  id: string
  class: string
  tier: string
  confidence: number
  words: [number, number]
  audio: [number, number]
  play: [number, number]
  text: string
  context_before: string
  context_after: string
  evidence: Record<string, unknown>
  phrase: DefectPhrase
}

/** Re-synthesis of ONE phrase, for splicing back into a voice-over. */
export interface PhraseSynthRequest {
  text: string
  outPath: string
  params: TtsParams
  /** the speed-up of the FILE being patched — never the current setting, or the
      tempo jumps mid-sentence */
  tempo: number
  /** script around the phrase: conditions the intonation without being spoken */
  previousText?: string
  nextText?: string
  /** stronger continuity when the original was synthesised in chunks */
  previousRequestIds?: string[]
  /** a fresh take needs a fresh seed on every attempt */
  seed?: number
  /**
   * How much silence the patch must carry at each edge, seconds.
   *
   * Measured from the ORIGINAL around its cut points, not chosen: the pause at
   * a sentence boundary was 76 ms on a real voice-over, and a patch that ended
   * right after its last word swallowed most of it. Too much silence is
   * trimmed, too little is padded.
   */
  keepLead?: number
  keepTail?: number
  /** proxy for the API call; '' = take HTTPS_PROXY from the environment */
  proxy?: string
}

export interface PhraseSynthResult {
  path: string
  duration: number
  requestId: string
  /** what the guard noticed but did not consider fatal */
  warnings: string[]
}

/** One replaced stretch inside a splice. */
export interface SpliceUnit {
  /** cut points in the ORIGINAL file, source seconds */
  cut0: number
  cut1: number
  /** the new audio to put between them */
  patchPath: string
  /** level correction for the patch, dB */
  gainDb: number
  /** crossfade length at both seams, seconds */
  fade: number
}

export interface SpliceRequest {
  src: string
  out: string
  units: SpliceUnit[]
}

export interface SpliceResult {
  path: string
  /** MEASURED, never computed: resampling and mp3 padding shift it by ms */
  duration: number
  /**
   * Seam quality. `step` is the biggest sample-to-sample jump AT the joint and
   * `stepAround` the biggest in the second around it — a click is when the
   * joint is the worse of the two. `jumpDb` is the level change, informational
   * only: a seam at a sentence boundary swings 20 dB even when untouched.
   */
  seams: Array<{ at: number; jumpDb: number; step: number; stepAround: number
                 peakAround: number; clean: boolean }>
}

/** One row of the training corpus, in ttsqc's own verdict format.
    `t0/t1` MUST be the detector's `play` span verbatim: train._same matches on
    `play` or `audio`, and substituting our cut points would break that branch. */
export interface VerdictRow {
  id: string
  t0: number
  t1: number
  a0: number
  a1: number
  verdict: 'yes' | 'no' | null
}

/** A defect the user pointed at themselves. Kept in a SEPARATE file: ttsqc
    drops rows that match no flag, and once they outnumber the matching ones it
    discards the ENTIRE file, genuine labels included (`bestn < len(rows) * 0.5`,
    train.py:134). A session with many own marks and few rejections hits that
    easily — measured: 20 of 40 still passes, 21 voids everything. */
export interface UserMarkRow {
  id: string
  a0: number
  a1: number
  words?: [number, number]
}

export interface VoiceVerdictsRequest {
  runDir: string
  verdicts: VerdictRow[]
  marks: UserMarkRow[]
  /** длительность файла, в координатах которого пришли a0/a1: по ней main
      узнаёт, какую версию разбора они описывают, и переводит их обратно */
  audioDuration?: number
}

/**
 * Промежуточные версии озвучки на диске.
 *
 * Каждая перегенерация пишет НОВЫЙ файл (`base.fix1.flac`, `base.fix1.fix1.flac`
 * …) и намеренно не трогает предыдущий: дубль может не понравиться, и вернуться
 * должно быть куда. Но убирать их не умел никто — у пользователя накопилось
 * 4.3 ГБ за один рабочий день.
 *
 * Правило считает MAIN, а не рендерер: тот присылает только `keep` — пути всех
 * ассетов проекта. Под удаление попадает лишь файл вида `<base>(.fixN)+.(wav|
 * flac)` в той же папке, что и какой-нибудь из них, и только если сам он в
 * `keep` не входит. Оригинал `<base>.<ext>` под шаблон не подходит вовсе,
 * поэтому остаётся всегда.
 */
export interface VoiceVersionsRequest {
  /** пути ВСЕХ ассетов проекта — что угодно из них удалено не будет */
  keep: string[]
  /** false (по умолчанию) — только посчитать; true — удалить */
  apply?: boolean
}

export interface VoiceVersionsResult {
  files: Array<{ path: string; name: string; size: number; mtime: number }>
  bytes: number
  /** сколько файлов действительно удалено (только при apply) */
  removed?: number
}

/**
 * Пересчитать разбор под НОВУЮ версию файла после склейки.
 *
 * Разбор описывает звук таким, каким он был в момент проверки. Склейка
 * переписывает файл, и всё правее шва уезжает — а ручная отметка ищет фразу
 * именно по разбору. Без этого пересчёта отметка, поставленная после первой же
 * перегенерации, подхватывает ЧУЖОЕ предложение, и следующая склейка вырезает
 * не тот кусок.
 */
export interface VoiceReindexRequest {
  runDir: string
  /** файл, который теперь лежит на таймлайне */
  audio: string
  /** его ИЗМЕРЕННАЯ длительность */
  duration: number
  units: Array<{ cut0: number; cut1: number; patchDur: number }>
}

export interface VoiceLearnResult {
  ok: boolean
  examples: number
  positives: number
  /** distinct audio files — cross-validation needs at least two */
  files: number
  /** user marks that a generated candidate covers (usable for training) */
  userMatched: number
  /** user marks the generator never proposes — counted, not trainable */
  userUnmatched: number
  runs: number
  crossVal?: Record<string, number>
  /** когда и какого размера получился файл модели — доказательство, что она
      действительно пересобрана: число примеров от переобучения не меняется */
  savedAt?: number
  savedSize?: number
  problem?: string
  saved?: string
  backup?: string
}

export interface VoiceCheckRequest {
  /** the voice-over file to analyse — the asset itself, never a mixdown:
      a mixdown would leave nothing to splice into */
  audioPath: string
  /** the exact script that was synthesised */
  scriptPath: string
  device?: string
  maxFlags?: number
  minConfidence?: number
  /** how many words from a sentence edge still count as "at the boundary" */
  edgeWords?: number
  /** python >= 3.11 with torch/whisper; '' = the configured default */
  python?: string
}

export interface VoiceCheckResult {
  runDir: string
  /** content-hashed copy of the analysed audio, inside runDir */
  audio: string
  duration: number
  trust: number
  stats: Record<string, unknown>
  defects: RawDefect[]
  /** [sentence number, t0, t1] for every sentence that got aligned */
  sentences: Array<[number, number, number]>
}

export interface VoicePhraseRequest {
  runDir: string
  start: number
  end: number
  edgeWords?: number
  python?: string
  /** длительность файла, к которому относятся start/end. Драйвер сверяет её с
      разбором и отказывается считать фразу по чужой версии звука. */
  audioDuration?: number
}

export interface VoiceSelfTest {
  ok: boolean
  python: string
  problems: string[]
  cuda?: { available: boolean; name?: string; freeMb?: number; totalMb?: number }
  modules?: Record<string, string | null>
  files?: Record<string, boolean>
  /** HOME/MODELS/SCORER/CACHE… — в частности путь к модели, которую
      перезаписывает «Переобучить» */
  paths?: Record<string, string>
  /** когда эта модель последний раз записана: по числу примеров переобучение
      не видно (корпус не меняется), а по времени файла — видно */
  scorerMtime?: number
}

export interface TtsVoice {
  id: string
  name: string
  category?: string
  previewUrl?: string
  labels?: Record<string, string>
}

export interface TtsRequest {
  text: string
  /** absolute path of the wav to write */
  outPath: string
  params: TtsParams
  /** atempo factor applied in the same pass as the decode; 1 = untouched */
  tempo?: number
  /** proxy for the API call; '' = take HTTPS_PROXY from the environment */
  proxy?: string
}

export interface TtsResult {
  path: string
  duration: number
  /** the exact text that was sent, written next to the audio */
  scriptPath: string
  /** sha1 of that file - word indices are valid only while it matches */
  scriptHash: string
  chunks: number
  /** per-chunk ElevenLabs request ids, for previous_request_ids stitching */
  requestIds: string[]
  tempo: number
}

// ---------------------------------------------------------------------------
// Export

export interface ExportPreset {
  id: string
  name: string
  container: 'mp4' | 'webm' | 'mkv' | 'mp3'
  /** WebCodecs codec string for the renderer-side encoder */
  codec: string
  /** ffmpeg vcodec for the final pass; 'copy' keeps the WebCodecs stream */
  ffmpegVideo: string
  width: number | 'project'
  height: number | 'project'
  fps: number | 'project'
  videoBitrate: number // bits/s
  audioCodec: string
  audioBitrate: string // ffmpeg style, e.g. '192k'
  audioOnly?: boolean
}

export interface ExportJob {
  projectName: string
  preset: ExportPreset
  outputPath: string
  width: number
  height: number
  fps: number
  duration: number
  /** flattened audio segments for the ffmpeg mix */
  audioSegments: AudioSegment[]
  /**
   * master stage (peak limiter, shared/audioMaster.ts); undefined = on.
   * false for analysis mixdowns, which must see the mix unaltered.
   */
  master?: boolean
}

export interface AudioSegment {
  path: string
  /** seconds into the source */
  inPoint: number
  /** source-domain duration (input -t); on the timeline it lasts duration/speed */
  duration: number
  /** position in the timeline */
  start: number
  gain: number
  speed: number
  /** local fade windows in timeline seconds */
  fadeIn: number
  fadeOut: number
}

export interface ExportProgress {
  phase: 'fragments' | 'video' | 'audio' | 'mux' | 'done' | 'error' | 'cancelled'
  /** 0..1 within the current phase */
  progress: number
  message?: string
}

// ---------------------------------------------------------------------------
// IPC surface exposed by the preload script

export interface ProbeResult {
  asset: Omit<MediaAsset, 'id'>
}

/* ------------------------------ disk storage ------------------------------ */

export type StorageGroupId =
  | 'proxies' | 'decoded' | 'fragments' | 'ttsqcCache'
  | 'reversed' | 'imported' | 'voiceRuns'

/** A project, reduced to what identifies the files it owns on disk. */
export interface StorageProject {
  name: string
  path: string | null
  assets: string[]
  fragmentIds: string[]
  runDirs: string[]
}

export interface StorageGroup {
  id: StorageGroupId
  dir: string
  /** true = deleting costs time only; the artefact is derived and comes back */
  rebuildable: boolean
  /** false = the group cannot be tied to projects at all (a shared cache) */
  attributed: boolean
  files: number
  bytes: number
  /** files no known project claims — the safe thing to delete */
  stale: { files: number; bytes: number }
  /** id = the project's path ('#open' when unsaved); name is only a label,
   *  and several projects are routinely called the same thing */
  byProject: { id: string; name: string; files: number; bytes: number }[]
}

export interface StorageScan {
  groups: StorageGroup[]
  projects: { id: string; name: string; path: string | null; assets: number }[]
  totalBytes: number
  freeBytes: number
}

export interface StoragePruneRequest {
  group: StorageGroupId
  /** 'stale' = what nobody claims · 'project' = one project's derived files */
  scope: 'stale' | 'project' | 'all'
  /** the project's id (its path), never its name */
  project?: string
  projects?: string[]
  open?: StorageProject | null
  /**
   * Deleting requires saying so. The default is to do NOTHING, because the
   * opposite default already cost 2.5 GB: a caller asked for a dry run against
   * a main process built before `dryRun` existed, the unknown field was
   * ignored, and the request read as "delete everything unclaimed". Anything
   * this handler does not understand must fail towards keeping the files.
   */
  confirm?: boolean
  /** count what would go, delete nothing */
  dryRun?: boolean
  /** restrict to these file names inside the group — the selection rules still
   *  apply, so this can never reach a file the scope would have spared */
  only?: string[]
}

export interface StoragePruneResult {
  removed: number
  bytes: number
  error?: string
}

export interface KadrApi {
  openMediaDialog(): Promise<string[]>
  probeMedia(path: string): Promise<ProbeResult>
  fileUrl(path: string): string
  /** Absolute path of a File dropped from the OS (File.path is gone since
      Electron 32 — this goes through webUtils.getPathForFile). */
  pathForFile(f: File): string
  /** Download an http(s) media URL (browser drag) into userData/imported;
      cached by URL. Returns the local file path. */
  downloadMedia(url: string): Promise<string>
  /** Save raw media content (path-less File / data: URL from a browser drag)
      into userData/imported; cached by content hash. Returns the path. */
  saveBlobMedia(name: string, mime: string, data: Uint8Array): Promise<string>
  /** Resolve an XDG FileTransfer portal drop (transfer key → local paths). */
  portalFiles(key: string): Promise<string[]>
  /** Media from the OS clipboard: copied files (uri-list) or a copied image
      (saved as PNG into userData/imported). Empty array = nothing usable. */
  clipboardMedia(): Promise<string[]>
  /** Append a drop-diagnostics entry to userData/drop-log.jsonl. */
  dropLog(entry: unknown): void

  saveProjectDialog(currentName: string): Promise<string | null>
  openProjectDialog(): Promise<string | null>
  readProject(path: string): Promise<Project>
  writeProject(path: string, project: Project): Promise<void>
  /** write <name>.autosave.kadr next to the project (atomic); returns path */
  autosaveProject(project: Project, mainPath: string | null): Promise<string>

  /** App-wide JSON stores in userData (presets etc.) — survive any restart. */
  storageScan(projects: string[], open: StorageProject | null): Promise<StorageScan>
  storagePrune(req: StoragePruneRequest): Promise<StoragePruneResult>
  readUserStore(name: string): Promise<unknown>
  writeUserStore(name: string, data: unknown): Promise<void>

  /** Render (or reuse) a reversed copy of a source range; resolves with the file path. */
  reverseMedia(
    path: string,
    start: number,
    duration: number,
    info: { kind: AssetKind; hasAudio: boolean; width: number; height: number; fps: number }
  ): Promise<string>
  onReverseProgress(
    cb: (p: { path: string; start: number; duration: number; progress: number }) => void
  ): () => void

  /** Build (or reuse) a preview proxy; resolves with the proxy file path.
      Alpha sources get a VP9+alpha WebM proxy instead of H.264. */
  requestProxy(path: string, duration: number,
    opts?: { alpha?: boolean; codec?: string }): Promise<string>
  onProxyProgress(cb: (p: { path: string; progress: number }) => void): () => void
  /** Full-resolution intermediate for sources Chromium cannot decode
      (e.g. HEVC without VAAPI, ProRes): H.264, or VP9+alpha WebM for alpha
      sources; cached like proxies, video-only. */
  requestDecoded(path: string, duration: number,
    opts?: { alpha?: boolean; codec?: string; packed?: boolean }): Promise<string>
  /** Native directory picker; null when the user cancels. */
  pickDirectory(title?: string): Promise<string | null>
  /** Write a frame snapshot PNG into dir (Downloads when null) under a
      collision-free name derived from baseName; resolves with the path. */
  saveSnapshot(dir: string | null, baseName: string, png: ArrayBuffer): Promise<string>
  /** EBU R128 loudness of a source range: integrated LUFS + true peak dBTP. */
  measureLoudness(path: string, start: number, duration: number): Promise<{ i: number; tp: number }>
  /** plain mean/peak dBFS — for short spans where R128 has not settled */
  meanVolume(path: string, start: number, duration: number): Promise<{ mean: number; max: number }>
  /** Blender-compatible loudness envelope of a mixed range, one value per frame (see shared/envelope.ts). */
  audioEnvelope(req: EnvelopeRequest): Promise<number[]>
  /** Tempo, beat grid and band energies of a mixed range (see shared/audioAnalysis.ts). */
  audioAnalyze(req: AnalyzeRequest): Promise<AudioAnalysisResult>
  /**
   * The bundled sound effects and music (resources/) plus the user's own
   * sounds (userData/sfx/<family>/). `rescan` re-reads the user folder and
   * analyses what is new or changed.
   */
  soundLibrary(rescan?: boolean): Promise<SoundLibrary>
  /** Describe one of the user's own sounds (id "user:…"): uses, tags, a note. */
  soundSetMeta(id: string, meta: { uses?: string[]; tags?: string[]; note?: string }): Promise<SfxEntry>
  /** Write one generated file (plain name, no folders) into a fragment's folder; returns its path. */
  fragmentWriteFile(id: string, name: string, content: string): Promise<string>

  exportDialog(defaultName: string, ext: string): Promise<string | null>
  exportBegin(job: ExportJob): Promise<void>
  exportVideoChunk(data: ArrayBuffer, position: number): Promise<void>
  /** Direct encode in the renderer process: preload spawns ffmpeg and pipes
      raw RGBA frames into it. contextIsolation is off, so the frame view is
      passed BY REFERENCE — zero copies until the kernel pipe. rawEncodeStart
      resolves with the temp file the encoder writes; exportUseVideo hands it
      to the muxer stage. */
  rawEncodeStart(o: {
    width: number; height: number; outWidth?: number; outHeight?: number
    fps: number; codec: string; bitrate: number
  }): Promise<string>
  /** resolves when ffmpeg's stdin accepted the memory — only then reuse it */
  rawEncodeFrame(view: Uint8Array): Promise<void>
  rawEncodeEnd(): Promise<void>
  rawEncodeKill(): void
  exportUseVideo(path: string): Promise<void>

  /** main-process fallback raw encode: frames over WS (port > 0) or IPC */
  exportRawBegin(
    width: number, height: number, fps: number,
    outWidth?: number, outHeight?: number
  ): Promise<number>
  exportRawFrame(data: ArrayBuffer): Promise<void>
  exportRawEnd(): Promise<void>
  exportVideoDone(): Promise<void>
  exportCancel(): Promise<void>
  onExportProgress(cb: (p: ExportProgress) => void): () => void

  /** Remotion fragments: shared workspace, dev server, create and render. */
  fragmentEnsure(): Promise<{ dir: string; installed: boolean }>
  fragmentServer(): Promise<{ url: string }>
  /** projectDir set → the fragment folder is created there (kadr-fragments/)
      and only a symlink lands in the workspace */
  fragmentCreate(spec: FragmentSpec, projectDir?: string | null): Promise<FragmentInfo>
  fragmentDelete(id: string): Promise<void>
  /** Move loose workspace fragments into the project folder / restore
      missing workspace symlinks; returns ids that changed. */
  fragmentRelocate(projectDir: string, ids: string[]): Promise<string[]>
  /** pixel capture for fragments that need GL features in the preview */
  fragmentCaptureStart(id: string, url: string, w: number, h: number, fps: number): Promise<void>
  fragmentCaptureStop(id: string): Promise<void>
  /** Player page's current frame (−1 not ready, −2 no capture window). */
  fragmentCaptureQuery(id: string): Promise<number>
  fragmentCaptureSync(id: string, msg: unknown): void
  onFragmentFrame(cb: (p: { id: string; w: number; h: number; data: Uint8Array }) => void): () => void
  fragmentRender(id: string, opts?: { transparent?: boolean }): Promise<{ path: string; cached: boolean }>
  /** stops the running fragment render (its whole process tree) */
  fragmentCancelRender(): Promise<void>
  onFragmentProgress(cb: (p: { id: string; phase: string; progress: number }) => void): () => void

  /** Mix the request's audio to a temp wav and run Whisper over it. */
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>
  transcribeCancel(): Promise<void>
  onTranscribeProgress(cb: (p: { progress: number; text: string }) => void): () => void

  /** Flush the user's verdicts into the training corpus of one run. */
  voiceVerdicts(req: VoiceVerdictsRequest):
    Promise<{ verdicts: number; marks: number; droppedMarks: number }>
  /** Move a finished analysis onto the file a splice has just produced. */
  voiceReindex(req: VoiceReindexRequest): Promise<{ duration: number; splices: number }>
  /** Intermediate voice-over versions on disk: count them, or delete them. */
  voiceVersions(req: VoiceVersionsRequest): Promise<VoiceVersionsResult>
  /** Retrain the confidence model on everything collected so far. */
  voiceLearn(req?: { dry?: boolean; python?: string }): Promise<VoiceLearnResult>

  /** Re-synthesise one phrase and splice it back into a voice-over. */
  ttsSpeakPhrase(req: PhraseSynthRequest): Promise<PhraseSynthResult>
  voiceSplice(req: SpliceRequest): Promise<SpliceResult>
  /** the silence run containing this second, for matching a patch's edges */
  voiceSilenceAt(path: string, at: number): Promise<{ from: number; to: number }>

  /** Local defect detector (python/ttsqc). Long, GPU-bound, one job at a time. */
  voiceSelfTest(python?: string): Promise<VoiceSelfTest>
  voiceCheck(req: VoiceCheckRequest): Promise<VoiceCheckResult>
  voiceCheckCancel(): Promise<void>
  onVoiceProgress(cb: (p: { progress: number; stage: string }) => void): () => void
  /** Phrase around a hand-placed marker — reuses a finished run, no models. */
  voicePhraseAt(req: VoicePhraseRequest): Promise<{ words: [number, number]; phrase: DefectPhrase }>

  /** ElevenLabs speech synthesis. The API key stays in the main process: the
      renderer may set it and ask whether one exists, never read it back. */
  ttsHasKey(): Promise<boolean>
  /** true when the main process synthesises locally (KADR_TTS_MOCK=1).
      Tests MUST gate on this, not on ttsHasKey — that one is true whenever a
      real key is stored and would let a suite spend the user's credits. */
  ttsIsMock(): Promise<boolean>
  ttsSetKey(key: string): Promise<void>
  ttsVoices(proxy?: string): Promise<TtsVoice[]>
  ttsSpeak(req: TtsRequest): Promise<TtsResult>
  ttsCancel(): Promise<void>
  onTtsProgress(cb: (p: { progress: number; stage: string; text?: string }) => void): () => void

  /** Plain text file IO for transcripts (absolute paths). */
  readTextFile(path: string): Promise<string | null>
  writeTextFile(path: string, content: string): Promise<void>
  /** mtime in ms, or null when missing — used to pick up external edits */
  statFile(path: string): Promise<number | null>

  /** Embedded Claude Code terminal session (PTY in main + MCP bridge). */
  claudeOpen(cols: number, rows: number, cwd: string | null):
    Promise<{ ok: boolean; port?: number; error?: string }>
  claudeInput(data: string): void
  claudeResize(cols: number, rows: number): void
  claudeClose(): Promise<void>
  onClaudeData(cb: (data: string) => void): () => void
  onClaudeExit(cb: (code: number) => void): () => void
}
