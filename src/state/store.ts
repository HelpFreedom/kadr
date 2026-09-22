import { create } from 'zustand'
import type {
  Project, Track, Clip, Anim, MediaAsset, TrackKind, TextStyle, TextDoc, FragmentSpec,
  VoiceRun, AudioDefect, DefectState
} from '@shared/types'

export const uid = () => Math.random().toString(36).slice(2, 10)

export const defaultTextStyle = (): TextStyle => ({
  fontFamily: 'sans-serif',
  fontSize: 72,
  color: '#ffffff',
  bold: true,
  italic: false,
  align: 'center',
  outlineColor: '#000000',
  outlineWidth: 4,
  background: ''
})

export const newClipDefaults = (): Pick<
  Clip,
  'speed' | 'gain' | 'muted' | 'transform' | 'mask' | 'effects' | 'fadeIn' | 'fadeOut'
> => ({
  speed: 1,
  gain: { value: 1 },
  muted: false,
  fadeIn: 0,
  fadeOut: 0,
  transform: {
    x: { value: 0 },
    y: { value: 0 },
    scale: { value: 1 },
    rotation: { value: 0 },
    opacity: { value: 1 }
  },
  mask: {
    left: { value: 0 },
    top: { value: 0 },
    right: { value: 0 },
    bottom: { value: 0 }
  },
  effects: []
})

export function newProject(): Project {
  return {
    version: 1,
    id: uid(),
    name: 'Untitled',
    width: 1920,
    height: 1080,
    fps: 30,
    background: '#000000',
    tracks: [
      { id: uid(), kind: 'video', name: 'V2', muted: false, locked: false, gain: 1, clips: [] },
      { id: uid(), kind: 'video', name: 'V1', muted: false, locked: false, gain: 1, clips: [] },
      { id: uid(), kind: 'audio', name: 'A1', muted: false, locked: false, gain: 1, clips: [] }
    ],
    assets: []
  }
}

export function projectDuration(p: Project): number {
  let end = 0
  for (const t of p.tracks) for (const c of t.clips) end = Math.max(end, c.start + c.duration)
  return end
}

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip } | null {
  for (const track of p.tracks) {
    const clip = track.clips.find((c) => c.id === clipId)
    if (clip) return { track, clip }
  }
  return null
}

/**
 * Heal foreign or script-written projects on load. Anim slots written as
 * plain numbers (e.g. `gain: 0.5` from a kadr_eval script) become `{value}`,
 * non-finite values and broken keyframes are dropped — a single NaN reaching
 * WebAudio used to kill playback for the rest of the session.
 */
export function sanitizeProject(p: Project): Project {
  const anim = (a: unknown, fallback: number): Anim => {
    if (typeof a === 'number') return { value: Number.isFinite(a) ? a : fallback }
    if (!a || typeof a !== 'object') return { value: fallback }
    const o = a as Anim
    if (o.keyframes) {
      o.keyframes = o.keyframes.filter((k) => Number.isFinite(k?.time) && Number.isFinite(k?.value))
      if (!o.keyframes.length) delete o.keyframes
    }
    if (!Number.isFinite(o.value)) o.value = o.keyframes?.[0]?.value ?? fallback
    return o
  }
  if (typeof p.background !== 'string') p.background = '#000000'
  if (!Number.isFinite(p.width) || p.width <= 0) p.width = 1920
  if (!Number.isFinite(p.height) || p.height <= 0) p.height = 1080
  if (!Number.isFinite(p.fps) || p.fps <= 0) p.fps = 30
  p.assets ??= []
  p.claudeChats = (p.claudeChats ?? []).filter((id) => typeof id === 'string' && id.length > 0)
  p.markers = (p.markers ?? []).filter(
    (m) => m && typeof m.id === 'string' && Number.isFinite(m.time)
  )
  for (const m of p.markers) {
    if (typeof m.label !== 'string' || !m.label) m.label = '•'
    if (m.time < 0) m.time = 0
  }
  // a voice-over is meaningless without its asset and its script; tempo must be
  // a real factor or a regenerated phrase would be stretched by NaN
  p.voiceRuns = (p.voiceRuns ?? []).filter(
    (r) => r && typeof r.id === 'string' && typeof r.assetId === 'string' &&
      typeof r.scriptPath === 'string' && p.assets.some((a) => a.id === r.assetId)
  )
  for (const r of p.voiceRuns) {
    if (!Number.isFinite(r.tempo) || r.tempo <= 0) r.tempo = 1
    if (!Number.isFinite(r.duration) || r.duration < 0) r.duration = 0
    if (typeof r.scriptHash !== 'string') r.scriptHash = ''
  }
  // Дефекты держатся на ассете и на прогоне: без любого из них они бессмысленны.
  // Инвариант «дефект лежит внутри своей фразы» чинится, а не обсуждается — на
  // нём стоит вся перегенерация.
  const runIds = new Set(p.voiceRuns.map((r) => r.id))
  const assetIds = new Set(p.assets.map((a) => a.id))
  const DEFECT_STATES = ['proposed', 'confirmed', 'rejected', 'done', 'failed']
  p.defects = (p.defects ?? []).filter(
    (d) => d && typeof d.id === 'string' && assetIds.has(d.assetId) && runIds.has(d.runId) &&
      Array.isArray(d.src) && d.src.length === 2 &&
      Number.isFinite(d.src[0]) && Number.isFinite(d.src[1]) && d.src[1] > d.src[0]
  )
  for (const d of p.defects) {
    if (!DEFECT_STATES.includes(d.state)) d.state = 'proposed'
    if (d.origin !== 'user') d.origin = 'detector'
    if (d.src[0] < 0) d.src[0] = 0
    if (!Number.isFinite(d.confidence as number)) delete d.confidence
    if (d.words && !(Number.isInteger(d.words[0]) && Number.isInteger(d.words[1]) &&
        d.words[1] >= d.words[0])) delete d.words
    const ph = d.phrase
    if (!ph || !Number.isFinite(ph.t0) || !Number.isFinite(ph.t1) || ph.t1 <= ph.t0) {
      // фраза потеряна: вырождаем её в сам дефект и честно помечаем, что резать
      // по ней нельзя, пока разбор не пересчитан
      d.phrase = {
        t0: d.src[0], t1: d.src[1], sentFrom: -1, sentTo: -1,
        wordFrom: -1, wordTo: -1, charFrom: -1, charTo: -1, text: '',
        cut: ['fallback', 'fallback']
      }
      d.note = 'границы фразы потеряны — пересчитайте разбор'
    } else {
      if (!Array.isArray(ph.cut) || ph.cut.length !== 2) ph.cut = ['fallback', 'fallback']
      if (ph.t0 > d.src[0]) ph.t0 = d.src[0]
      if (ph.t1 < d.src[1]) ph.t1 = d.src[1]
    }
  }
  for (const track of p.tracks) {
    if (!Number.isFinite(track.gain)) track.gain = 1
    for (const c of track.clips) {
      for (const k of ['start', 'duration', 'inPoint'] as const)
        if (!Number.isFinite(c[k])) c[k] = 0
      if (!Number.isFinite(c.speed) || c.speed <= 0) c.speed = 1
      c.transform = { ...newClipDefaults().transform, ...(c.transform ?? {}) }
      c.gain = anim(c.gain, 1)
      c.effects ??= []
      forEachAnim(c, (a) => anim(a, Number.isFinite((a as Anim)?.value) ? (a as Anim).value : 0))
    }
  }
  return p
}

