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
  /** light 540p copy used by the preview; export always reads `path` */
  proxyPath?: string
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

export interface KadrApi {
  openMediaDialog(): Promise<string[]>
  probeMedia(path: string): Promise<ProbeResult>
  fileUrl(path: string): string

  saveProjectDialog(currentName: string): Promise<string | null>
  openProjectDialog(): Promise<string | null>
  readProject(path: string): Promise<Project>
  writeProject(path: string, project: Project): Promise<void>
  /** write <name>.autosave.kadr next to the project (atomic); returns path */
  autosaveProject(project: Project, mainPath: string | null): Promise<string>

  /** App-wide JSON stores in userData (presets etc.) — survive any restart. */
  readUserStore(name: string): Promise<unknown>
  writeUserStore(name: string, data: unknown): Promise<void>

  /** Build (or reuse) a preview proxy; resolves with the proxy file path. */
  requestProxy(path: string, duration: number): Promise<string>
  onProxyProgress(cb: (p: { path: string; progress: number }) => void): () => void

  exportDialog(defaultName: string, ext: string): Promise<string | null>
  exportBegin(job: ExportJob): Promise<void>
  exportVideoChunk(data: ArrayBuffer, position: number): Promise<void>
  exportVideoDone(): Promise<void>
  exportCancel(): Promise<void>
  onExportProgress(cb: (p: ExportProgress) => void): () => void

  /** Remotion fragments: shared workspace, dev server, create and render. */
  fragmentEnsure(): Promise<{ dir: string; installed: boolean }>
  fragmentServer(): Promise<{ url: string }>
  fragmentCreate(spec: FragmentSpec): Promise<FragmentInfo>
  fragmentDelete(id: string): Promise<void>
  /** pixel capture for fragments that need GL features in the preview */
  fragmentCaptureStart(id: string, url: string, w: number, h: number, fps: number): Promise<void>
  fragmentCaptureStop(id: string): Promise<void>
  fragmentCaptureSync(id: string, msg: unknown): void
  onFragmentFrame(cb: (p: { id: string; w: number; h: number; data: Uint8Array }) => void): () => void
  fragmentRender(id: string, opts?: { transparent?: boolean }): Promise<{ path: string; cached: boolean }>
  onFragmentProgress(cb: (p: { id: string; phase: string; progress: number }) => void): () => void

  /** Mix the request's audio to a temp wav and run Whisper over it. */
  transcribe(req: TranscribeRequest): Promise<TranscribeResult>
  transcribeCancel(): Promise<void>
  onTranscribeProgress(cb: (p: { progress: number; text: string }) => void): () => void

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

  /** Native menu commands (File/Edit) forwarded from the main process. */
  onMenuCommand(cb: (cmd: string) => void): () => void
}
