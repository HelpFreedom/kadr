// «Реакция на звук»: bake the sound under a Remotion fragment clip into its
// folder, so the composition can move with the music — one value per
// COMPOSITION frame for loudness and three bands, plus the beats in
// composition seconds. Two files are written next to the entry:
//   audio.json — the data (regenerated on every bake)
//   audio.ts   — `useAudio()` / `audioAt()` / `beats`, the way to read it
// The composition imports audio.ts; nothing else about it changes.
//
// Composition time ↔ timeline: the preview drives frame
//   f = round(((t − clip.start)·speed + inPoint)·fps)
// (FragmentOverlays), so composition second τ plays at timeline
//   t = clip.start + (τ − inPoint)/speed.
// The WHOLE composition is baked, not just the visible part, so trimming the
// clip later does not leave frames without data.
//
// What was baked is fingerprinted into `clip.audioBake.hash` — the placement
// and every audio segment under the clip. A move, a trim, a gain change or a
// different music clip changes the hash: the Inspector says «устарело», and an
// export re-bakes before rendering (materializeFragments).
import { useEditor, findClip } from '@/state/store'
import { sampleCurve } from '@shared/audioAnalysis'
import type { AudioAnalysisResult, AudioSegment, Clip, Project } from '@shared/types'
import { collectRangeAudio } from './subtitles'
import { logInfo, logWarn } from './log'

/** default beat pulse decay in audio.ts, seconds */
export const BEAT_DECAY = 0.15

/**
 * Seconds of music listened to on each side of the composition. The beat
 * tracker needs context: its tempo comes from 8-second autocorrelation windows,
 * so a 4-second fragment analysed alone gets a shakier grid than the same
 * music analysed whole. The curves are also normalised over this wider window,
 * so a fragment does not blow a quiet passage up to full scale.
 */
export const BAKE_CONTEXT = 8

export interface BakePlan {
  fps: number
  frames: number
  /** timeline second of composition frame 0 (may be negative) */
  t0: number
  /** timeline seconds per composition frame */
  step: number
  /** span analysed: the composition ± BAKE_CONTEXT, timeline seconds (clamped at 0) */
  range: { start: number; end: number }
  segments: AudioSegment[]
  /** anything audible under the composition itself (not just in the context) */
  audible: boolean
  source: string
  hash: string
}

/** FNV-1a over a string, hex — a fingerprint, not a security boundary. */
function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** What a bake of this clip would listen to — pure, so staleness is a comparison. */
export function bakePlan(project: Project, clip: Clip, source = 'mix'): BakePlan | null {
  if (clip.kind !== 'remotion' || !clip.fragmentMeta) return null
  const fps = clip.fragmentMeta.fps || 60
  const frames = Math.max(1, Math.round(clip.fragmentMeta.durationInFrames || 1))
  const speed = clip.speed || 1
  const t0 = clip.start - (clip.inPoint || 0) / speed
  const step = 1 / (fps * speed)
  const end = t0 + frames * step
  const range = { start: Math.max(0, t0 - BAKE_CONTEXT), end: end + BAKE_CONTEXT }
  const filter = source === 'mix' ? undefined : { trackIds: [source] }
  const segments = range.end > range.start ? collectRangeAudio(project, range.start, range.end, filter) : []
  const audible = end > Math.max(0, t0) &&
    collectRangeAudio(project, Math.max(0, t0), end, filter).length > 0
  // the song's map on the timeline (bars, sections, pauses) is baked too: a new
  // analysis there makes the bake stale
  const music = (project.markers ?? [])
    .filter((m) => (m.kind === 'beat' || m.kind === 'section' || m.kind === 'pause') &&
      (m.end ?? m.time) >= t0 - 1 && m.time <= end + 1)
    .map((m) => [m.kind, +m.time.toFixed(4), m.end ?? 0, m.bar ?? 0, m.beatInBar ?? 0, m.section ?? ''])
  const hash = fnv(JSON.stringify({ fps, frames, t0: +t0.toFixed(6), speed, source, segments, music }))
  return { fps, frames, t0, step, range, segments, audible, source, hash }
}

/** Seconds of music around the composition analysed for bars and sections when
    the timeline carries no analysis of its own there (see musicMap). */
export const STRUCTURE_CONTEXT = 60

/** The song's structure in composition seconds. */
export interface MusicMap {
  meter: number
  /** [tau, strength, strong 0|1, bar, beatInBar] — bar/beatInBar 0 when unknown */
  beats: [number, number, number, number, number][]
  /** [start, end, label, energy] */
  sections: [number, number, string, number][]
  pauses: [number, number][]
  /** where the kicks sit against the grid, ms (negative = before it) */
  kickOffsetMs: number
}