/** All animatable scalars of a clip (transform, gain, mask, shape). */
export function forEachAnim(c: Clip, fn: (a: Anim) => Anim) {
  const tr = c.transform
  c.transform = {
    x: fn(tr.x), y: fn(tr.y), scale: fn(tr.scale),
    rotation: fn(tr.rotation), opacity: fn(tr.opacity),
    rotX: tr.rotX ? fn(tr.rotX) : undefined,
    rotY: tr.rotY ? fn(tr.rotY) : undefined,
    z: tr.z ? fn(tr.z) : undefined
  }
  c.gain = fn(c.gain)
  if (c.mask) {
    c.mask = {
      left: fn(c.mask.left), top: fn(c.mask.top),
      right: fn(c.mask.right), bottom: fn(c.mask.bottom)
    }
  }
  if (c.maskShape) {
    c.maskShape = {
      ...c.maskShape,
      cx: fn(c.maskShape.cx), cy: fn(c.maskShape.cy),
      w: fn(c.maskShape.w), h: fn(c.maskShape.h),
      featherIn: fn(c.maskShape.featherIn), featherOut: fn(c.maskShape.featherOut)
    }
  }
  if (c.maskShapes) {
    c.maskShapes = c.maskShapes.map((s) => ({
      ...s,
      cx: fn(s.cx), cy: fn(s.cy),
      w: fn(s.w), h: fn(s.h),
      featherIn: fn(s.featherIn), featherOut: fn(s.featherOut)
    }))
  }
}

/** Shift keyframe times (content moved: trim-in, split) — keeps anims glued to frames. */
export function shiftClipAnims(c: Clip, delta: number) {
  forEachAnim(c, (a) =>
    a.keyframes?.length
      ? { ...a, keyframes: a.keyframes.map((k) => ({ ...k, time: k.time + delta })) }
      : a
  )
  if (Math.abs(delta) > 1e-9) {
    // fades hug the clip edges; trimming from the left consumes the fade-in
    if (c.fadeIn) c.fadeIn = Math.max(0, c.fadeIn + delta)
  }
}

/** Rescale keyframe times and fades when playback speed changes. */
export function rescaleClipAnims(c: Clip, factor: number) {
  forEachAnim(c, (a) =>
    a.keyframes?.length
      ? { ...a, keyframes: a.keyframes.map((k) => ({ ...k, time: k.time * factor })) }
      : a
  )
  if (c.fadeIn) c.fadeIn *= factor
  if (c.fadeOut) c.fadeOut *= factor
}

/** Expand clip ids with their linked partners (video + its audio). */
export function withLinked(p: Project, ids: string[]): string[] {
  const out = new Set(ids)
  const links = new Set<string>()
  for (const t of p.tracks) {
    for (const c of t.clips) if (out.has(c.id) && c.linkId) links.add(c.linkId)
  }
  for (const t of p.tracks) {
    for (const c of t.clips) if (c.linkId && links.has(c.linkId)) out.add(c.id)
  }
  return [...out]
}

/** Edges of all clips plus the playhead — snap targets for dragging. */
export function snapPoints(p: Project, exclude: string | string[], playhead: number): number[] {
  const ex = Array.isArray(exclude) ? exclude : [exclude]
  const pts = [0, playhead]
  for (const t of p.tracks) {
    for (const c of t.clips) {
      if (ex.includes(c.id)) continue
      pts.push(c.start, c.start + c.duration)
    }
  }
  return pts
}

interface SettingsState {
  lang: 'ru' | 'en'
  /** uniform lane height for all tracks, px */
  trackH: number
  setLang(l: 'ru' | 'en'): void
  setTrackH(h: number): void
}

export const useSettings = create<SettingsState>((set) => ({
  lang: (localStorage.getItem('kadr.lang') as 'ru' | 'en') || 'ru',
  trackH: Math.min(140, Math.max(32, Number(localStorage.getItem('kadr.trackh')) || 56)),
  setLang: (lang) => {
    localStorage.setItem('kadr.lang', lang)
    set({ lang })
  },
  setTrackH: (h) => {
    const trackH = Math.min(140, Math.max(32, h))
    localStorage.setItem('kadr.trackh', String(trackH))
    set({ trackH })
  }
}))

// ---------------------------------------------------------------------------
// Pose presets: a named snapshot of one keyframe's worth of mask/transform
// values. Saved across projects and sessions; applying one writes the values
// through the regular keyframe path (a keyframe lands at the playhead when
// the parameter is animated or link-to-timeline is on).
//
// Source of truth is a JSON file in userData (over IPC) — localStorage is
// only a warm cache: the renderer profile can be locked by a second app
// instance and silently lose writes.

export type { PosePreset, PoseShape } from '@shared/types'
import type { PosePreset } from '@shared/types'

interface PosePresetState {
  presets: PosePreset[]
  savePreset(p: Omit<PosePreset, 'id'>): void
  deletePreset(id: string): void
}

const POSE_LS_KEY = 'kadr.posePresets'
const POSE_FILE = 'pose-presets'

