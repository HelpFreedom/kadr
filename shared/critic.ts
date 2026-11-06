// The critic: a subagent of the embedded Claude session that judges a stretch
// of the timeline from rendered frames alone (electron/agents/kadr-critic.md).
// This file is its LEDGER — pure state and rules, no IO — so the one thing that
// must never go wrong, the bound on how often it runs, is testable in node
// (scripts/check-critic.mjs).
//
// Why a bound in code and not only in the prompt: an author that repairs what a
// critic found and asks again is a loop with no natural end — every look finds
// something, and polishing converges on nothing. The rule here is the one the
// user chose: per stretch of timeline, ONE review (at most three defects) and
// ONE verification of exactly those defects; after that the tools refuse that
// stretch until the user writes again. A user message is the only thing that
// opens a new turn, and Kadr hears it from a UserPromptSubmit hook — which also
// fires for machine-made prompts (a background subagent finishing arrives as a
// `<task-notification>` prompt), so `isUserPrompt` tells them apart. Were those
// counted, every critic that finished would reset its own limit.
//
// Times are TIMELINE seconds throughout, as the contact sheets label them.

export const CRITIC_LIMITS = {
  /** defects one review may report — the worst ones; repairing more at once only spreads the effort */
  maxDefects: 3,
  /** review rounds (attempts included) per user turn, whatever the ranges — a cap on cost */
  roundsPerTurn: 12,
  /** a round whose critic died before submitting may be started once more */
  attemptsPerRound: 2,
  /** two ranges overlapping by more than this (s) are the same stretch */
  overlapSec: 0.5,
  /** frames one round may render */
  framesPerRound: 60,
  /** a defect may sit this far outside its range (the frame before the range's first cut) */
  edgeSlack: 1,
  /** longest text kept per defect field / per note */
  textMax: 600,
  noteMax: 1200
} as const

export type CriticSeverity = 'high' | 'medium'
export type CriticVerify = 'fixed' | 'not-fixed' | 'unclear'

export interface CriticDefect {
  /** d1, d2, d3 — stable within its chain */
  id: string
  t: number
  end?: number
  severity: CriticSeverity
  what: string
  evidence: string
  fix: string
  status: 'open' | CriticVerify
  verifyNote?: string
}

export interface CriticRound {
  round: 1 | 2
  mode: 'review' | 'verify'
  begunAt: number
  attempts: number
  submittedAt?: number
  note?: string
  /** contact sheets rendered for this round (absolute paths) */
  sheets: string[]
  frames: number
}

export type CriticChainState = 'reviewing' | 'awaiting-verify' | 'verifying' | 'closed'

/** one stretch of timeline: its review and its verification */
export interface CriticChain {
  id: string
  from: number
  to: number
  /** the user turn it was opened in */
  turn: number
  projectPath: string | null
  projectName: string
  state: CriticChainState
  /** ok = nothing worth repairing; verified = both rounds done; user = the user
      wrote before the verification; abandoned = the session ended mid-round */
  closedBy?: 'ok' | 'verified' | 'user' | 'abandoned'
  verdict?: 'ok' | 'fix'
  rounds: CriticRound[]
  defects: CriticDefect[]
  /** the frames the editor chose for the current round: [t, why] */
  plan: [number, string][]
  /** the markdown report, once written */
  report?: string | null
  createdAt: number
}

export interface CriticLedger {
  turn: number
  roundsThisTurn: number
  seq: number
  chains: CriticChain[]
}

export const newLedger = (): CriticLedger => ({ turn: 1, roundsThisTurn: 0, seq: 0, chains: [] })