export type BakeState = 'none' | 'fresh' | 'stale'

export function bakeState(project: Project, clip: Clip): BakeState {
  if (!clip.audioBake) return 'none'
  const plan = bakePlan(project, clip, clip.audioBake.source)
  return plan && plan.hash === clip.audioBake.hash ? 'fresh' : 'stale'
}

/** The generated reader. Kept free of project data so it never needs regenerating. */
export const AUDIO_TS = `// Generated by Kadr («Реакция на звук»). The sound under this clip, baked into
// audio.json — one value per COMPOSITION frame. Both files are overwritten on
// every bake: keep your own code in index.tsx and read the sound from here.
//
//   import { useAudio, useAccent, breathAt, sectionAt, bars, sections, pauses } from './audio'
//   const a = useAudio()          // inside a component
//   a.level, a.bass, a.mid, a.treble   0..1, normalised over the clip, smoothed
//   a.beat    1 on every beat, decaying to 0 in ~0.15 s
//   a.accent  the same, only on the accented (strongest) beats
//   a.beatIndex / a.sinceBeat / a.bpm
//
//   const x = useAccent()         // the HIERARCHY of the bar — use this for motion
//   x.hit     1 on the "one" of a bar, 0.35 on the other beats, 0 in a pause
//   x.bar     a pulse on the "one" only; x.beat a pulse on every beat
//   x.beatInBar 1..meter, x.barNumber, x.section ('intro'|'verse'|'build'|
//   'chorus'|'break'|'outro'), x.energy (0..1 of that section), x.pause
//   breathAt(frame, fps)  a slow swell once per bar, peaking on the "one",
//   as deep as the section is energetic — a glow that breathes, not pulses
//
// Big events (a change of scene, a part landing, a reveal) on the "one"; small
// ones (clicks, turns, layers) on the other beats; nothing in a pause. The
// pulses lead the grid by the measured kick offset, so they land WITH the kick.
// Taste (from /brag): let the music make EXISTING things breathe — a glow, a
// scale of a few percent, a background warming up — not an equaliser, not a
// strobe, and never text that pulses so hard it cannot be read.
import { useCurrentFrame, useVideoConfig } from 'remotion'
import data from './audio.json'

export interface AudioFrame {
  level: number
  bass: number
  mid: number
  treble: number
  beat: number
  accent: number
  /** last beat at or before now, -1 before the first */
  beatIndex: number
  /** seconds since that beat, Infinity before the first */
  sinceBeat: number
  bpm: number
}

export interface BeatInfo {
  /** composition seconds */
  time: number
  /** 0..1 */
  strength: number
  strong: boolean
  /** bar number (0 = unknown or a pickup) and the beat's place in it, 1..meter (0 = unknown) */
  bar: number
  beatInBar: number
}

export interface SectionInfo { start: number; end: number; label: string; energy: number }

export interface Accent {
  /** the hierarchy: 1 on the "one", 0.35 on the other beats, 0 in a pause (decaying) */
  hit: number
  /** a pulse on the "one" of a bar only */
  bar: number
  /** a pulse on every beat */
  beat: number
  beatInBar: number
  barNumber: number
  section: string
  energy: number
  pause: boolean
}

const D = data as unknown as {
  fps: number
  bpm: number
  meter?: number
  level: number[]
  bass: number[]
  mid: number[]
  treble: number[]
  beats: number[][]
  sections?: [number, number, string, number][]
  pauses?: [number, number][]
  kickOffsetMs?: number
}

export const beats: BeatInfo[] = D.beats.map(([time, strength, strong, bar = 0, beatInBar = 0]) =>
  ({ time, strength, strong: strong === 1, bar, beatInBar }))
export const bpm = D.bpm
export const meter = D.meter ?? 4
/** composition seconds of the "one" of every bar */
export const bars: number[] = beats.filter((b) => b.beatInBar === 1 && b.bar > 0).map((b) => b.time)
export const sections: SectionInfo[] = (D.sections ?? []).map(([start, end, label, energy]) => ({ start, end, label, energy }))
export const pauses: [number, number][] = D.pauses ?? []
/** where the kicks sit against the grid, ms (negative = before the beat) */
export const kickOffsetMs = D.kickOffsetMs ?? 0

const pick = (arr: number[], f: number) => (arr.length ? arr[Math.max(0, Math.min(arr.length - 1, f))] : 0)

/** index of the last beat at or before t (seconds) that passes \`ok\`, -1 if none */
function lastBeat(t: number, ok: (b: BeatInfo) => boolean = () => true): number {
  let lo = 0
  let hi = beats.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (beats[mid].time <= t + 1e-6) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  while (ans >= 0 && !ok(beats[ans])) ans--
  return ans
}

/** The sound at a composition frame. \`decay\` = seconds for a beat pulse to fall to ~5 %. */
export function audioAt(frame: number, fps: number, decay = ${BEAT_DECAY}): AudioFrame {
  // the data was baked at the composition's own fps; resample if asked for another
  const f = Math.round((frame / fps) * (D.fps || fps))
  const t = frame / fps
  const i = lastBeat(t)
  const j = lastBeat(t, (b) => b.strong)
  const pulse = (k: number) => (k < 0 ? 0 : Math.exp((-3 * (t - beats[k].time)) / Math.max(1e-3, decay)))
  return {
    level: pick(D.level, f),
    bass: pick(D.bass, f),
    mid: pick(D.mid, f),
    treble: pick(D.treble, f),
    beat: pulse(i),
    accent: pulse(j),
    beatIndex: i,
    sinceBeat: i < 0 ? Infinity : t - beats[i].time,
    bpm: D.bpm
  }
}

/** The sound at the current frame of the composition. */
export function useAudio(decay?: number): AudioFrame {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return audioAt(frame, fps, decay)
}

/** The section at composition second t (the nearest one outside them all). */
export function sectionAt(t: number): SectionInfo | null {
  for (const s of sections) if (t >= s.start && t < s.end) return s
  return sections.length ? sections[t < sections[0].start ? 0 : sections.length - 1] : null
}

export const inPause = (t: number) => pauses.some(([a, b]) => t >= a && t < b)

/**
 * The bar's hierarchy at a composition frame: a big pulse on the "one", a
 * small one on the other beats, nothing in a pause. The pulses lead the grid
 * by the measured kick offset. \`decay\` = seconds to ~5 %; \`small\` = the
 * other beats' share of a "one".
 */
export function accentAt(frame: number, fps: number, opts: { decay?: number; small?: number } = {}): Accent {
  const decay = opts.decay ?? 0.3
  const small = opts.small ?? 0.35
  const t = frame / fps - kickOffsetMs / 1000
  const sec = sectionAt(t)
  const pause = inPause(t)
  const i = lastBeat(t)
  const k = lastBeat(t, (b) => b.beatInBar === 1)
  const pulse = (n: number) => (n < 0 ? 0 : Math.exp((-3 * (t - beats[n].time)) / Math.max(1e-3, decay)))
  const b = i >= 0 ? beats[i] : null
  const down = !!b && b.beatInBar === 1
  const unknown = !!b && b.beatInBar === 0
  const hit = pause || !b ? 0 : pulse(i) * (down || unknown ? 1 : small)
  return {
    hit,
    bar: pause ? 0 : pulse(k),
    beat: pause ? 0 : pulse(i),
    beatInBar: b?.beatInBar ?? 0,
    barNumber: b?.bar ?? 0,
    section: sec?.label ?? '',
    energy: sec?.energy ?? 0.5,
    pause
  }
}

export function useAccent(opts?: { decay?: number; small?: number }): Accent {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  return accentAt(frame, fps, opts)
}

/**
 * A swell once per bar, 0..1, peaking on the "one" and as deep as the section
 * is energetic (0.3..1 of full depth). Falls back to 4 beats of the tempo.
 */
export function breathAt(frame: number, fps: number): number {
  const t = frame / fps
  const k = lastBeat(t, (b) => b.beatInBar === 1)
  const barLen = meter * 60 / Math.max(1, D.bpm || 120)
  const phase = k < 0 ? t / barLen : (t - beats[k].time) / barLen
  const depth = 0.3 + 0.7 * (sectionAt(t)?.energy ?? 0.5)
  return depth * (0.5 + 0.5 * Math.cos(2 * Math.PI * phase))
}
`

