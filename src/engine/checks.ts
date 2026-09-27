// «Проверка»: the rules a music-driven motion piece is judged by, checked
// against what its fragments DECLARE (fragment.inspect — events, captions,
// the camera; see electron/fragment-kit/runtime.ts) and against the picture.
//
// Every rule here came out of a real session that took six rounds instead of
// one: events missing the beat, text the viewer could not read in time, text
// that drifted with the camera, two captions at once, a camera that jerked,
// seams between the fragments of one film. What a fragment does not declare
// is not checked — nothing is guessed from its code.
//
// Times in the results are TIMELINE seconds.
import { create } from 'zustand'
import type { Clip, FragmentInspect, Project, TimelineMarker, Track } from '@shared/types'
import { useEditor } from '@/state/store'
import { evalAnim } from './anim'
import { framePixels } from './snapshot'
import { logInfo } from './log'

/** The limits, named. Each is a rule a reviewer would apply by eye. */
export const CHECK_LIMITS = {
  /** an event this far from a beat is "off the beat" (±40 ms) */
  beatMs: 40,
  /** readable text holds still: faster than this while fully visible = moving */
  textMovePxPerSec: 20,
  /** reading time: 1–3 words ≥ 0.8 s, longer ≥ max(1.2 s, 0.3 s per word), a subtitle +0.7 s */
  readShortWords: 3,
  readShort: 0.8,
  readPhrase: 1.2,
  readPerWord: 0.3,
  readSub: 0.7,
  /** WCAG contrast of a caption against its real background: titles (large) 3, other text 4.5 */
  contrastLarge: 3,
  contrastText: 4.5,
  /** a cut between windows of one film is visible above this mean |Δ| per channel */
  seam: 3 / 255,
  /** a camera's speed (travel or turn) changing within ONE 1/30 s step by more than
      this share of its own peak around it (±0.5 s) = a jerk. Relative to the local
      peak on purpose: a fast whip move eased in and out (measured on an approved
      film: 1 → 15 units/s in 0.4 s) changes by ~10–15 % of its peak per step,
      a move that starts or stops dead by close to 100 % */
  cameraStep: 0.35,
  /** turns slower than this (°/s) at their peak are too slow to jerk visibly */
  cameraTurnFloor: 20,
  /** the travel direction of the acceleration flipping this many times in 0.5 s = shaking */
  cameraShakeFlips: 5
} as const

export type CheckKind =
  | 'inspectError' | 'noBeats'
  | 'offBeat' | 'bigOffDownbeat' | 'emptyDownbeats' | 'eventInPause'
  | 'textShort' | 'textConcurrent' | 'textOverlap' | 'textMoving' | 'contrast'
  | 'seam' | 'cameraJerk' | 'collision' | 'contact'

export interface CheckIssue {
  kind: CheckKind
  level: 'warn' | 'info'
  /** timeline seconds */
  t: number
  end?: number
  clipId?: string
  fragmentId?: string
  message: string
}

/** a declared event placed on the timeline (for the lane under the clip) */
export interface TimedEvent { t: number; kind: 'big' | 'small'; label?: string; clipId: string; trackId: string }

export interface CheckResult {
  issues: CheckIssue[]
  events: TimedEvent[]
  checked: { clips: number; events: number; texts: number; cameras: number; seams: number; contrast: number; collisions: number }
}

export const useChecksUi = create<{
  open: boolean
  running: boolean
  result: CheckResult | null
  setOpen(v: boolean): void
}>((set) => ({ open: false, running: false, result: null, setOpen: (open) => set({ open }) }))