export const fmtTime = (t: number): string => {
  const m = Math.floor(t / 60)
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`
}
const span = (c: { from: number; to: number }) => `${fmtTime(c.from)}–${fmtTime(c.to)}`

/** two ranges are the same stretch when they share more than overlapSec — or,
    for ranges shorter than that, more than half of the shorter one */
export function overlaps(a: { from: number; to: number }, from: number, to: number): boolean {
  const shared = Math.min(a.to, to) - Math.max(a.from, from)
  const need = Math.min(CRITIC_LIMITS.overlapSec, 0.5 * Math.min(a.to - a.from, to - from))
  return shared > need
}

/**
 * Whether a UserPromptSubmit came from the user. The hook fires for prompts
 * the CLI makes itself too — a background agent finishing is delivered as one
 * `<task-notification>…</task-notification>` element. Anything that is one
 * element from its first character to its last is taken as machine-made; a
 * person who pastes exactly one XML element and nothing else does not get a
 * new turn, which is the safe side to err on. `tail` is the end of the prompt
 * when only its two ends were sent (a prompt can be megabytes of paste).
 */
export function isUserPrompt(head: string, tail: string = head): boolean {
  const h = String(head ?? '').trimStart()
  const t = String(tail ?? '').trimEnd()
  const m = /^<([A-Za-z][\w-]*)[\s>]/.exec(h)
  return !(m && t.endsWith(`</${m[1]}>`))
}

/** a new message from the user: a fresh budget, and a pending verification lapses */
export function newTurn(L: CriticLedger): void {
  L.turn++
  L.roundsThisTurn = 0
  for (const c of L.chains) {
    if (c.state === 'awaiting-verify') { c.state = 'closed'; c.closedBy = 'user' }
  }
}

/** a new Claude session: nothing of the old one can submit any more */
export function newSession(L: CriticLedger): void {
  newTurn(L)
  for (const c of L.chains) {
    if (c.state !== 'closed') { c.state = 'closed'; c.closedBy = 'abandoned' }
  }
}

export type BeginResult =
  | { ok: true; chain: CriticChain; round: 1 | 2; mode: 'review' | 'verify'; restarted: boolean }
  | { ok: false; code: 'range' | 'turn-cap' | 'reviewed' | 'attempts' | 'spans'; message: string }

const STOP = 'Return this refusal to the main agent as it is and stop — do not try another range.'

export function beginReview(
  L: CriticLedger,
  req: { from: number; to: number; projectPath: string | null; projectName: string; now: number }
): BeginResult {
  const { from, to } = req
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to - from < 0.1) {
    return { ok: false, code: 'range', message: `not a range: from ${from}, to ${to} (seconds, from < to)` }
  }
  const capped = (): BeginResult => ({
    ok: false, code: 'turn-cap',
    message: `${CRITIC_LIMITS.roundsPerTurn} critic rounds already ran since the user's last message. ` +
      `No more until the user writes. ${STOP}`
  })
  const same = L.chains.filter((c) =>
    c.turn === L.turn && c.projectPath === req.projectPath && overlaps(c, from, to))
  if (same.length > 1) {
    return {
      ok: false, code: 'spans',
      message: `${fmtTime(from)}–${fmtTime(to)} covers stretches already reviewed in this turn: ` +
        same.map((c) => `${span(c)} (${c.state})`).join(', ') + `. ${STOP}`
    }
  }
  const c = same[0]
  if (!c) {
    if (L.roundsThisTurn >= CRITIC_LIMITS.roundsPerTurn) return capped()
    const chain: CriticChain = {
      id: `r${++L.seq}`, from, to, turn: L.turn,
      projectPath: req.projectPath, projectName: req.projectName,
      state: 'reviewing',
      rounds: [{ round: 1, mode: 'review', begunAt: req.now, attempts: 1, sheets: [], frames: 0 }],
      defects: [], plan: [], createdAt: req.now
    }
    L.chains.push(chain)
    L.roundsThisTurn++
    return { ok: true, chain, round: 1, mode: 'review', restarted: false }
  }
  if (c.state === 'awaiting-verify') {
    if (L.roundsThisTurn >= CRITIC_LIMITS.roundsPerTurn) return capped()
    c.state = 'verifying'
    c.plan = []
    c.rounds.push({ round: 2, mode: 'verify', begunAt: req.now, attempts: 1, sheets: [], frames: 0 })
    L.roundsThisTurn++
    return { ok: true, chain: c, round: 2, mode: 'verify', restarted: false }
  }
  if (c.state === 'reviewing' || c.state === 'verifying') {
    // the critic of this round never submitted (died, or a second one was sent)
    const r = c.rounds[c.rounds.length - 1]
    if (r.attempts >= CRITIC_LIMITS.attemptsPerRound) {
      return {
        ok: false, code: 'attempts',
        message: `round ${r.round} of ${span(c)} was started ${r.attempts} times without a result. ${STOP}`
      }
    }
    if (L.roundsThisTurn >= CRITIC_LIMITS.roundsPerTurn) return capped()
    r.attempts++
    r.frames = 0
    L.roundsThisTurn++
    return { ok: true, chain: c, round: r.round, mode: r.mode, restarted: true }
  }
  const how = c.closedBy === 'ok' ? 'found nothing worth repairing'
    : c.closedBy === 'verified' ? 'was reviewed and its repairs verified'
    : 'is closed'
  return {
    ok: false, code: 'reviewed',
    message: `${span(c)} ${how} in this turn — the critic's work on it is done until the user writes again. ${STOP}`
  }
}

