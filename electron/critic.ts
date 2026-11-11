// The critic's ledger in main (rules in shared/critic.ts). It lives HERE, not
// in the page: the page is scriptable through kadr_eval and reloads, and a
// limit that a reload or one line of JS resets is not a limit. Main also owns
// the session, so a new Claude session starts a clean ledger turn.
//
// Reached three ways: the MCP bridge's kadr_review_* tools (POST /critic on
// the session bridge, token-locked like /eval), the UserPromptSubmit hook
// (POST /turn, electron/claude-hook.cjs), and the «Проверка» dialog
// (critic:list / critic:changed) — which only ever reads.
import { ipcMain, type BrowserWindow } from 'electron'
import { promises as fs } from 'fs'
import { basename, dirname, join } from 'path'
import {
  newLedger, newSession, newTurn, isUserPrompt, beginReview, reserveFrames, submitReview,
  reportMarkdown, reportName, type CriticChain, type SubmitInput
} from '@shared/critic'

const ledger = newLedger()
let getWin: () => BrowserWindow | null = () => null

/** chains kept for the dialog; the oldest closed ones go first */
const KEEP = 200

export interface CriticView {
  turn: number
  roundsThisTurn: number
  chains: CriticChain[]
}

const view = (): CriticView => ({ turn: ledger.turn, roundsThisTurn: ledger.roundsThisTurn, chains: ledger.chains })

function changed() {
  while (ledger.chains.length > KEEP) {
    const i = ledger.chains.findIndex((c) => c.state === 'closed')
    if (i < 0) break
    ledger.chains.splice(i, 1)
  }
  const win = getWin()
  if (win && !win.isDestroyed()) win.webContents.send('critic:changed', view())
}

/** a review's folder: next to the saved project; an unsaved one keeps no files */
const reviewDir = (c: CriticChain) => (c.projectPath ? join(dirname(c.projectPath), 'kadr-reviews') : null)

async function writeReport(c: CriticChain): Promise<string | null> {
  const dir = reviewDir(c)
  if (!dir) return null
  await fs.mkdir(dir, { recursive: true })
  const path = c.report ?? join(dir, reportName(c))
  const md = reportMarkdown(c, (p) => (dirname(p) === dir ? basename(p) : p))
  const part = `${path}.part`
  await fs.writeFile(part, md)
  await fs.rename(part, path)
  return path
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number.NaN)
const active = (c: CriticChain) => c.state === 'reviewing' || c.state === 'verifying'
const current = (c: CriticChain) => c.rounds[c.rounds.length - 1]

/** what a tool needs to know about a review */
function brief(c: CriticChain) {
  const r = current(c)
  return {
    id: c.id, from: c.from, to: c.to, state: c.state, round: r.round, mode: r.mode,
    dir: reviewDir(c), plan: c.plan,
    prior: r.mode === 'verify' ? c.defects.map(({ id, t, end, severity, what, fix }) => ({ id, t, end, severity, what, fix })) : undefined
  }
}

/** POST /critic from the MCP bridge: { op, … } → JSON-able result */
export async function criticOp(body: Record<string, unknown>): Promise<unknown> {
  const id = String(body.id ?? '')
  const chain = () => ledger.chains.find((c) => c.id === id)
  switch (body.op) {
    case 'begin': {
      const r = beginReview(ledger, {
        from: num(body.from), to: num(body.to),
        projectPath: typeof body.projectPath === 'string' && body.projectPath ? body.projectPath : null,
        projectName: String(body.projectName ?? ''),
        now: Date.now()
      })
      changed()
      return r.ok ? { ok: true, restarted: r.restarted, ...brief(r.chain) } : r
    }
    case 'plan': {
      const c = chain()
      if (!c || !active(c)) return { ok: false, message: `no running review ${id}` }
      const plan = Array.isArray(body.plan) ? body.plan : []
      c.plan = plan
        .filter((p): p is [number, string] => Array.isArray(p) && Number.isFinite(p[0]))
        .map(([t, why]) => [t, String(why ?? '')])
      return { ok: true }
    }
    case 'get': {
      const c = chain()
      return c ? { ok: true, ...brief(c) } : { ok: false, message: `no review ${id}` }
    }
    case 'reserve':
      return reserveFrames(ledger, id, num(body.n))
    case 'sheets': {
      const c = chain()
      if (!c || !active(c)) return { ok: false, message: `no running review ${id}` }
      const paths = Array.isArray(body.paths) ? body.paths.map(String) : []
      current(c).sheets.push(...paths)
      changed()
      return { ok: true }
    }
    case 'submit': {
      const r = submitReview(ledger, id, (body.input ?? {}) as SubmitInput, Date.now())
      if (!r.ok) return r
      let report: string | null = null
      let reportError: string | undefined
      try {
        report = await writeReport(r.chain)
        r.chain.report = report
      } catch (err) {
        reportError = String((err as Error)?.message ?? err)
      }
      changed()
      return {
        ok: true, state: r.chain.state, verdict: r.chain.verdict, defects: r.chain.defects,
        report, reportError, next: r.next
      }
    }
    default:
      return { ok: false, message: `unknown op ${String(body.op)}` }
  }
}

/** POST /turn from the UserPromptSubmit hook: only the user's own prompts open a turn */
export function criticTurn(body: Record<string, unknown>): { turn: number; counted: boolean } {
  const counted = isUserPrompt(String(body.head ?? ''), String(body.tail ?? body.head ?? ''))
  if (counted) {
    newTurn(ledger)
    changed()
  }
  return { turn: ledger.turn, counted }
}

/** a Claude session started: rounds of the previous one can no longer finish */
export function criticNewSession(): void {
  newSession(ledger)
  changed()
}

export function registerCriticIpc(win: () => BrowserWindow | null): void {
  getWin = win
  ipcMain.handle('critic:list', () => view())
}
