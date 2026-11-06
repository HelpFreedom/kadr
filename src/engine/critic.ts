// Renderer side of the critic (rules in shared/critic.ts, ledger in
// electron/critic.ts, the agent in electron/agents/kadr-critic.md).
//
// The page chooses WHICH frames the critic sees. If the author picked them,
// the author would show the frames it is proud of; Kadr picks them from the
// structure instead — both sides of every cut, the middle of every transition,
// every declared caption once it has settled, every big event as it lands,
// the first seconds, the last frame — and fills long stretches evenly.
// It also lines declared events up against the sound clips under them, so
// "the click lands after the button" is a number and not an impression.
//
// The dialog's list of reviews comes from main (critic:list / critic:changed);
// the page never writes to the ledger.
import { create } from 'zustand'
import type { Clip, FragmentInspect } from '@shared/types'
import type { CriticChain } from '@shared/critic'
import { useEditor, projectDuration } from '@/state/store'
import { toTimeline } from './checks'
import { loadSoundLibrary } from './sounds'

/** frames a review round's plan holds at most (the ledger allows 60 per round) */
export const PLAN_FRAMES = 36
/** a stretch longer than this without a chosen frame gets evenly spaced ones */
const FILL_GAP = 3
/** sounds this far from an event are not "its" sound */
const SYNC_WINDOW = 0.5

export interface PlanFrame { t: number; why: string }
export interface CriticPlan {
  frames: PlanFrame[]
  /** fragment clips in the range — for kadr_check */
  clipIds: string[]
  sound: {
    events: { t: number; kind: 'big' | 'small'; label?: string; sound: { name: string; t: number; deltaMs: number } | null }[]
    sounds: { t: number; name: string; hitKnown: boolean }[]
  }
}

export function criticContext() {
  const s = useEditor.getState()
  return {
    projectPath: s.projectPath,
    projectName: s.project.name,
    duration: projectDuration(s.project),
    fps: s.project.fps
  }
}