function loadPoseCache(): PosePreset[] {
  try {
    const raw = localStorage.getItem(POSE_LS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function persistPosePresets(presets: PosePreset[]) {
  window.kadr.writeUserStore(POSE_FILE, presets).catch(() => { /* disk hiccup */ })
  try {
    localStorage.setItem(POSE_LS_KEY, JSON.stringify(presets))
  } catch { /* cache only */ }
}

export const usePosePresets = create<PosePresetState>((set) => ({
  presets: loadPoseCache(),
  savePreset: (p) =>
    set((s) => {
      const presets = [...s.presets, { ...p, id: uid() }]
      persistPosePresets(presets)
      return { presets }
    }),
  deletePreset: (id) =>
    set((s) => {
      const presets = s.presets.filter((x) => x.id !== id)
      persistPosePresets(presets)
      return { presets }
    })
}))

// adopt the file store on startup; migrate presets saved before it existed
;(async () => {
  try {
    const fromFile = await window.kadr.readUserStore(POSE_FILE)
    if (Array.isArray(fromFile) && fromFile.length) {
      usePosePresets.setState({ presets: fromFile as PosePreset[] })
      try {
        localStorage.setItem(POSE_LS_KEY, JSON.stringify(fromFile))
      } catch { /* cache only */ }
    } else {
      const cached = loadPoseCache()
      if (cached.length) window.kadr.writeUserStore(POSE_FILE, cached).catch(() => { /* keep cache */ })
    }
  } catch { /* file store unavailable — cache keeps working */ }
})()

// ---- effect presets: named Effect[] snapshots, same storage scheme --------

export type { FxPreset } from '@shared/types'
import type { FxPreset } from '@shared/types'

interface FxPresetState {
  presets: FxPreset[]
  savePreset(p: Omit<FxPreset, 'id'>): void
  deletePreset(id: string): void
}

const FX_LS_KEY = 'kadr.fxPresets'
const FX_FILE = 'fx-presets'

function loadFxCache(): FxPreset[] {
  try {
    const raw = localStorage.getItem(FX_LS_KEY)
    const arr = raw ? JSON.parse(raw) : []
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function persistFxPresets(presets: FxPreset[]) {
  window.kadr.writeUserStore(FX_FILE, presets).catch(() => { /* disk hiccup */ })
  try {
    localStorage.setItem(FX_LS_KEY, JSON.stringify(presets))
  } catch { /* cache only */ }
}

export const useFxPresets = create<FxPresetState>((set) => ({
  presets: loadFxCache(),
  savePreset: (p) =>
    set((s) => {
      const presets = [...s.presets, { ...p, id: uid() }]
      persistFxPresets(presets)
      return { presets }
    }),
  deletePreset: (id) =>
    set((s) => {
      const presets = s.presets.filter((x) => x.id !== id)
      persistFxPresets(presets)
      return { presets }
    })
}))

;(async () => {
  try {
    const fromFile = await window.kadr.readUserStore(FX_FILE)
    if (Array.isArray(fromFile) && fromFile.length) {
      useFxPresets.setState({ presets: fromFile as FxPreset[] })
      try {
        localStorage.setItem(FX_LS_KEY, JSON.stringify(fromFile))
      } catch { /* cache only */ }
    }
  } catch { /* file store unavailable — cache keeps working */ }
})()

export const MAX_ZOOM = 4000

export interface TimeRange {
  start: number
  end: number
}

interface ClipboardItem {
  kind: TrackKind
  trackId: string
  clip: Clip
}

/** A history entry remembers the state before the action plus its name (i18n key). */
interface HistEntry {
  project: Project
  label: string
}

interface EditorState {
  project: Project
  projectPath: string | null
  selection: string[]
  playhead: number
  playing: boolean
  previewLoading: boolean
  /** the preview's GL context died (GPU reset); nothing can be drawn until it is back */
  previewGpuLost: boolean
  /** timeline pixels per second */
  zoom: number
  exportOpen: boolean
  /** in/out fragment (Shift+drag on the timeline) */
  range: TimeRange | null
  /** clip whose animation/mask panel is open (double-click) */
  animClipId: string | null
  /** video track whose Track Motion editor is open */
  motionTrackId: string | null
  /** absolute time of a keyframe being dragged in a mini-timeline,
      highlighted on the main timeline while the drag lasts */
  kfMarker: number | null
  clipboard: ClipboardItem[]
  past: HistEntry[]
  future: HistEntry[]

  setProject(p: Project, path?: string | null): void
  setProjectPath(path: string | null): void
  /** a Claude chat of this project was just talked to: record it, last = latest.
   *  Always a new project object, so the unsaved dot and autosave see that the
   *  transcript in the file is behind. No undo entry: a chat is not an edit. */
  noteClaudeChat(id: string): void
  /** Snapshot current project; call once before a discrete edit or drag. */
  pushHistory(label: string): void
  undo(): void
  redo(): void

  addAsset(a: MediaAsset): void
  /** Remove media files from the bin AND every timeline clip that uses them
      (linked twins share the assetId) — one undo entry. */
  removeAssets(assetIds: string[]): void
  /** register transcript/text docs in the sources (one undo entry) */
  addTexts(docs: TextDoc[]): void
  /** Land a finished voice-over — asset, script docs, run record and clip — as
      one undoable step. */
  /** Land a spliced voice-over: new audio, remapped clips, rippled timeline —
      one undo entry. Returns null with a reason when it cannot be done safely. */
  applyVoiceSplice(v: {
    runId: string
    oldAssetId: string
    newAsset: MediaAsset
    /** каждая заменённая фраза и дефекты, которые ею закрыты */
    units: Array<{ cut0: number; cut1: number; patchDur: number; ids: string[] }>
    newDuration: number
    ripple: boolean
    rippleAllTracks: boolean
  }): { delta: number; warnings: string[] } | { error: string }
  /** Detector pass: run metadata + its findings, one undo entry. */
  applyCheckResult(runId: string, runPatch: Partial<VoiceRun>, defects: AudioDefect[]): void
  /** A defect the user spotted themselves. */
  addUserDefect(d: AudioDefect): void
  /** The user's verdict on one or many defects. */
  setDefectState(ids: string | string[], state: DefectState, patch?: Partial<AudioDefect>): void
  /** Edge drag and other live edits — the CALLER pushes history once. */
  updateDefect(id: string, patch: Partial<AudioDefect>): void
  removeDefects(ids: string | string[]): void
  addVoiceOver(v: {
    asset: MediaAsset
    run: VoiceRun
    texts?: TextDoc[]
    trackId?: string | null
    at: number
  }): { clipId: string; trackId: string } | null
  removeText(id: string): void
  /** place a remotion fragment clip on the topmost free video track */
  insertFragmentClip(fragmentId: string, meta: FragmentSpec, start: number, duration: number): string
  /** Patch asset metadata (e.g. a freshly built proxy path); no history. */
  updateAsset(assetId: string, patch: Partial<MediaAsset>): void
  addTrack(kind: TrackKind): void
  addTrackNear(refTrackId: string): void
  removeTrack(trackId: string): void
  moveTrack(trackId: string, toIndex: number): void
  updateTrack(trackId: string, patch: Partial<Track>): void

  insertClipFromAsset(assetId: string, trackId: string | null, at: number): void
  /** Place several assets back-to-back starting at `at` (one undo entry);
      audio assets go to an audio track regardless of the drop lane. */
  insertClipsFromAssets(assetIds: string[], trackId: string | null, at: number): void
  insertTextClip(at: number): void
  /** Add a track-independent timeline marker (auto-numbered); returns id. */
  addMarker(time: number): string
  moveMarker(id: string, time: number): void
  removeMarker(id: string): void
  updateClip(clipId: string, patch: Partial<Clip>): void
  /** Change speed/duration, rescaling keyframes and fades to stay on content.
      Optional `start` moves the clip too (a speed drag from the LEFT edge
      keeps the right edge anchored). */
  setClipSpeed(clipId: string, speed: number, duration: number, start?: number): void
  /** Change duration (loop-extend); linked partners follow. */
  setClipDuration(clipId: string, duration: number): void
  /** Pick the transition for a clip's incoming overlap ('none' = hard cut). */
  setTransition(clipId: string, type: string | null): void
  /** Set edge (tip) effects on clip heads/tails; one undo entry for the batch. */
  setEdgeTransitions(
    entries: { clipId: string; edge: 'in' | 'out'; type: string | null; duration?: number }[]
  ): void
  /** Unlink selected linked clips, or link an audio+video pair. */
  toggleLinkSelection(): void
  moveClip(clipId: string, trackId: string, start: number): void
  /** Batch-update clip positions (group drag), optionally across tracks. */
  setClipStarts(entries: { id: string; start: number; trackId?: string }[]): void
  trimClip(clipId: string, edge: 'in' | 'out', time: number): void
  splitAtPlayhead(): void
  deleteSelection(): void
  /** Close the gap between clips around `time` on a track (Ctrl+click). */
  closeGapAt(trackId: string, time: number): void
  copySelection(): void
  copyRange(): void
  deleteRange(): void
  pasteAtPlayhead(): void

  select(ids: string[]): void
  toggleSelect(id: string): void
  setAnimClip(id: string | null): void
  setMotionTrack(id: string | null): void
  setKfMarker(t: number | null): void
  setPlayhead(t: number): void
  setPlaying(p: boolean): void
  setPreviewLoading(l: boolean): void
  setPreviewGpuLost(lost: boolean): void
  setZoom(z: number): void
  setExportOpen(open: boolean): void
  setRange(r: TimeRange | null): void
}

const clone = <T,>(o: T): T => JSON.parse(JSON.stringify(o))

/** Asset fields DERIVED from the media file: the probe in the main process
    (electron/ffmpeg.ts) assigns them once, wholesale, and from then on nothing
    anywhere writes them — the timeline and the media bin only read. That is the
    invariant cloneProject() rests on; e2e28 fails if a copy stops sharing them. */
const ASSET_BLOBS = new Set(['waveform', 'thumbnail', 'thumbnailEnd'])

/** JSON.stringify silently drops these, so a faithful copy must drop them too. */
const dropped = (v: unknown) =>
  v === undefined || typeof v === 'function' || typeof v === 'symbol'

const cloneAsset = (a: MediaAsset): MediaAsset => {
  // a script-written project can hold junk in the list (kadr_eval writes
  // straight into the store); copy it exactly as a plain deep copy would
  if (!a || typeof a !== 'object') return clone(a)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(a)) {
    const v = (a as unknown as Record<string, unknown>)[key]
    if (dropped(v)) continue
    // the blob object itself travels into the copy — not a duplicate of it
    out[key] = ASSET_BLOBS.has(key) ? v : clone(v)
  }
  return out as unknown as MediaAsset
}

/**
 * Deep copy of a project. Every mutation makes one and so does every history
 * entry, i.e. twice per edit, so its cost is felt directly in the hand holding
 * the mouse — and its size is what the undo stack retains.
 *
 * Everything is copied except the assets' derived blobs, which are shared.
 * They are almost the whole project: on a real 78 MB project the waveforms are
 * 78.1 of it, and the numbers that follow are why this function exists —
 * a full copy took 248 ms and 50 history entries held 3.82 GB, which is
 * exactly where V8 gives up ("JavaScript heap out of memory", measured three
 * times in one working day). Sharing the blobs: 0.8 ms and 5.9 MB.
 *
 * The copy is built key by key rather than by blanking the blobs and round
 * tripping, so the live project is never modified even for an instant, key
 * order is preserved, and the result serializes byte for byte like a plain
 * deep copy — which e2e28 checks, on the project AND on the file written from
 * a restored one, because a copy that quietly lost a waveform would be
 * invisible until the day someone reopened that project.
 */
const cloneProject = (p: Project): Project => {
  if (!p || typeof p !== 'object' || !Array.isArray(p.assets)) return clone(p)
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(p)) {
    const v = (p as unknown as Record<string, unknown>)[key]
    if (dropped(v)) continue
    out[key] = key === 'assets' ? (v as MediaAsset[]).map(cloneAsset) : clone(v)
  }
  return out as unknown as Project
}

export const useEditor = create<EditorState>((set, get) => ({
  project: newProject(),
  projectPath: null,
  selection: [],
  playhead: 0,
  playing: false,
  previewLoading: false,
  previewGpuLost: false,
  zoom: 60,
  exportOpen: false,
  range: null,
  animClipId: null,
  motionTrackId: null,
  kfMarker: null,
  clipboard: [],
  past: [],
  future: [],

  setProject: (project, path = null) =>
    set({
      project: sanitizeProject(project), projectPath: path, past: [], future: [],
      selection: [], playhead: 0, playing: false, range: null
    }),
  setProjectPath: (projectPath) => set({ projectPath }),
  noteClaudeChat: (id) =>
    set((s) => ({
      project: { ...s.project, claudeChats: [...(s.project.claudeChats ?? []).filter((c) => c !== id), id] }
    })),

  pushHistory: (label) =>
    set((s) => ({
      past: [...s.past.slice(-49), { project: cloneProject(s.project), label }],
      future: []
    })),
  undo: () =>
    set((s) => {
      if (!s.past.length) return s
      const past = [...s.past]
      const entry = past.pop()!
      return {
        past,
        // chats are not an edit: undoing the clip before one must not drop it
        project: { ...entry.project, claudeChats: s.project.claudeChats },
        future: [{ project: cloneProject(s.project), label: entry.label }, ...s.future],
        selection: []
      }
    }),
  redo: () =>
    set((s) => {
      if (!s.future.length) return s
      const [entry, ...future] = s.future
      return {
        future,
        project: { ...entry.project, claudeChats: s.project.claudeChats },
        past: [...s.past, { project: cloneProject(s.project), label: entry.label }],
        selection: []
      }
    }),

  addAsset: (a) =>
    set((s) => ({ project: { ...s.project, assets: [...s.project.assets, a] } })),

  removeAssets: (assetIds) => {
    const ids = new Set(assetIds)
    const s = get()
    if (!s.project.assets.some((a) => ids.has(a.id))) return
    s.pushHistory('hDeleteMedia')
    set((st) => {
      const p = cloneProject(st.project)
      p.assets = p.assets.filter((a) => !ids.has(a.id))
      // озвучка и её дефекты держатся на ассете: без него они мусор, и
      // sanitizeProject всё равно выбросил бы их при следующей загрузке
      p.voiceRuns = (p.voiceRuns ?? []).filter((r) => !ids.has(r.assetId))
      p.defects = (p.defects ?? []).filter((d) => !ids.has(d.assetId))
      const dead = new Set<string>()
      // clips lose their source — drop them everywhere, locked tracks included
      for (const tr of p.tracks) {
        tr.clips = tr.clips.filter((c) => {
          const doomed = !!c.assetId && ids.has(c.assetId)
          if (doomed) dead.add(c.id)
          return !doomed
        })
      }
      return {
        project: p,
        selection: st.selection.filter((id) => !dead.has(id)),
        animClipId: st.animClipId && dead.has(st.animClipId) ? null : st.animClipId
      }
    })
  },

  applyVoiceSplice: ({ runId, oldAssetId, newAsset, units, newDuration,
                       ripple, rippleAllTracks }) => {
    const s = get()
    const sorted = [...units].sort((a, b) => a.cut0 - b.cut0)
    const total = sorted.reduce((n, u) => n + (u.patchDur - (u.cut1 - u.cut0)), 0)

    /** Source second before the splice → after it. null inside a replaced
        phrase: that audio no longer exists, so nothing may be mapped onto it. */
    const remap = (t: number): number | null => {
      let d = 0
      for (const u of sorted) {
        if (t > u.cut0 + 1e-6 && t < u.cut1 - 1e-6) return null
        if (t >= u.cut1 - 1e-6) d += u.patchDur - (u.cut1 - u.cut0)
      }
      return t + d
    }

    const affected: Array<{ clip: Clip; track: Track; oldStart: number; oldEnd: number
                            inPoint: number; duration: number }> = []
    for (const track of s.project.tracks) {
      for (const clip of track.clips) {
        if (clip.assetId !== oldAssetId) continue
        const speed = clip.speed || 1
        const a = remap(clip.inPoint)
        const b = remap(clip.inPoint + clip.duration * speed)
        if (a === null || b === null || b <= a) {
          // a clip edge sits inside the phrase being replaced: there is no
          // honest answer for where it should land, so we refuse instead of
          // silently mangling the cut the user made
          return { error: `клип «${clip.label}» разрезан внутри заменяемой фразы — ` +
            'автоматически починить нельзя. Сведите озвучку в один клип или снимите разрез.' }
        }
        affected.push({ clip, track, oldStart: clip.start, oldEnd: clip.start + clip.duration,
                        inPoint: a, duration: (b - a) / speed })
      }
    }
    if (!affected.length) return { error: 'на таймлайне нет клипов этой озвучки' }

    // Куда переехала каждая заменённая фраза: её начало на месте (remap не
    // двигает то, что до реза), а конец задаётся длиной вставки. Без этого
    // повторная перегенерация той же фразы резала бы по старым координатам.
    const unitOf = new Map<string, { from: number; to: number }>()
    for (const u of sorted) {
      const from = remap(u.cut0) ?? u.cut0
      for (const id of u.ids) unitOf.set(id, { from, to: from + u.patchDur })
    }

    const warnings: string[] = []
    let dropped = 0
    get().pushHistory('hVoiceFix')
    set((st) => {
      const p = cloneProject(st.project)
      p.assets = [...p.assets, newAsset]

      // shift events: after this clip ended, everything moves by d
      const events = affected.map((a) => ({ at: a.oldEnd, d: a.duration - (a.oldEnd - a.oldStart) }))
        .sort((x, y) => x.at - y.at)
      const shiftFor = (start: number) =>
        ripple ? events.reduce((n, e) => (e.at <= start + 1e-6 ? n + e.d : n), 0) : 0
      const tracksToRipple = new Set(
        rippleAllTracks ? p.tracks.filter((t) => !t.locked).map((t) => t.id)
                        : affected.map((a) => a.track.id))

      for (const track of p.tracks) {
        for (const c of track.clips) {
          const mine = affected.find((a) => a.clip.id === c.id)
          if (mine) {
            c.assetId = newAsset.id
            c.inPoint = mine.inPoint
            c.duration = mine.duration
            c.start = mine.oldStart + shiftFor(mine.oldStart)
            continue
          }
          if (!ripple || !tracksToRipple.has(track.id)) continue
          // a clip that STRADDLES the splice cannot be fixed by shifting: it
          // would have to stretch. Say so rather than pretend.
          const spans = events.some((e) => c.start < e.at - 1e-6 && c.start + c.duration > e.at + 1e-6)
          if (spans) {
            if (!warnings.length || !warnings.some((w) => w.includes('накрывает место склейки'))) {
              warnings.push('часть клипов накрывает место склейки — их длину сдвиг не исправит')
            }
            continue
          }
          c.start += shiftFor(c.start)
        }
      }
      if (!ripple) warnings.push('сдвиг выключен: клипы правее могут наехать друг на друга')

      p.voiceRuns = (p.voiceRuns ?? []).map((r) =>
        r.id === runId ? { ...r, assetId: newAsset.id, duration: newDuration } : r)

      const kept: AudioDefect[] = []
      for (const d of p.defects ?? []) {
        if (d.assetId !== oldAssetId) { kept.push(d); continue }
        const mine = unitOf.get(d.id)
        if (mine) {
          // ГРАНИЦЫ ОБЯЗАНЫ ПЕРЕЕХАТЬ. Раньше здесь менялись только ассет и
          // состояние, а фраза оставалась в координатах ДО склейки — и вторая
          // перегенерация той же фразы резала уже не там, третья ещё дальше, и
          // дорожка портилась. Теперь фраза — это ровно то, что сейчас вставлено.
          kept.push({
            ...d, assetId: newAsset.id, state: 'done', resultAssetId: newAsset.id,
            attempts: (d.attempts ?? 0) + 1,
            src: [mine.from, mine.to],
            phrase: { ...d.phrase, t0: mine.from, t1: mine.to }
          })
          continue
        }
        const a = remap(d.src[0])
        const b = remap(d.src[1])
        if (a === null || b === null) {
          // Звук этой находки заменён. Раньше она превращалась в отметку на всю
          // новую фразу — и свежая, ещё не разобранная запись оказывалась
          // целиком помечена дефектом. Правильно её просто убрать: решение по
          // ней уже выгружено в корпус (это делается ДО склейки), а что теперь
          // в этом месте звучит — знает только новый разбор.
          dropped++
          continue
        }
        const ph0 = remap(d.phrase.t0)
        const ph1 = remap(d.phrase.t1)
        kept.push({ ...d, assetId: newAsset.id, src: [a, b],
                    phrase: { ...d.phrase, t0: ph0 ?? a, t1: ph1 ?? b } })
      }
      p.defects = kept
      return { project: p }
    })
    if (dropped) {
      const n = dropped % 100
      const word = n >= 11 && n <= 14 ? 'отметок'
        : n % 10 === 1 ? 'отметка'
        : n % 10 >= 2 && n % 10 <= 4 ? 'отметки'
        : 'отметок'
      const verb = n % 10 === 1 && n !== 11 ? 'снята' : 'сняты'
      warnings.push(`внутри заменённых фраз ${verb} ещё ${dropped} ${word}: ` +
        'этого звука больше нет, переспросите детектор')
    }
    return { delta: total, warnings }
  },

  applyCheckResult: (runId, runPatch, defects) => {
    get().pushHistory('hDefects')
    set((s) => {
      const p = cloneProject(s.project)
      p.voiceRuns = (p.voiceRuns ?? []).map((r) => (r.id === runId ? { ...r, ...runPatch } : r))
      // прежние находки ЭТОГО прогона заменяем: повторный разбор — это новая
      // правда о файле, а не добавка к старой. Вердикты пользователя по другим
      // прогонам не трогаем.
      // ВАЖНО для этапа обучения: решения по заменяемым находкам должны быть
      // выгружены в корпус ДО этого вызова — здесь они перестают существовать.
      const keep = (p.defects ?? []).filter((d) => d.runId !== runId || d.origin === 'user')
      p.defects = [...keep, ...defects]
      return { project: p }
    })
  },

  addUserDefect: (d) => {
    get().pushHistory('hDefectUser')
    set((s) => ({ project: { ...s.project, defects: [...(s.project.defects ?? []), d] } }))
  },

  setDefectState: (ids, state, patch) => {
    const list = Array.isArray(ids) ? ids : [ids]
    if (!list.length) return
    get().pushHistory('hDefectVerdict')
    const now = Date.now()
    set((s) => ({
      project: {
        ...s.project,
        defects: (s.project.defects ?? []).map(
          (d) => (list.includes(d.id) ? { ...d, ...patch, state, judgedAt: now } : d))
      }
    }))
  },

  updateDefect: (id, patch) =>
    set((s) => ({
      project: {
        ...s.project,
        defects: (s.project.defects ?? []).map((d) => (d.id === id ? { ...d, ...patch } : d))
      }
    })),

  removeDefects: (ids) => {
    const list = Array.isArray(ids) ? ids : [ids]
    if (!list.length) return
    get().pushHistory('hDefectDelete')
    set((s) => ({
      project: {
        ...s.project,
        defects: (s.project.defects ?? []).filter((d) => !list.includes(d.id))
      }
    }))
  },

  addVoiceOver: ({ asset, run, texts, trackId, at }) => {
    // one history entry for the whole landing: the asset, its script docs, the
    // run record and the clip belong together — undoing half of it would leave
    // a voice-over whose audio or whose script is gone
    get().pushHistory('hSpeak')
    let result: { clipId: string; trackId: string } | null = null
    set((s) => {
      const p = cloneProject(s.project)
      p.assets = [...p.assets, asset]
      if (texts?.length) p.texts = [...(p.texts ?? []), ...texts]
      p.voiceRuns = [...(p.voiceRuns ?? []), run]
      let track = trackId ? p.tracks.find((t) => t.id === trackId && !t.locked) : undefined
      if (!track || track.kind !== 'audio') track = p.tracks.find((t) => t.kind === 'audio' && !t.locked)
      if (!track) {
        // insertClipsFromAssets would silently drop the clip here; a voice-over
        // that produced no sound on the timeline is a failure, not a no-op
        track = makeTrack(p, 'audio')
        p.tracks.push(track)
      }
      const clip: Clip = {
        id: uid(),
        assetId: asset.id,
        kind: 'media',
        start: Math.max(0, at),
        duration: asset.duration,
        inPoint: 0,
        label: asset.name,
        ...newClipDefaults()
      }
      track.clips.push(clip)
      result = { clipId: clip.id, trackId: track.id }
      return { project: p, selection: [clip.id] }
    })
    return result
  },

  addTexts: (docs) => {
    get().pushHistory('hText')
    set((s) => ({
      project: { ...s.project, texts: [...(s.project.texts ?? []), ...docs] }
    }))
  },

  removeText: (id) => {
    get().pushHistory('hText')
    set((s) => ({
      project: { ...s.project, texts: (s.project.texts ?? []).filter((t) => t.id !== id) }
    }))
  },

  insertFragmentClip: (fragmentId, meta, start, duration) => {
    const clipId = uid()
    get().pushHistory('hInsert')
    set((s) => {
      const p = cloneProject(s.project)
      const end = start + duration
      // topmost unlocked video track with the slot free, else a fresh one
      let track = p.tracks.find((t) =>
        t.kind === 'video' && !t.locked &&
        !t.clips.some((c) => c.start < end && c.start + c.duration > start)
      )
      if (!track) {
        track = makeTrack(p, 'video')
        p.tracks.unshift(track)
      }
      const clip: Clip = {
        id: clipId,
        kind: 'remotion',
        fragmentId,
        fragmentMeta: meta,
        start: Math.max(0, start),
        duration,
        inPoint: 0,
        label: meta.name,
        ...newClipDefaults()
      }
      track.clips.push(clip)
      return { project: p, selection: [clipId] }
    })
    return clipId
  },

  updateAsset: (assetId, patch) =>
    set((s) => {
      const p = cloneProject(s.project)
      const a = p.assets.find((x) => x.id === assetId)
      if (!a) return s
      Object.assign(a, patch)
      return { project: p }
    }),

  addTrack: (kind) => {
    get().pushHistory('hTrack')
    set((s) => {
      const p = cloneProject(s.project)
      p.tracks.splice(kind === 'video' ? 0 : p.tracks.length, 0, makeTrack(p, kind))
      return { project: p }
    })
  },

  addMarker: (time) => {
    get().pushHistory('hMarker')
    const id = uid()
    set((s) => {
      const p = cloneProject(s.project)
      p.markers ??= []
      const n = p.markers.reduce((m, x) => Math.max(m, parseInt(x.label, 10) || 0), 0) + 1
      p.markers.push({ id, time: Math.max(0, time), label: String(n) })
      return { project: p }
    })
    return id
  },

  moveMarker: (id, time) =>
    set((s) => {
      const m0 = s.project.markers?.find((x) => x.id === id)
      if (!m0) return {}
      const p = cloneProject(s.project)
      p.markers!.find((x) => x.id === id)!.time = Math.max(0, time)
      return { project: p }
    }),

  removeMarker: (id) => {
    get().pushHistory('hMarkerDelete')
    set((s) => {
      const p = cloneProject(s.project)
      p.markers = (p.markers ?? []).filter((x) => x.id !== id)
      return { project: p }
    })
  },

  addTrackNear: (refTrackId) => {
    const s = get()
    const idx = s.project.tracks.findIndex((t) => t.id === refTrackId)
    if (idx < 0) return
    const kind = s.project.tracks[idx].kind
    s.pushHistory('hTrack')
    set((st) => {
      const p = cloneProject(st.project)
      // video stacks above the clicked track, audio below it
      p.tracks.splice(kind === 'video' ? idx : idx + 1, 0, makeTrack(p, kind))
      return { project: p }
    })
  },

  removeTrack: (trackId) => {
    const s = get()
    if (!s.project.tracks.some((t) => t.id === trackId)) return
    s.pushHistory('hTrack')
    set((st) => {
      const p = cloneProject(st.project)
      p.tracks = p.tracks.filter((t) => t.id !== trackId)
      return { project: p, selection: [] }
    })
  },

  moveTrack: (trackId, toIndex) =>
    set((s) => {
      const p = cloneProject(s.project)
      const from = p.tracks.findIndex((t) => t.id === trackId)
      if (from < 0 || toIndex < 0 || toIndex >= p.tracks.length || from === toIndex) return s
      const [tr] = p.tracks.splice(from, 1)
      p.tracks.splice(toIndex, 0, tr)
      return { project: p }
    }),

  updateTrack: (trackId, patch) =>
    set((s) => {
      const p = cloneProject(s.project)
      const t = p.tracks.find((t) => t.id === trackId)
      if (t) Object.assign(t, patch)
      return { project: p }
    }),

  insertClipFromAsset: (assetId, trackId, at) =>
    get().insertClipsFromAssets([assetId], trackId, at),

  insertClipsFromAssets: (assetIds, trackId, at) => {
    const s = get()
    const found = assetIds
      .map((id) => s.project.assets.find((a) => a.id === id))
      .filter((a): a is MediaAsset => !!a)
    if (!found.length) return
    s.pushHistory('hInsert')
    set((st) => {
      const p = cloneProject(st.project)
      let cursor = Math.max(0, at)
      const ids: string[] = []
      for (const asset of found) {
        const wantKind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video'
        let track = trackId ? p.tracks.find((t) => t.id === trackId) : undefined
        if (!track || track.kind !== wantKind || track.locked) {
          track = p.tracks.find((t) => t.kind === wantKind && !t.locked)
        }
        if (!track) continue
        const duration = asset.kind === 'image' ? 5 : asset.duration
        const clip: Clip = {
          id: uid(),
          assetId: asset.id,
          kind: 'media',
          start: cursor,
          duration,
          inPoint: 0,
          label: asset.name,
          ...newClipDefaults()
        }
        track.clips.push(clip)
        ids.push(clip.id)
        // a video with sound also gets a linked audio clip on an audio track
        if (asset.kind === 'video' && asset.hasAudio) {
          const audioTrack = p.tracks.find((t) => t.kind === 'audio' && !t.locked)
          if (audioTrack) {
            const linkId = uid()
            clip.linkId = linkId
            clip.muted = true // sound comes from the audio-track twin
            const audioClip: Clip = {
              ...clone(clip),
              id: uid(),
              muted: false,
              linkId
            }
            audioTrack.clips.push(audioClip)
            ids.push(audioClip.id)
          }
        }
        cursor += duration // next dropped file starts where this one ends
      }
      if (!ids.length) return st
      return { project: p, selection: ids }
    })
  },

  setClipSpeed: (clipId, speed, duration, start) =>
    set((s) => {
      const p = cloneProject(s.project)
      // linked partners change tempo together
      for (const f of withLinked(p, [clipId])
        .map((id) => findClip(p, id))
        .filter((x): x is NonNullable<typeof x> => !!x && !x.track.locked)) {
        const c = f.clip
        const oldSpeed = c.speed || 1
        rescaleClipAnims(c, oldSpeed / speed)
        c.speed = speed
        c.duration = duration
        if (start !== undefined) c.start = Math.max(0, start)
      }
      return { project: p }
    }),

  setClipDuration: (clipId, duration) =>
    set((s) => {
      const p = cloneProject(s.project)
      for (const f of withLinked(p, [clipId])
        .map((id) => findClip(p, id))
        .filter((x): x is NonNullable<typeof x> => !!x && !x.track.locked)) {
        f.clip.duration = Math.max(0.05, duration)
      }
      return { project: p }
    }),

  setTransition: (clipId, type) => {
    get().pushHistory('hTransition')
    set((s) => {
      const p = cloneProject(s.project)
      const f = findClip(p, clipId)
      // duration is implicit: the transition spans the clip overlap
      if (f) f.clip.transitionIn = type ? { type, duration: 0 } : undefined
      return { project: p }
    })
  },

  setEdgeTransitions: (entries) => {
    get().pushHistory('hTransition')
    set((s) => {
      const p = cloneProject(s.project)
      for (const e of entries) {
        const f = findClip(p, e.clipId)
        if (!f || f.track.locked) continue
        const key = e.edge === 'in' ? 'transitionIn' : 'transitionOut'
        const prev = f.clip[key]
        // a previous overlap-style transition (duration 0) is not a tip length
        const keep = prev && prev.duration > 0.001 ? prev.duration : 0.5
        f.clip[key] = e.type
          ? { type: e.type, duration: Math.max(0.05, e.duration ?? keep) }
          : undefined
      }
      return { project: p }
    })
  },

  toggleLinkSelection: () => {
    const s = get()
    const sel = s.selection
    if (!sel.length) return
    const clips = sel
      .map((id) => findClip(s.project, id))
      .filter((x): x is NonNullable<typeof x> => !!x)
    const anyLinked = clips.some((f) => f.clip.linkId)
    s.pushHistory('hLink')
    set((st) => {
      const p = cloneProject(st.project)
      if (anyLinked) {
        const links = new Set(clips.map((f) => f.clip.linkId).filter(Boolean) as string[])
        for (const t of p.tracks) {
          for (const c of t.clips) if (c.linkId && links.has(c.linkId)) c.linkId = undefined
        }
      } else if (clips.length === 2 && clips[0].track.kind !== clips[1].track.kind) {
        const linkId = uid()
        for (const f of clips) {
          const fc = findClip(p, f.clip.id)
          if (fc) fc.clip.linkId = linkId
        }
      }
      return { project: p }
    })
  },

  insertTextClip: (at) => {
    const s = get()
    s.pushHistory('hInsert')
    set((st) => {
      const p = cloneProject(st.project)
      const track = p.tracks.find((t) => t.kind === 'video' && !t.locked)
      if (!track) return st
      const clip: Clip = {
        id: uid(),
        kind: 'text',
        text: 'Текст',
        textStyle: defaultTextStyle(),
        start: Math.max(0, at),
        duration: 4,
        inPoint: 0,
        label: 'Text',
        ...newClipDefaults()
      }
      track.clips.push(clip)
      return { project: p, selection: [clip.id] }
    })
  },

  updateClip: (clipId, patch) =>
    set((s) => {
      const p = cloneProject(s.project)
      const f = findClip(p, clipId)
      if (f) Object.assign(f.clip, patch)
      return { project: p }
    }),

  setClipStarts: (entries) =>
    set((s) => {
      const p = cloneProject(s.project)
      for (const e of entries) {
        const f = findClip(p, e.id)
        if (!f || f.track.locked) continue
        f.clip.start = Math.max(0, e.start)
        if (e.trackId && e.trackId !== f.track.id) {
          const dst = p.tracks.find((t) => t.id === e.trackId)
          if (dst && dst.kind === f.track.kind && !dst.locked) {
            f.track.clips = f.track.clips.filter((c) => c.id !== e.id)
            dst.clips.push(f.clip)
          }
        }
      }
      return { project: p }
    }),

  moveClip: (clipId, trackId, start) =>
    set((s) => {
      const p = cloneProject(s.project)
      const f = findClip(p, clipId)
      const dst = p.tracks.find((t) => t.id === trackId)
      if (!f || !dst || dst.locked) return s
      if (dst.kind !== f.track.kind) return s
      f.track.clips = f.track.clips.filter((c) => c.id !== clipId)
      f.clip.start = Math.max(0, start)
      dst.clips.push(f.clip)
      return { project: p }
    }),

  trimClip: (clipId, edge, time) =>
    set((s) => {
      const p = cloneProject(s.project)
      const first = findClip(p, clipId)
      if (!first || first.track.locked) return s
      // linked partners trim together
      const targets = withLinked(p, [clipId])
        .map((id) => findClip(p, id))
        .filter((x): x is NonNullable<typeof x> => !!x && !x.track.locked)
      for (const f of targets) {
        const c = f.clip
        const speed = c.speed || 1
        const asset = c.assetId ? p.assets.find((a) => a.id === c.assetId) : undefined
        if (edge === 'in') {
          const end = c.start + c.duration
          let ns = Math.min(Math.max(0, time), end - 0.05)
          let delta = ns - c.start
          // can't reveal media before the source start
          if (c.inPoint + delta * speed < 0) {
            delta = -c.inPoint / speed
            ns = c.start + delta
          }
          c.inPoint += delta * speed
          c.start = ns
          c.duration = end - ns
          shiftClipAnims(c, -delta) // keyframes stay glued to the content
        } else {
          let nd = Math.max(0.05, time - c.start)
          if (asset && asset.kind !== 'image') {
            // edge trim never reveals more than the source (unless already looping)
            const maxOut = Math.max((asset.duration - c.inPoint) / speed, c.duration)
            if (nd > maxOut) nd = maxOut
          }
          c.duration = nd
        }
      }
      return { project: p }
    }),

  splitAtPlayhead: () => {
    const s = get()
    const t = s.playhead
    const selIds = s.selection.length ? withLinked(s.project, s.selection) : []
    const targets = s.project.tracks.flatMap((tr) =>
      tr.locked ? [] : tr.clips.filter((c) =>
        (selIds.length === 0 || selIds.includes(c.id)) &&
        t > c.start + 0.02 && t < c.start + c.duration - 0.02
      )
    )
    if (!targets.length) return
    s.pushHistory('hSplit')
    set((st) => {
      const p = cloneProject(st.project)
      const newIds: string[] = []
      // halves of a linked pair stay linked pairwise
      const rightLinks = new Map<string, string>()
      for (const orig of targets) {
        const f = findClip(p, orig.id)
        if (!f) continue
        const c = f.clip
        const offset = t - c.start
        let rightLink: string | undefined
        if (c.linkId) {
          if (!rightLinks.has(c.linkId)) rightLinks.set(c.linkId, uid())
          rightLink = rightLinks.get(c.linkId)
        }
        const right: Clip = {
          ...clone(c),
          id: uid(),
          start: t,
          duration: c.duration - offset,
          inPoint: c.inPoint + offset * (c.speed || 1),
          fadeIn: 0,
          linkId: rightLink
        }
        shiftClipAnims(right, -offset)
        c.duration = offset
        c.fadeOut = 0
        f.track.clips.push(right)
        newIds.push(right.id)
      }
      return { project: p, selection: newIds }
    })
  },

  deleteSelection: () => {
    const s = get()
    if (!s.selection.length) return
    s.pushHistory('hDelete')
    set((st) => {
      const p = cloneProject(st.project)
      for (const tr of p.tracks) {
        if (tr.locked) continue
        tr.clips = tr.clips.filter((c) => !st.selection.includes(c.id))
      }
      return { project: p, selection: [] }
    })
  },

  closeGapAt: (trackId, time) => {
    const s = get()
    const track = s.project.tracks.find((t) => t.id === trackId)
    if (!track || track.locked) return
    let prevEnd = 0
    let nextStart = Infinity
    for (const c of track.clips) {
      const end = c.start + c.duration
      if (end <= time && end > prevEnd) prevEnd = end
      if (c.start >= time && c.start < nextStart) nextStart = c.start
    }
    if (!isFinite(nextStart) || nextStart - prevEnd < 1e-6) return
    const shift = nextStart - prevEnd
    s.pushHistory('hCloseGap')
    set((st) => {
      const p = cloneProject(st.project)
      const tr = p.tracks.find((t) => t.id === trackId)!
      for (const c of tr.clips) {
        if (c.start >= nextStart - 1e-6) c.start -= shift
      }
      return { project: p }
    })
  },

  copySelection: () => {
    const s = get()
    if (!s.selection.length) return
    const items: ClipboardItem[] = []
    for (const track of s.project.tracks) {
      for (const c of track.clips) {
        if (s.selection.includes(c.id)) {
          items.push({ kind: track.kind, trackId: track.id, clip: clone(c) })
        }
      }
    }
    set({ clipboard: items })
  },

  copyRange: () => {
    const s = get()
    if (!s.range) return
    const items: ClipboardItem[] = []
    for (const track of s.project.tracks) {
      for (const c of track.clips) {
        const piece = clipIntersection(c, s.range.start, s.range.end)
        if (piece) items.push({ kind: track.kind, trackId: track.id, clip: piece })
      }
    }
    if (items.length) set({ clipboard: items })
  },

  deleteRange: () => {
    const s = get()
    const r = s.range
    if (!r) return
    s.pushHistory('hDeleteRange')
    set((st) => {
      const p = cloneProject(st.project)
      for (const tr of p.tracks) {
        if (tr.locked) continue
        const out: Clip[] = []
        for (const c of tr.clips) {
          const end = c.start + c.duration
          const speed = c.speed || 1
          if (end <= r.start + 1e-6 || c.start >= r.end - 1e-6) {
            out.push(c) // outside
          } else if (c.start >= r.start - 1e-6 && end <= r.end + 1e-6) {
            // fully inside — drop
          } else if (c.start < r.start && end > r.end) {
            // covers the range — split into two
            const right: Clip = {
              ...clone(c),
              id: uid(),
              start: r.end,
              duration: end - r.end,
              inPoint: c.inPoint + (r.end - c.start) * speed,
              fadeIn: 0,
              linkId: undefined
            }
            shiftClipAnims(right, -(r.end - c.start))
            c.duration = r.start - c.start
            c.fadeOut = 0
            out.push(c, right)
          } else if (c.start < r.start) {
            c.duration = r.start - c.start
            out.push(c)
          } else {
            const cut = r.end - c.start
            c.inPoint += cut * speed
            c.duration = end - r.end
            c.start = r.end
            shiftClipAnims(c, -cut)
            out.push(c)
          }
        }
        tr.clips = out
      }
      return { project: p, selection: [] }
    })
  },

  pasteAtPlayhead: () => {
    const s = get()
    if (!s.clipboard.length) return
    s.pushHistory('hPaste')
    set((st) => {
      const p = cloneProject(st.project)
      const base = Math.min(...st.clipboard.map((i) => i.clip.start))
      const ids: string[] = []
      const linkMap = new Map<string, string>() // fresh linkIds for pasted pairs
      for (const item of st.clipboard) {
        const track =
          p.tracks.find((t) => t.id === item.trackId && !t.locked) ??
          p.tracks.find((t) => t.kind === item.kind && !t.locked)
        if (!track) continue
        let linkId: string | undefined
        if (item.clip.linkId) {
          if (!linkMap.has(item.clip.linkId)) linkMap.set(item.clip.linkId, uid())
          linkId = linkMap.get(item.clip.linkId)
        }
        const clip: Clip = {
          ...clone(item.clip),
          id: uid(),
          start: Math.max(0, st.playhead + (item.clip.start - base)),
          linkId
        }
        track.clips.push(clip)
        ids.push(clip.id)
      }
      return { project: p, selection: ids }
    })
  },

  select: (selection) => set({ selection }),
  toggleSelect: (id) =>
    set((s) => ({
      selection: s.selection.includes(id)
        ? s.selection.filter((x) => x !== id)
        : [...s.selection, id]
    })),
  setAnimClip: (animClipId) =>
    set((s) => ({ animClipId, motionTrackId: animClipId ? null : s.motionTrackId })),
  setMotionTrack: (motionTrackId) =>
    set((s) => ({ motionTrackId, animClipId: motionTrackId ? null : s.animClipId })),
  setKfMarker: (kfMarker) => set({ kfMarker }),
  setPlayhead: (t) => set({ playhead: Math.max(0, t) }),
  setPlaying: (playing) => set({ playing }),
  setPreviewLoading: (previewLoading) => set({ previewLoading }),
  setPreviewGpuLost: (previewGpuLost) => set({ previewGpuLost }),
  setZoom: (zoom) => set({ zoom: Math.min(MAX_ZOOM, Math.max(4, zoom)) }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setRange: (range) =>
    set({ range: range && range.end - range.start > 0.01 ? range : null })
}))

function makeTrack(p: Project, kind: TrackKind): Track {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1
  return {
    id: uid(),
    kind,
    name: (kind === 'video' ? 'V' : 'A') + n,
    muted: false,
    locked: false,
    gain: 1,
    clips: []
  }
}

/** The part of a clip inside [from..to], or null if they don't overlap. */
function clipIntersection(c: Clip, from: number, to: number): Clip | null {
  const end = c.start + c.duration
  const a = Math.max(c.start, from)
  const b = Math.min(end, to)
  if (b - a < 0.01) return null
  const speed = c.speed || 1
  const piece: Clip = JSON.parse(JSON.stringify(c))
  piece.start = a
  piece.duration = b - a
  piece.inPoint = c.inPoint + (a - c.start) * speed
  if (a > c.start) {
    piece.fadeIn = 0
    shiftClipAnims(piece, -(a - c.start))
  }
  if (b < end) piece.fadeOut = 0
  return piece
}