/** frames a round may still render (0 = none) */
export function reserveFrames(L: CriticLedger, id: string, n: number): { ok: true; allowed: number } | { ok: false; message: string } {
  const c = L.chains.find((x) => x.id === id)
  if (!c) return { ok: false, message: `no review ${id}` }
  if (c.state !== 'reviewing' && c.state !== 'verifying') {
    return { ok: false, message: `review ${id} is ${c.state} — there is no round to render frames for` }
  }
  const r = c.rounds[c.rounds.length - 1]
  const allowed = Math.max(0, Math.min(Math.floor(n), CRITIC_LIMITS.framesPerRound - r.frames))
  r.frames += allowed
  return { ok: true, allowed }
}

export interface DefectInput {
  t: number
  end?: number
  severity: string
  what: string
  evidence: string
  fix: string
}
export interface SubmitInput {
  defects?: DefectInput[]
  verified?: { id: string; status: string; note?: string }[]
  note?: string
}
export type SubmitResult =
  | { ok: true; chain: CriticChain; next: string }
  | { ok: false; message: string }

const clip = (s: unknown, max: number) => {
  const v = String(s ?? '').trim()
  return v.length > max ? v.slice(0, max - 1) + '…' : v
}

export function submitReview(L: CriticLedger, id: string, input: SubmitInput, now: number): SubmitResult {
  const c = L.chains.find((x) => x.id === id)
  if (!c) return { ok: false, message: `no review ${id}` }
  const r = c.rounds[c.rounds.length - 1]
  const note = input.note ? clip(input.note, CRITIC_LIMITS.noteMax) : undefined
  const defects = input.defects ?? []
  const verified = input.verified ?? []

  if (c.state === 'reviewing') {
    if (verified.length) return { ok: false, message: 'this is a review round — report defects, not verifications' }
    if (defects.length > CRITIC_LIMITS.maxDefects) {
      return { ok: false, message: `at most ${CRITIC_LIMITS.maxDefects} defects — keep the worst ones` }
    }
    const lo = c.from - CRITIC_LIMITS.edgeSlack
    const hi = c.to + CRITIC_LIMITS.edgeSlack
    const out: CriticDefect[] = []
    for (const [i, d] of defects.entries()) {
      const n = i + 1
      if (!Number.isFinite(d?.t) || d.t < lo || d.t > hi) {
        return { ok: false, message: `defect ${n}: t must be a timeline second within ${span(c)}` }
      }
      if (d.end != null && (!Number.isFinite(d.end) || d.end < d.t || d.end > hi)) {
        return { ok: false, message: `defect ${n}: end must be ≥ t and within ${span(c)}` }
      }
      if (d.severity !== 'high' && d.severity !== 'medium') {
        return { ok: false, message: `defect ${n}: severity is "high" or "medium" (anything smaller is not reported)` }
      }
      const what = clip(d.what, CRITIC_LIMITS.textMax)
      const evidence = clip(d.evidence, CRITIC_LIMITS.textMax)
      const fix = clip(d.fix, CRITIC_LIMITS.textMax)
      if (!what || !evidence || !fix) return { ok: false, message: `defect ${n}: what, evidence and fix are all required` }
      out.push({ id: `d${n}`, t: d.t, ...(d.end != null ? { end: d.end } : {}), severity: d.severity, what, evidence, fix, status: 'open' })
    }
    c.defects = out
    c.verdict = out.length ? 'fix' : 'ok'
    r.submittedAt = now
    r.note = note
    if (!out.length) { c.state = 'closed'; c.closedBy = 'ok' }
    else if (c.turn !== L.turn) { c.state = 'closed'; c.closedBy = 'user' }
    else c.state = 'awaiting-verify'
    return { ok: true, chain: c, next: nextStep(c) }
  }

  if (c.state === 'verifying') {
    if (defects.length) {
      return { ok: false, message: 'a verification round reports no new defects — mention anything serious in `note`' }
    }
    const want = new Set(c.defects.map((d) => d.id))
    const seen = new Set<string>()
    for (const v of verified) {
      if (!want.has(v?.id)) return { ok: false, message: `unknown defect ${v?.id} — verify ${[...want].join(', ')}` }
      if (seen.has(v.id)) return { ok: false, message: `defect ${v.id} verified twice` }
      if (v.status !== 'fixed' && v.status !== 'not-fixed' && v.status !== 'unclear') {
        return { ok: false, message: `defect ${v.id}: status is "fixed", "not-fixed" or "unclear"` }
      }
      seen.add(v.id)
    }
    const missing = [...want].filter((x) => !seen.has(x))
    if (missing.length) return { ok: false, message: `verify every defect — missing ${missing.join(', ')}` }
    for (const v of verified) {
      const d = c.defects.find((x) => x.id === v.id)!
      d.status = v.status as CriticVerify
      const vn = v.note ? clip(v.note, CRITIC_LIMITS.textMax) : ''
      if (vn) d.verifyNote = vn
      else delete d.verifyNote
    }
    r.submittedAt = now
    r.note = note
    c.state = 'closed'
    c.closedBy = 'verified'
    return { ok: true, chain: c, next: nextStep(c) }
  }

  return { ok: false, message: `review ${id} is ${c.state}${c.closedBy ? ` (${c.closedBy})` : ''} — nothing awaits a submission` }
}