const fmt = (t: number) => {
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`
}

/** the frames a round renders, and what the critic needs alongside them */
export async function criticPlan(opts: {
  from: number
  to: number
  mode: 'review' | 'verify'
  prior?: { id: string; t: number; end?: number; what?: string }[]
}): Promise<CriticPlan> {
  const project = useEditor.getState().project
  const f1 = 1 / (project.fps || 30)
  const dur = projectDuration(project)
  const from = Math.max(0, opts.from)
  // the last frame that exists: a range past the end shows black, not the film
  const last = Math.max(from, Math.min(opts.to, dur) - f1)
  const inRange = (t: number) => t >= Math.max(0, from - 1.5 * f1) && t <= last + 1e-6

  type Cand = PlanFrame & { pri: number }
  const cands: Cand[] = []
  const add = (t: number, why: string, pri: number) => { if (inRange(t)) cands.push({ t, why, pri }) }

  if (opts.mode === 'verify') {
    for (const d of opts.prior ?? []) {
      const what = d.what ? `: ${d.what.slice(0, 80)}` : ''
      cands.push({ t: Math.max(0, d.t), why: `${d.id}${what}`, pri: 0 })
      if (d.end != null && d.end - d.t > 4 * f1) {
        cands.push({ t: (d.t + d.end) / 2, why: `${d.id}, середина`, pri: 0 })
        cands.push({ t: Math.max(d.t, d.end - f1), why: `${d.id}, конец`, pri: 0 })
      }
    }
  } else {
    // 0 — the edges: where the stretch meets what is before it, the hook, the poster
    if (from > 0) add(from - f1, 'кадр перед участком (стык)', 0)
    add(from, 'первый кадр участка', 0)
    if (from < 0.05) for (const t of [0.5, 1, 2]) add(t, 'первые секунды (крючок)', 0)
    add(last, 'последний кадр участка (постер)', 0)

    // 1 — cuts from both sides, transitions at their middle
    for (const track of project.tracks) {
      if (track.kind !== 'video' || track.muted) continue
      const clips = [...track.clips].sort((a, b) => a.start - b.start)
      for (const [i, c] of clips.entries()) {
        const end = c.start + c.duration
        for (const b of [c.start, end]) {
          if (b <= from + f1 || b >= last) continue
          add(b - f1, `перед склейкой ${fmt(b)}`, 1)
          add(b, `после склейки ${fmt(b)}`, 1)
        }
        const next = clips[i + 1]
        if (next && next.start < end - f1) add((next.start + end) / 2, 'середина перехода', 1)
        if (c.transitionIn?.duration) add(c.start + c.transitionIn.duration / 2, 'середина появления', 1)
        if (c.transitionOut?.duration) add(end - c.transitionOut.duration / 2, 'середина ухода', 1)
      }
    }
  }

  // fragments in the range: their declared captions and events
  const frags: Clip[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.muted) continue
    for (const c of track.clips) {
      if (c.kind === 'remotion' && c.fragmentId && c.start < last + f1 && c.start + c.duration > from) frags.push(c)
    }
  }
  const inspects = new Map<string, FragmentInspect>()
  const events: CriticPlan['sound']['events'] = []
  for (const c of frags) {
    const fid = c.fragmentId!
    if (!inspects.has(fid)) {
      try { inspects.set(fid, await window.kadr.fragmentInspect(fid)) } catch (e) {
        inspects.set(fid, { ok: false, error: String((e as Error)?.message ?? e) })
      }
    }
    const ins = inspects.get(fid)!
    if (!ins.ok) continue
    for (const e of ins.events) {
      const t = toTimeline(c, e.t)
      if (t === null || !inRange(t)) continue
      events.push({ t, kind: e.kind, label: e.label, sound: null })
      if (opts.mode === 'review' && e.kind === 'big') add(t + 0.1, `событие${e.label ? ` «${e.label}»` : ''}`, 2)
    }
    if (opts.mode !== 'review') continue
    for (const tx of ins.texts) {
      const a = toTimeline(c, tx.from)
      const b = toTimeline(c, tx.to)
      if (a === null || b === null) continue
      add((a + b) / 2, `надпись «${tx.text.slice(0, 40)}»`, 2)
    }
  }

  if (opts.mode === 'review') {
    // 3 — every clip once, settled
    for (const track of project.tracks) {
      if (track.kind !== 'video' || track.muted) continue
      for (const c of track.clips) {
        const a = Math.max(c.start, from)
        const b = Math.min(c.start + c.duration, last)
        if (b - a >= 1.5) add((a + b) / 2, 'середина клипа', 3)
      }
    }
  }

  // highest priority first; a frame that IS a chosen one (under half a frame
  // apart) adds its reason there — not a neighbour: both sides of a cut are
  // exactly one frame apart, and they are the point of looking at a cut
  cands.sort((a, b) => a.pri - b.pri || a.t - b.t)
  const chosen: Cand[] = []
  for (const c of cands) {
    const near = chosen.find((x) => Math.abs(x.t - c.t) < 0.5 * f1)
    if (near) {
      if (!near.why.includes(c.why) && near.why.split('; ').length < 2) near.why += `; ${c.why}`
      continue
    }
    if (chosen.length >= PLAN_FRAMES) continue
    chosen.push({ ...c })
  }
  if (opts.mode === 'review') {
    // 4 — long stretches nobody chose a frame in
    const ts = [from, ...chosen.map((c) => c.t), last].sort((a, b) => a - b)
    for (let i = 1; i < ts.length && chosen.length < PLAN_FRAMES; i++) {
      const gap = ts[i] - ts[i - 1]
      if (gap <= FILL_GAP) continue
      const n = Math.ceil(gap / FILL_GAP) - 1
      for (let k = 1; k <= n && chosen.length < PLAN_FRAMES; k++) {
        chosen.push({ t: ts[i - 1] + (gap * k) / (n + 1), why: 'равномерно', pri: 4 })
      }
    }
  }
  chosen.sort((a, b) => a.t - b.t)

  // the sound under the stretch: short clips (effects), each at its HIT when the library knows it
  const sounds: CriticPlan['sound']['sounds'] = []
  let hits = new Map<string, number>()
  try { hits = new Map((await loadSoundLibrary()).sfx.map((s) => [s.path, s.hit])) } catch { /* starts only */ }
  for (const track of project.tracks) {
    if (track.kind !== 'audio' || track.muted) continue
    for (const c of track.clips) {
      if (c.muted || !c.assetId) continue
      const asset = project.assets.find((a) => a.id === c.assetId)
      if (!asset) continue
      const hit = hits.get(asset.path)
      if (hit === undefined && asset.duration > 3) continue // a music bed or a voice, not an effect
      const t = c.start + ((hit ?? 0) - (c.inPoint || 0)) / (c.speed || 1)
      if (t < from - SYNC_WINDOW || t > last + SYNC_WINDOW) continue
      sounds.push({ t, name: asset.name, hitKnown: hit !== undefined })
    }
  }
  sounds.sort((a, b) => a.t - b.t)
  for (const e of events) {
    let best: (typeof sounds)[number] | null = null
    for (const s of sounds) if (!best || Math.abs(s.t - e.t) < Math.abs(best.t - e.t)) best = s
    if (best && Math.abs(best.t - e.t) <= SYNC_WINDOW) {
      e.sound = { name: best.name, t: best.t, deltaMs: Math.round((best.t - e.t) * 1000) }
    }
  }
  events.sort((a, b) => a.t - b.t)

  return {
    frames: chosen.map(({ t, why }) => ({ t: +t.toFixed(4), why })),
    clipIds: frags.map((c) => c.id),
    sound: { events: events.slice(0, 40), sounds: sounds.slice(0, 40) }
  }
}

// ------------------------------------------------------------- the dialog

export const useCriticUi = create<{ turn: number; chains: CriticChain[] }>(() => ({ turn: 0, chains: [] }))

let wired = false
/** follow main's ledger; called once at startup */
export function initCriticUi() {
  if (wired || !window.kadr?.criticList) return
  wired = true
  window.kadr.onCriticChanged((v) => useCriticUi.setState({ turn: v.turn, chains: v.chains }))
  void window.kadr.criticList().then((v) => useCriticUi.setState({ turn: v.turn, chains: v.chains })).catch(() => {})
}