/**
 * The music map of a clip's composition: from the timeline's own analysis
 * markers when they cover it (what the user sees and snaps to), else from
 * `wide` — an analysis of the music ±STRUCTURE_CONTEXT around it (±8 s is too
 * little to find the "one" of a bar, and nothing for sections). Pure.
 */
export function musicMap(project: Project, plan: BakePlan, clip: Clip,
  wide: { analysis: AudioAnalysisResult; start: number } | null): MusicMap {
  const speed = clip.speed || 1
  const inPoint = clip.inPoint || 0
  const tau = (tl: number) => Math.round((inPoint + (tl - clip.start) * speed) * 1000) / 1000
  const len = plan.frames / plan.fps
  const inside = (a: number, b = a) => b >= -1e-6 && a <= len + 1e-6
  const end = plan.t0 + plan.frames * plan.step
  const marks = (project.markers ?? []).filter((m) => (m.end ?? m.time) >= plan.t0 && m.time <= end)
  const barBeats = marks.filter((m) => m.kind === 'beat' && m.beatInBar !== undefined)
  // only a FULL grid will do: a timeline thinned to "the first beat of a bar"
  // or "1 and 3" would bake a fragment that has lost its other beats
  const places = new Set(barBeats.map((m) => m.beatInBar))
  const top = Math.max(0, ...[...places].map((x) => x ?? 0))
  const full = top >= 3 && [...Array(top)].every((_, i) => places.has(i + 1))
  if (barBeats.length >= 2 && full) {
    const sections = marks.filter((m) => m.kind === 'section')
    const pauses = marks.filter((m) => m.kind === 'pause')
    return {
      meter: Math.max(...barBeats.map((m) => m.beatInBar ?? 1)) >= 4 ? 4 : 3,
      beats: barBeats.map((m) => [tau(m.time), Math.round((m.strength ?? 0) * 1000) / 1000, m.strong ? 1 : 0, m.bar ?? 0, m.beatInBar ?? 0] as [number, number, number, number, number])
        .filter(([t]) => inside(t)),
      sections: sections.map((m) => [tau(m.time), tau(m.end ?? m.time), m.section ?? 'verse', m.energy ?? 0.5] as [number, number, string, number])
        .filter(([a, b]) => inside(a, b)),
      pauses: pauses.map((m) => [tau(m.time), tau(m.end ?? m.time)] as [number, number]).filter(([a, b]) => inside(a, b)),
      kickOffsetMs: 0
    }
  }
  if (!wide) return { meter: 4, beats: [], sections: [], pauses: [], kickOffsetMs: 0 }
  const { analysis: a, start } = wide
  const rh = a.rhythm
  return {
    meter: rh?.meter ?? 4,
    beats: a.beats.map((b) => [tau(start + b.time), Math.round(b.intensity * 1000) / 1000, b.strong ? 1 : 0, b.bar ?? 0, b.beatInBar ?? 0] as [number, number, number, number, number])
      .filter(([t]) => inside(t)),
    sections: (rh?.sections ?? []).map((x) => [tau(start + x.start), tau(start + x.end), x.label, x.energy] as [number, number, string, number])
      .filter(([s0, s1]) => inside(s0, s1)),
    pauses: (rh?.pauses ?? []).map((x) => [tau(start + x.start), tau(start + x.end)] as [number, number]).filter(([s0, s1]) => inside(s0, s1)),
    kickOffsetMs: rh?.kickOffsetMs?.median ?? 0
  }
}