const list = (ds: CriticDefect[]) =>
  ds.map((d) => `${d.id} at ${fmtTime(d.t)} (${d.severity}): ${d.what}`).join('\n')

/** what the main agent does next — part of the critic's answer */
export function nextStep(c: CriticChain): string {
  const where = span(c)
  if (c.state === 'awaiting-verify') {
    return `NEXT (main agent): repair ONLY these ${c.defects.length} defect(s) of ${where}, each locally, ` +
      'as its fix says (or better). Leave everything else in the range alone. Then run kadr-critic ONCE more ' +
      'on the same range: it will verify exactly these defects and look for nothing new. That is the last ' +
      'round — whatever is still open after it goes to the user. If a defect contradicts what the user ' +
      'explicitly asked for, do not repair it; tell the user instead.\n' + list(c.defects)
  }
  if (c.closedBy === 'ok') {
    return `NEXT (main agent): nothing in ${where} is worth a repair. Show it to the user. ` +
      'No further critic rounds on this range until the user writes.'
  }
  if (c.closedBy === 'verified') {
    const fixed = c.defects.filter((d) => d.status === 'fixed')
    const open = c.defects.filter((d) => d.status !== 'fixed')
    return `NEXT (main agent): the critic's work on ${where} is done — no more rounds on it until the user ` +
      `writes. Tell the user what was repaired (${fixed.map((d) => d.id).join(', ') || 'nothing'}) and what is ` +
      `still open, with times, and let them decide:\n` + (open.length ? list(open) : 'nothing open')
  }
  return `NEXT (main agent): the user wrote while this review of ${where} ran — report its findings with your ` +
    'answer; whether to repair them is the user\'s call.\n' + list(c.defects)
}