const fmt = (t: number) => {
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`
}

/** composition second → timeline second for a clip (null outside it) */
function toTimeline(clip: Clip, tau: number): number | null {
  const speed = clip.speed || 1
  const t = clip.start + (tau - (clip.inPoint || 0)) / speed
  return t >= clip.start - 1e-6 && t <= clip.start + clip.duration + 1e-6 ? t : null
}

const nearest = (xs: number[], t: number) => {
  let best = Infinity
  for (const x of xs) best = Math.min(best, Math.abs(x - t))
  return best
}

const words = (s?: string) => (s ?? '').split(/\s+/).filter(Boolean).length

/** the time a caption needs on screen (CHECK_LIMITS) */
export function readingTime(text: string, sub?: string): number {
  const L = CHECK_LIMITS
  const n = words(text) + words(sub)
  const base = n <= L.readShortWords ? L.readShort : Math.max(L.readPhrase, L.readPerWord * n)
  return base + (sub ? L.readSub : 0)
}

// ---------------------------------------------------------------- colour

function parseColor(css: string): [number, number, number] | null {
  const g = document.createElement('canvas').getContext('2d')!
  g.fillStyle = '#010203'
  g.fillStyle = css
  const v = String(g.fillStyle)
  if (v === '#010203' && css.trim().toLowerCase() !== '#010203') return null
  if (v.startsWith('#')) return [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number]
  const m = v.match(/\d+(\.\d+)?/g)
  return m ? [Number(m[0]), Number(m[1]), Number(m[2])] : null
}

const lin = (c: number) => { const x = c / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4 }
const luminance = (r: number, g: number, b: number) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

/**
 * WCAG contrast of text of colour `rgb` against the pixels of a box of the
 * frame, the background being every pixel that is clearly NOT the text colour.
 * Against the background pixel CLOSEST to the text in lightness (10th/90th
 * percentile, so a few stray pixels do not decide it) — the worst case a
 * reader meets.
 */
export function boxContrast(img: ImageData, box: [number, number, number, number], rgb: [number, number, number]): number | null {
  const [bx, by, bw, bh] = box.map((v) => Math.round(v))
  const lt = luminance(...rgb)
  const lum: number[] = []
  for (let y = Math.max(0, by); y < Math.min(img.height, by + bh); y++) {
    for (let x = Math.max(0, bx); x < Math.min(img.width, bx + bw); x++) {
      const i = (y * img.width + x) * 4
      const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2]
      if (Math.abs(r - rgb[0]) + Math.abs(g - rgb[1]) + Math.abs(b - rgb[2]) < 90) continue // the text itself
      lum.push(luminance(r, g, b))
    }
  }
  if (lum.length < 50) return null
  lum.sort((a, b) => a - b)
  const p = (q: number) => lum[Math.min(lum.length - 1, Math.floor(q * (lum.length - 1)))]
  const bg = lt >= p(0.5) ? p(0.9) : p(0.1)
  return ratio(lt, bg)
}

/** composition px box of a fragment → project px, through the clip's transform at `rel` s */
function projectBox(clip: Clip, project: Project, box: [number, number, number, number], rel: number): [number, number, number, number] {
  const fw = clip.fragmentMeta?.width ?? project.width
  const fh = clip.fragmentMeta?.height ?? project.height
  const fit = Math.min(project.width / fw, project.height / fh)
  const s = evalAnim(clip.transform.scale, rel) * fit
  const cx = project.width / 2 + evalAnim(clip.transform.x, rel)
  const cy = project.height / 2 + evalAnim(clip.transform.y, rel)
  return [cx + (box[0] - fw / 2) * s, cy + (box[1] - fh / 2) * s, box[2] * s, box[3] * s]
}

// ---------------------------------------------------------------- camera

type V3 = [number, number, number]
const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len3 = (a: V3) => Math.hypot(a[0], a[1], a[2])
const angle = (a: V3, b: V3) => {
  const la = len3(a), lb = len3(b)
  if (!la || !lb) return 0
  const c = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (la * lb)
  return (Math.acos(Math.max(-1, Math.min(1, c))) * 180) / Math.PI
}

export type JerkReason = 'speedStep' | 'turnStep' | 'jump' | 'shake'

/**
 * Stretches (composition seconds) where the camera does what a viewer sees as
 * a defect: a move that starts or stops DEAD (a step in speed or turn rate, see
 * cameraStep), a jump of its position (a cut inside what should be one shot),
 * or shaking (its acceleration flipping back and forth). A deliberate fast
 * move, eased in and out, is none of these.
 */
export function cameraJerks(samples: [number, V3, V3, number | null][]): { from: number; to: number; reason: JerkReason; amount: number }[] {
  const L = CHECK_LIMITS
  if (samples.length < 6) return []
  const dt = samples[1][0] - samples[0][0] || 1 / 30
  const v: number[] = [] // travel speed, units/s, step i → i+1
  const w: number[] = [] // turn rate of the view direction, °/s
  for (let i = 0; i + 1 < samples.length; i++) {
    const [, p0, t0] = samples[i], [, p1, t1] = samples[i + 1]
    v.push(len3(sub3(p1, p0)) / dt)
    w.push(angle(sub3(t0, p0), sub3(t1, p1)) / dt)
  }
  const R = Math.max(1, Math.round(0.5 / dt))
  const peak = (a: number[], i: number) => {
    let m = 0
    for (let k = Math.max(0, i - R); k <= Math.min(a.length - 1, i + R); k++) m = Math.max(m, a[k])
    return m
  }
  const median = (a: number[], i: number) => {
    const xs: number[] = []
    for (let k = Math.max(0, i - R); k <= Math.min(a.length - 1, i + R); k++) if (k !== i) xs.push(a[k])
    xs.sort((x, y) => x - y)
    return xs.length ? xs[xs.length >> 1] : 0
  }
  const bad: { t: number; reason: JerkReason; amount: number }[] = []
  for (let i = 0; i + 1 < v.length; i++) {
    const t = samples[i + 1][0]
    const pv = peak(v, i)
    if (pv > 1e-6 && Math.abs(v[i + 1] - v[i]) > L.cameraStep * pv) bad.push({ t, reason: 'speedStep', amount: Math.abs(v[i + 1] - v[i]) / pv })
    const pw = peak(w, i)
    if (pw > L.cameraTurnFloor && Math.abs(w[i + 1] - w[i]) > L.cameraStep * pw) bad.push({ t, reason: 'turnStep', amount: Math.abs(w[i + 1] - w[i]) / pw })
  }
  for (let i = 1; i + 1 < v.length; i++) {
    const m = median(v, i)
    if (v[i] > 6 * Math.max(m, 1e-6) && v[i] > 3 * Math.max(v[i - 1], v[i + 1])) bad.push({ t: samples[i][0], reason: 'jump', amount: v[i] / Math.max(m, 1e-6) })
  }
  // shaking: the travel's acceleration changing sign again and again
  for (let i = 0; i + R < v.length; i += Math.max(1, R >> 1)) {
    const pv = peak(v, i + (R >> 1))
    let flips = 0, last = 0
    for (let k = i; k + 1 < i + R; k++) {
      const d = v[k + 1] - v[k]
      if (Math.abs(d) < 0.05 * pv) continue
      const sgn = Math.sign(d)
      if (last && sgn !== last) flips++
      last = sgn
    }
    if (pv > 1e-6 && flips >= L.cameraShakeFlips) bad.push({ t: samples[i][0], reason: 'shake', amount: flips })
  }
  // a jump or shaking already explains the speed steps inside it: one report
  const covering = bad.filter((b) => b.reason === 'jump' || b.reason === 'shake')
  const shakeSpan = R * dt
  const explained = (b: { t: number; reason: JerkReason }) =>
    (b.reason === 'speedStep' || b.reason === 'turnStep') && covering.some((c) =>
      c.reason === 'jump' ? Math.abs(c.t - b.t) <= 0.1 : b.t >= c.t - 0.1 && b.t <= c.t + shakeSpan + 0.25)
  const kept = bad.filter((b) => !explained(b))
  bad.length = 0
  bad.push(...kept)
  bad.sort((a, b) => a.t - b.t)
  const runs: { from: number; to: number; reason: JerkReason; amount: number }[] = []
  for (const b of bad) {
    const last = runs[runs.length - 1]
    if (last && last.reason === b.reason && b.t - last.to <= (b.reason === 'shake' ? shakeSpan : 3 * dt)) {
      last.to = b.t
      last.amount = Math.max(last.amount, b.amount)
    } else runs.push({ from: b.t, to: b.t, reason: b.reason, amount: b.amount })
  }
  return runs
}

// ---------------------------------------------------------------- the run

/**
 * Check the fragment clips (all visible ones, or `clipIds`). `pixels` adds the
 * checks that need rendered frames (caption contrast, seams between
 * fragments) — they go through the snapshot path and take ~1–5 s a frame.
 */
export async function runChecks(opts: { clipIds?: string[]; pixels?: boolean; collisions?: boolean } = {}): Promise<CheckResult> {
  const L = CHECK_LIMITS
  useChecksUi.setState({ running: true })
  try {
    const project = useEditor.getState().project
    const issues: CheckIssue[] = []
    const events: TimedEvent[] = []
    const checked = { clips: 0, events: 0, texts: 0, cameras: 0, seams: 0, contrast: 0, collisions: 0 }
    const want = (c: Clip) => !opts.clipIds?.length || opts.clipIds.includes(c.id)
    const clips: { clip: Clip; track: Track }[] = []
    for (const track of project.tracks) {
      if (track.kind !== 'video' || track.muted) continue
      for (const clip of track.clips) if (clip.kind === 'remotion' && clip.fragmentId && want(clip)) clips.push({ clip, track })
    }
    const inspects = new Map<string, FragmentInspect>()
    for (const { clip } of clips) {
      if (inspects.has(clip.fragmentId!)) continue
      try {
        inspects.set(clip.fragmentId!, await window.kadr.fragmentInspect(clip.fragmentId!))
      } catch (e) {
        inspects.set(clip.fragmentId!, { ok: false, error: String((e as Error)?.message ?? e) })
      }
    }
    const markers: TimelineMarker[] = project.markers ?? []
    const beats = markers.filter((m) => m.kind === 'beat').map((m) => m.time)
    const downs = markers.filter((m) => m.kind === 'beat' && m.beatInBar === 1 && (m.bar ?? 0) > 0).map((m) => m.time)
    const pauses = markers.filter((m) => m.kind === 'pause').map((m) => [m.time, m.end ?? m.time] as [number, number])
    const inPause = (t: number) => pauses.some(([a, b]) => t >= a && t < b)
    let warnedNoBeats = false
    const titles: { t0: number; t1: number; text: string; box?: [number, number, number, number]; clipId: string; fragmentId: string }[] = []
    const contrastJobs: { t: number; box: [number, number, number, number]; rgb: [number, number, number]; large: boolean; text: string; clipId: string; fragmentId: string }[] = []

    for (const { clip, track } of clips) {
      const fid = clip.fragmentId!
      const ins = inspects.get(fid)!
      checked.clips++
      if (!ins.ok) {
        issues.push({ kind: 'inspectError', level: 'warn', t: clip.start, clipId: clip.id, fragmentId: fid,
          message: `фрагмент ${fid} не прочитать для проверки: ${ins.error.split('\n')[0]}` })
        continue
      }
      const speed = clip.speed || 1

      // ---- events against the music --------------------------------------
      const evs = ins.events
        .map((e) => ({ ...e, tl: toTimeline(clip, e.t) }))
        .filter((e): e is typeof e & { tl: number } => e.tl !== null)
      if (evs.length && !beats.length && !warnedNoBeats) {
        warnedNoBeats = true
        issues.push({ kind: 'noBeats', level: 'info', t: 0,
          message: 'на таймлайне нет разметки музыки — события не с чем сверить (сначала «Биты» / kadr_beats)' })
      }
      for (const e of evs) {
        checked.events++
        events.push({ t: e.tl, kind: e.kind, label: e.label, clipId: clip.id, trackId: track.id })
        const name = e.label ? `«${e.label}»` : e.kind === 'big' ? 'крупное событие' : 'событие'
        if (beats.length) {
          const d = nearest(beats, e.tl) * 1000
          if (d > L.beatMs) {
            issues.push({ kind: 'offBeat', level: 'warn', t: e.tl, clipId: clip.id, fragmentId: fid,
              message: `${name} в ${fmt(e.tl)} мимо доли на ${Math.round(d)} мс` })
          }
        }
        if (e.kind === 'big' && downs.length) {
          const d = nearest(downs, e.tl) * 1000
          const dBeat = beats.length ? nearest(beats, e.tl) * 1000 : Infinity
          if (d > L.beatMs && dBeat <= L.beatMs) {
            issues.push({ kind: 'bigOffDownbeat', level: 'warn', t: e.tl, clipId: clip.id, fragmentId: fid,
              message: `${name} в ${fmt(e.tl)} на доле, но не на первой доле такта` })
          }
        }
        if (inPause(e.tl)) {
          issues.push({ kind: 'eventInPause', level: 'warn', t: e.tl, clipId: clip.id, fragmentId: fid,
            message: `${name} в ${fmt(e.tl)} попадает в паузу музыки — в паузе кадр должен стоять` })
        }
      }
      // downbeats inside a clip that declares events, with nothing on them
      if (evs.length && downs.length) {
        const empty = downs.filter((d) => d >= clip.start && d < clip.start + clip.duration && !inPause(d) &&
          evs.every((e) => Math.abs(e.tl - d) * 1000 > L.beatMs))
        const runs: number[][] = []
        for (const d of empty) {
          const last = runs[runs.length - 1]
          const prevIdx = last ? downs.indexOf(last[last.length - 1]) : -2
          if (last && downs.indexOf(d) === prevIdx + 1) last.push(d)
          else runs.push([d])
        }
        for (const r of runs) {
          issues.push({ kind: 'emptyDownbeats', level: 'info', t: r[0], end: r[r.length - 1], clipId: clip.id, fragmentId: fid,
            message: r.length === 1
              ? `первая доля такта в ${fmt(r[0])} без события`
              : `${r.length} первых долей подряд без события: ${fmt(r[0])}–${fmt(r[r.length - 1])}` })
        }
      }

      // ---- captions --------------------------------------------------------
      for (const x of ins.texts) {
        const t0 = toTimeline(clip, x.from), t1 = toTimeline(clip, x.to)
        if (t0 === null || t1 === null) continue
        checked.texts++
        const shown = t1 - t0
        const need = readingTime(x.text, x.sub)
        const quote = `«${x.text}${x.sub ? ' / ' + x.sub : ''}»`
        if (shown + 1e-3 < need) {
          issues.push({ kind: 'textShort', level: 'warn', t: t0, end: t1, clipId: clip.id, fragmentId: fid,
            message: `${quote} видна ${shown.toFixed(2)} с — на ${words(x.text) + words(x.sub)} слов нужно ≥ ${need.toFixed(1)} с` })
        }
        if (x.path.length > 1) {
          let fastest = 0
          for (let i = 1; i < x.path.length; i++) {
            const [ta, xa, ya] = x.path[i - 1], [tb, xb, yb] = x.path[i]
            if (tb > ta) fastest = Math.max(fastest, (Math.hypot(xb - xa, yb - ya) / (tb - ta)) * speed)
          }
          if (fastest > L.textMovePxPerSec) {
            issues.push({ kind: 'textMoving', level: 'warn', t: t0, end: t1, clipId: clip.id, fragmentId: fid,
              message: `${quote} движется по экрану (до ${Math.round(fastest)} px/с) — читаемый текст стоит на месте, к детали тянется только линия` })
          }
        }
        if ((x.role ?? 'title') === 'title') titles.push({ t0, t1, text: x.text, box: x.box, clipId: clip.id, fragmentId: fid })
        if (opts.pixels && x.box && x.color) {
          const rgb = parseColor(x.color)
          if (rgb) {
            const mid = (t0 + t1) / 2
            contrastJobs.push({ t: mid, box: projectBox(clip, project, x.box, mid - clip.start), rgb, large: (x.role ?? 'title') === 'title', text: x.text, clipId: clip.id, fragmentId: fid })
          }
        }
      }

      // ---- the camera -------------------------------------------------------
      if (ins.camera.length) {
        checked.cameras++
        for (const j of cameraJerks(ins.camera)) {
          const a = toTimeline(clip, j.from), b = toTimeline(clip, j.to)
          if (a === null) continue
          const what = {
            speedStep: `скорость меняется за один кадр на ${Math.round(j.amount * 100)}% — движение начинается или обрывается без разгона`,
            turnStep: `поворот меняется за один кадр на ${Math.round(j.amount * 100)}% — без разгона`,
            jump: 'камера скачком меняет положение — склейка внутри одного кадра',
            shake: 'камера дрожит (ускорение меняет знак снова и снова)'
          }[j.reason]
          issues.push({ kind: 'cameraJerk', level: 'warn', t: a, end: b ?? a, clipId: clip.id, fragmentId: fid,
            message: `рывок камеры ${fmt(a)}${b && b - a > 0.05 ? '–' + fmt(b) : ''}: ${what}` })
        }
      }
    }

    // ---- one main caption at a time; captions that cover each other ---------
    titles.sort((a, b) => a.t0 - b.t0)
    for (let i = 0; i < titles.length; i++) {
      for (let j = i + 1; j < titles.length && titles[j].t0 < titles[i].t1 - 1e-3; j++) {
        const a = titles[i], b = titles[j]
        issues.push({ kind: 'textConcurrent', level: 'warn', t: b.t0, end: Math.min(a.t1, b.t1), clipId: b.clipId, fragmentId: b.fragmentId,
          message: `две главные надписи одновременно: «${a.text}» и «${b.text}» (${fmt(b.t0)}–${fmt(Math.min(a.t1, b.t1))})` })
        if (a.box && b.box && a.clipId === b.clipId) {
          const [ax, ay, aw, ah] = a.box, [bx, by, bw, bh] = b.box
          if (ax < bx + bw && bx < ax + aw && ay < by + bh && by < ay + ah) {
            issues.push({ kind: 'textOverlap', level: 'warn', t: b.t0, clipId: b.clipId, fragmentId: b.fragmentId,
              message: `«${a.text}» и «${b.text}» перекрывают друг друга` })
          }
        }
      }
    }

    // ---- pixels: contrast and seams -----------------------------------------
    if (opts.pixels) {
      // seams: butt-joined fragment clips on one track
      const seams: { a: Clip; b: Clip; fa: string; fb: string; continuous: boolean }[] = []
      for (const track of project.tracks) {
        if (track.kind !== 'video' || track.muted) continue
        const cs = track.clips.filter((c) => c.kind === 'remotion' && c.fragmentId).sort((x, y) => x.start - y.start)
        for (let i = 0; i + 1 < cs.length; i++) {
          const a = cs[i], b = cs[i + 1]
          if (Math.abs(a.start + a.duration - b.start) > 1 / project.fps + 1e-6) continue
          if (!want(a) && !want(b)) continue
          const ia = inspects.get(a.fragmentId!), ib = inspects.get(b.fragmentId!)
          seams.push({ a, b, fa: a.fragmentId!, fb: b.fragmentId!, continuous: !!((ia?.ok && ia.continuous) || (ib?.ok && ib.continuous)) })
        }
      }
      const times: number[] = []
      for (const s of seams) times.push(s.b.start - 1 / project.fps, s.b.start)
      for (const c of contrastJobs) times.push(c.t)
      const imgs = times.length ? await framePixels(times) : []
      seams.forEach((s, i) => {
        checked.seams++
        const A = imgs[2 * i].data, B = imgs[2 * i + 1].data
        let sum = 0
        for (let k = 0; k < A.length; k += 4) sum += Math.abs(A[k] - B[k]) + Math.abs(A[k + 1] - B[k + 1]) + Math.abs(A[k + 2] - B[k + 2])
        const delta = sum / ((A.length / 4) * 3) / 255
        const seen = delta > L.seam
        if (seen && s.continuous) {
          issues.push({ kind: 'seam', level: 'warn', t: s.b.start, clipId: s.b.id, fragmentId: s.fb,
            message: `стык ${s.fa} → ${s.fb} в ${fmt(s.b.start)} виден: средняя разница ${(delta * 255).toFixed(1)}/255 (окна одного фильма должны совпадать, ≤ ${(L.seam * 255).toFixed(0)}/255)` })
        } else {
          issues.push({ kind: 'seam', level: 'info', t: s.b.start, clipId: s.b.id, fragmentId: s.fb,
            message: `стык ${s.fa} → ${s.fb} в ${fmt(s.b.start)}: разница ${(delta * 255).toFixed(1)}/255 — ${seen ? 'монтажная склейка' : 'бесшовно'}` })
        }
      })
      const off = 2 * seams.length
      contrastJobs.forEach((c, i) => {
        checked.contrast++
        const r = boxContrast(imgs[off + i], c.box, c.rgb)
        const need = c.large ? L.contrastLarge : L.contrastText
        if (r !== null && r < need) {
          issues.push({ kind: 'contrast', level: 'warn', t: c.t, clipId: c.clipId, fragmentId: c.fragmentId,
            message: `«${c.text}» в ${fmt(c.t)}: контраст с фоном ${r.toFixed(1)}:1, нужно ≥ ${need}:1` })
        }
      })
    }

    // ---- parts passing through each other (3D kit parts; renders every frame) ----
    if (opts.collisions) {
      const done = new Set<string>()
      for (const { clip } of clips) {
        const fid = clip.fragmentId!
        if (done.has(fid)) continue
        done.add(fid)
        const r = await window.kadr.fragmentCollide(fid).catch((e) => ({ ok: false as const, error: String((e as Error)?.message ?? e) }))
        if (!r.ok) {
          issues.push({ kind: 'inspectError', level: 'warn', t: clip.start, clipId: clip.id, fragmentId: fid, message: `пересечения в ${fid} не проверить: ${r.error.split('\n')[0]}` })
          continue
        }
        checked.collisions++
        for (const p of r.pairs) {
          if (!p.hitFrames.length) continue
          const tau = (f: number) => f / r.fps
          // touching on (nearly) every frame both were there = an assembly in contact
          if (p.hitFrames.length >= 0.9 * p.sampled) {
            issues.push({ kind: 'contact', level: 'info', t: clip.start, clipId: clip.id, fragmentId: fid,
              message: `${p.pair}: касаются всё время — сборка в контакте (не движение сквозь)` })
            continue
          }
          const runs: [number, number][] = []
          for (const f of p.hitFrames) {
            const last = runs[runs.length - 1]
            if (last && f - last[1] <= r.step * 1.5) last[1] = f
            else runs.push([f, f])
          }
          for (const [f0, f1] of runs) {
            const a = toTimeline(clip, tau(f0)), b = toTimeline(clip, tau(f1))
            if (a === null) continue
            issues.push({ kind: 'collision', level: 'warn', t: a, end: b ?? a, clipId: clip.id, fragmentId: fid,
              message: `${p.pair} проходят друг сквозь друга ${fmt(a)}${b && b - a > 0.05 ? '–' + fmt(b) : ''}` })
          }
        }
      }
    }

    issues.sort((a, b) => a.t - b.t)
    const result = { issues, events: events.sort((a, b) => a.t - b.t), checked }
    useChecksUi.setState({ result })
    const warns = issues.filter((i) => i.level === 'warn').length
    logInfo('проверка', `${checked.clips} клипов, ${checked.events} событий, ${checked.texts} надписей: ${warns} замечаний`)
    return result
  } finally {
    useChecksUi.setState({ running: false })
  }
}