/** Bake from an analysis already made for plan.range (pure: builds the audio.json object). */
export function audioJson(plan: BakePlan, a: AudioAnalysisResult, clip: Clip, map?: MusicMap) {
  const times: number[] = []
  // times relative to the analysed range: composition frame k plays at t0 + k·step
  for (let k = 0; k < plan.frames; k++) times.push(plan.t0 + k * plan.step - plan.range.start)
  const speed = clip.speed || 1
  const inPoint = clip.inPoint || 0
  const beats = a.beats
    .map((b) => {
      const tl = plan.range.start + b.time
      const tau = inPoint + (tl - clip.start) * speed
      return [Math.round(tau * 1000) / 1000, Math.round(b.intensity * 1000) / 1000, b.strong ? 1 : 0]
    })
    .filter(([tau]) => tau >= 0 && tau <= plan.frames / plan.fps + 1e-6)
  return {
    generatedBy: 'Kadr — Реакция на звук',
    fps: plan.fps,
    frames: plan.frames,
    bpm: a.tempo,
    source: plan.source,
    timeline: { start: +plan.t0.toFixed(4), end: +(plan.t0 + plan.frames * plan.step).toFixed(4) },
    level: sampleCurve(a.curves.rms, a.frameRate, times),
    bass: sampleCurve(a.curves.bass, a.frameRate, times),
    mid: sampleCurve(a.curves.mid, a.frameRate, times),
    treble: sampleCurve(a.curves.treble, a.frameRate, times),
    // the bars' beats when there is a map (a finer grid of the whole song),
    // else the ±8 s analysis' own beats — same layout, bar/beatInBar 0
    beats: map?.beats.length ? map.beats : beats.map((b) => [...b, 0, 0]),
    meter: map?.meter ?? 4,
    sections: map?.sections ?? [],
    pauses: map?.pauses ?? [],
    kickOffsetMs: map?.kickOffsetMs ?? 0
  }
}