const SEV: Record<CriticSeverity, string> = { high: 'серьёзно', medium: 'заметно' }
const STATUS: Record<CriticDefect['status'], string> = {
  open: 'не проверено', fixed: 'исправлено', 'not-fixed': 'не исправлено', unclear: 'неясно'
}
const CLOSED: Record<NonNullable<CriticChain['closedBy']>, string> = {
  ok: 'чинить нечего', verified: 'правки проверены', user: 'вы написали до проверки', abandoned: 'сессия закрылась'
}

/** status line of a chain, for the report and the «Проверка» dialog */
export function chainSummary(c: CriticChain): string {
  if (c.state === 'reviewing') return 'идёт ревью'
  if (c.state === 'verifying') return 'идёт проверка правок'
  if (c.state === 'awaiting-verify') return `дефектов: ${c.defects.length}, ждёт правок`
  const fixed = c.defects.filter((d) => d.status === 'fixed').length
  const base = CLOSED[c.closedBy ?? 'ok']
  return c.defects.length ? `${base}; исправлено ${fixed} из ${c.defects.length}` : base
}

const stamp = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** file name of a chain's report: sorts by time, says the range */
export function reportName(c: CriticChain): string {
  const s = stamp(c.createdAt).replace(/[: ]/g, (x) => (x === ' ' ? '_' : ''))
  const sec = (t: number) => t.toFixed(1).replace('.', ',')
  return `critic_${s}_${sec(c.from)}-${sec(c.to)}s.md`
}

/** the report, in the user's language; sheet links relative to the report's folder */
export function reportMarkdown(c: CriticChain, base: (p: string) => string): string {
  const out: string[] = []
  out.push(`# Критик: ${span(c)}`, '')
  out.push(`Проект: ${c.projectName || 'без имени'} · ${stamp(c.createdAt)} · ${chainSummary(c)}`, '')
  for (const r of c.rounds) {
    out.push(`## Круг ${r.round} — ${r.mode === 'review' ? 'ревью' : 'проверка правок'}`, '')
    if (!r.submittedAt) out.push('_Не завершён._', '')
    for (const s of r.sheets) out.push(`![контактный лист](${encodeURI(base(s))})`, '')
    if (r.mode === 'review' && r.submittedAt) {
      if (!c.defects.length) out.push('Дефектов, которые стоит чинить, нет.', '')
      for (const d of c.defects) {
        const when = d.end != null ? `${fmtTime(d.t)}–${fmtTime(d.end)}` : fmtTime(d.t)
        out.push(`### ${d.id} · ${SEV[d.severity]} · ${when}`, '')
        out.push(`**Что:** ${d.what}`, '', `**Видно:** ${d.evidence}`, '', `**Правка:** ${d.fix}`, '')
      }
    }
    if (r.mode === 'verify' && r.submittedAt) {
      for (const d of c.defects) {
        out.push(`- ${d.id} (${fmtTime(d.t)}): **${STATUS[d.status]}**${d.verifyNote ? ` — ${d.verifyNote}` : ''}`)
      }
      out.push('')
    }
    if (r.note) out.push(`Заметка критика: ${r.note}`, '')
  }
  return out.join('\n')
}