export interface BakeResult {
  clipId: string
  fragmentId: string
  files: string[]
  frames: number
  bpm: number
  beats: number
  /** false = there is no sound under the clip; files were still written (flat zeros) */
  audible: boolean
}

/**
 * Bake the sound under `project`'s clip into its fragment and record the bake
 * on the live clip. `project` is normally the live one; the exporter passes the
 * snapshot it is rendering.
 */
export async function bakeClip(project: Project, clipId: string, source = 'mix'): Promise<BakeResult> {
  const found = findClip(project, clipId)
  if (!found) throw new Error('клип не найден')
  const clip = found.clip
  if (clip.kind !== 'remotion' || !clip.fragmentId) throw new Error('реакция на звук — только для фрагментов (Remotion)')
  if (source !== 'mix' && !project.tracks.some((t) => t.id === source)) throw new Error('дорожка-источник не найдена')
  const plan = bakePlan(project, clip, source)!
  const duration = Math.max(0.05, plan.range.end - plan.range.start)
  const analysis = await window.kadr.audioAnalyze({ audioSegments: plan.segments, duration })
  // bars and sections: the timeline's own analysis if it covers the clip,
  // else the music around it, analysed wide enough to find them
  let wide: { analysis: AudioAnalysisResult; start: number } | null = null
  const fromTimeline = musicMap(project, plan, clip, null).beats.length > 0
  if (!fromTimeline && plan.audible) {
    const filter = source === 'mix' ? undefined : { trackIds: [source] }
    const start = Math.max(0, plan.t0 - STRUCTURE_CONTEXT)
    const end = plan.t0 + plan.frames * plan.step + STRUCTURE_CONTEXT
    const segs = collectRangeAudio(project, start, end, filter)
    if (segs.length) wide = { analysis: await window.kadr.audioAnalyze({ audioSegments: segs, duration: end - start }), start }
  }
  const json = audioJson(plan, analysis, clip, musicMap(project, plan, clip, wide))
  const files = [
    await window.kadr.fragmentWriteFile(clip.fragmentId, 'audio.json', JSON.stringify(json)),
    await window.kadr.fragmentWriteFile(clip.fragmentId, 'audio.ts', AUDIO_TS)
  ]
  // record on the LIVE clip (the exporter's snapshot is a copy); no undo entry —
  // the files on disk are not part of the undo stack either
  const live = findClip(useEditor.getState().project, clipId)
  if (live) {
    useEditor.setState((s) => {
      const p = { ...s.project }
      p.tracks = p.tracks.map((t) => (t.clips.some((c) => c.id === clipId)
        ? { ...t, clips: t.clips.map((c) => (c.id === clipId
            ? { ...c, audioBake: { hash: plan.hash, source, at: Date.now() } } : c)) }
        : t))
      return { project: p }
    })
  }
  logInfo('звук→фрагмент', `${clip.fragmentId}: ${json.frames} кадров, ${json.beats.length} битов, ${analysis.tempo.toFixed(1)} BPM`)
  return {
    clipId,
    fragmentId: clip.fragmentId,
    files,
    frames: json.frames,
    bpm: analysis.tempo,
    beats: json.beats.length,
    audible: plan.audible
  }
}

/** Bake the live clip (UI / scripts). */
export function bakeAudio(clipId: string, opts: { source?: string } = {}): Promise<BakeResult> {
  const p = useEditor.getState().project
  const clip = findClip(p, clipId)?.clip
  return bakeClip(p, clipId, opts.source ?? clip?.audioBake?.source ?? 'mix')
}

/**
 * Before an export: re-bake every fragment whose bake no longer matches what
 * is under it, so the render hears the edit as it is now. A fragment used by
 * several clips at different places cannot be right for all of them — that is
 * reported and left alone.
 */
export async function refreshStaleBakes(project: Project): Promise<number> {
  const clips = project.tracks.flatMap((t) => t.clips).filter((c) => c.kind === 'remotion' && c.fragmentId)
  let n = 0
  for (const clip of clips) {
    if (!clip.audioBake || bakeState(project, clip) !== 'stale') continue
    const users = clips.filter((c) => c.fragmentId === clip.fragmentId)
    if (users.length > 1) {
      logWarn('звук→фрагмент', `фрагмент ${clip.fragmentId} стоит на таймлайне ${users.length} раза — звук запечён для одного места, обновите вручную`)
      continue
    }
    await bakeClip(project, clip.id, clip.audioBake.source)
    n++
  }
  return n
}
