// Node-side check of shared/critic.ts — the critic's ledger.
//
// What it guards: the critic must not become a loop. An author that repairs
// what a critic found and asks again never runs out of things to polish, so
// the bound lives in code: per stretch one review + one verification until the
// user writes, a cap per user turn, and only the USER's prompts open a turn —
// the CLI submits prompts of its own (a background agent finishing arrives as
// a <task-notification>), and counting those would let every critic that
// finished reset its own limit. That last trap was found by running the real
// CLI with the hook, not by reading docs.
// Run: node scripts/check-critic.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'critic.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const C = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { CRITIC_LIMITS: LIM } = C

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const P = '/tmp/film/film.kadr'
let clock = 1_800_000_000_000
const begin = (L, from, to, projectPath = P) => C.beginReview(L, { from, to, projectPath, projectName: 'film', now: ++clock })
const D = (t, extra = {}) => ({ t, severity: 'high', what: 'текст не читается', evidence: 'кадр 0:12.40, буквы 14 px', fix: 'поднять кегль до 48 px', ...extra })

// ---------------------------------------------------------------- whose prompt
{
  const note = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<result>ok</result>\n</task-notification>'
  check('a plain message is the user\'s', C.isUserPrompt('Сделай интро на 15 секунд'))
  check('a background agent finishing is NOT the user (task-notification)', !C.isUserPrompt(note))
  check('… also when only its two ends are sent', !C.isUserPrompt(note.slice(0, 20), note.slice(-20)))
  check('… and with whitespace around it', !C.isUserPrompt('\n  ' + note + '\n'))
  check('a slash command the user typed is the user\'s',
    C.isUserPrompt('<command-message>review</command-message>\n<command-name>/review</command-name>\n<command-args></command-args>'))
  check('a message that starts with a tag but goes on is the user\'s', C.isUserPrompt('<b>смотри</b> вот тут поправь'))
  check('a message that quotes a tag in the middle is the user\'s', C.isUserPrompt('почему <task-notification> пришёл дважды?'))
}

// ---------------------------------------------------------------- one review, one verification
{
  const L = C.newLedger()
  const a = begin(L, 10, 20)
  check('a fresh stretch opens a review round', a.ok && a.round === 1 && a.mode === 'review' && !a.restarted)
  const s1 = C.submitReview(L, a.chain.id, { defects: [D(12.4), D(15, { severity: 'medium', end: 16 })] }, ++clock)
  check('a review with defects awaits the repair', s1.ok && s1.chain.state === 'awaiting-verify' && s1.chain.verdict === 'fix')
  check('… defects get ids d1, d2 and status open', s1.ok && s1.chain.defects.map((d) => d.id + d.status).join() === 'd1open,d2open')
  check('… and NEXT says: repair only these, then ONE verification', s1.ok && /ONLY/.test(s1.next) && /ONCE more/.test(s1.next) && /last/.test(s1.next))

  const v = begin(L, 11, 19)
  check('the next call on the stretch is the verification, on the ORIGINAL range',
    v.ok && v.round === 2 && v.mode === 'verify' && v.chain.from === 10 && v.chain.to === 20)
  const bad1 = C.submitReview(L, a.chain.id, { defects: [D(13)] }, ++clock)
  check('a verification may not report new defects', !bad1.ok && /no new defects/.test(bad1.message))
  const bad2 = C.submitReview(L, a.chain.id, { verified: [{ id: 'd1', status: 'fixed' }] }, ++clock)
  check('a verification must cover every defect', !bad2.ok && /d2/.test(bad2.message))
  const bad3 = C.submitReview(L, a.chain.id, { verified: [{ id: 'd1', status: 'fixed' }, { id: 'd9', status: 'fixed' }] }, ++clock)
  check('… and only its own defects', !bad3.ok && /d9/.test(bad3.message))
  const s2 = C.submitReview(L, a.chain.id, {
    verified: [{ id: 'd1', status: 'fixed' }, { id: 'd2', status: 'not-fixed', note: 'всё ещё мелко' }]
  }, ++clock)
  check('the verification closes the stretch', s2.ok && s2.chain.state === 'closed' && s2.chain.closedBy === 'verified')
  check('… NEXT hands what is open to the user', s2.ok && /d2/.test(s2.next) && /until the user/.test(s2.next))
  check('… with the verdicts on the defects', s2.ok && s2.chain.defects[1].status === 'not-fixed' && s2.chain.defects[1].verifyNote === 'всё ещё мелко')

  const again = begin(L, 10, 20)
  check('a THIRD round on the stretch is refused', !again.ok && again.code === 'reviewed')
  check('… and the refusal says to stop, not to try another range', !again.ok && /do not try another range/.test(again.message))
  const inside = begin(L, 14, 16)
  check('… so is a sub-range of it', !inside.ok && inside.code === 'reviewed')
  const twice = C.submitReview(L, a.chain.id, { verified: [{ id: 'd1', status: 'fixed' }, { id: 'd2', status: 'fixed' }] }, ++clock)
  check('a closed review takes no second submission', !twice.ok)
}

// ---------------------------------------------------------------- nothing to repair
{
  const L = C.newLedger()
  const a = begin(L, 0, 8)
  const s = C.submitReview(L, a.chain.id, { defects: [] }, ++clock)
  check('a review with no defects closes at once', s.ok && s.chain.state === 'closed' && s.chain.closedBy === 'ok' && s.chain.verdict === 'ok')
  check('… and there is no verification round after it', !begin(L, 0, 8).ok)
}

// ---------------------------------------------------------------- the user writes
{
  const L = C.newLedger()
  const a = begin(L, 0, 10)
  C.submitReview(L, a.chain.id, { defects: [] }, ++clock)
  C.newTurn(L)
  const b = begin(L, 0, 10)
  check('after the user writes, the same stretch may be reviewed again', b.ok && b.round === 1 && b.chain.id !== a.chain.id)
  C.submitReview(L, b.chain.id, { defects: [D(3)] }, ++clock)
  C.newTurn(L)
  check('a pending verification lapses when the user writes', b.chain.state === 'closed' && b.chain.closedBy === 'user')
  const c = begin(L, 0, 10)
  check('… and the next call is a fresh review, not that verification', c.ok && c.mode === 'review' && c.chain.id !== b.chain.id)

  // a critic still running when the user wrote: its findings are kept, no repair round follows
  const L2 = C.newLedger()
  const r = begin(L2, 5, 9)
  C.newTurn(L2)
  const late = C.submitReview(L2, r.chain.id, { defects: [D(6)] }, ++clock)
  check('a late review is recorded but closed (the user spoke meanwhile)', late.ok && late.chain.state === 'closed' && late.chain.closedBy === 'user')
  check('… its NEXT leaves the repair to the user', late.ok && /user's call/.test(late.next))
}

// ---------------------------------------------------------------- a critic that died
{
  const L = C.newLedger()
  const a = begin(L, 30, 40)
  const b = begin(L, 30, 40)
  check('a round never submitted may be started once more', b.ok && b.restarted && b.chain.id === a.chain.id && b.round === 1)
  const c = begin(L, 30, 40)
  check('… but not a third time', !c.ok && c.code === 'attempts')
  C.newSession(L)
  check('a new Claude session abandons the open round', a.chain.state === 'closed' && a.chain.closedBy === 'abandoned')
  check('… and a submission for it is refused', !C.submitReview(L, a.chain.id, { defects: [] }, ++clock).ok)
}

// ---------------------------------------------------------------- which stretches are the same
{
  const L = C.newLedger()
  const a = begin(L, 0, 10)
  C.submitReview(L, a.chain.id, { defects: [] }, ++clock)
  check('a butt-joined neighbour is another stretch', begin(L, 10, 20).ok)
  const L2 = C.newLedger()
  C.submitReview(L2, begin(L2, 0, 10).chain.id, { defects: [] }, ++clock)
  check('a 0.4 s overlap is another stretch', begin(L2, 9.6, 20).ok)
  const L3 = C.newLedger()
  C.submitReview(L3, begin(L3, 0, 10).chain.id, { defects: [] }, ++clock)
  check('a 0.6 s overlap is the same stretch', !begin(L3, 9.4, 20).ok)
  const L4 = C.newLedger()
  C.submitReview(L4, begin(L4, 5, 5.4).chain.id, { defects: [] }, ++clock)
  check('a short stretch is matched by half its length', !begin(L4, 5.1, 5.5).ok && begin(L4, 5.35, 6).ok)
  const L5 = C.newLedger()
  C.submitReview(L5, begin(L5, 0, 10).chain.id, { defects: [] }, ++clock)
  C.submitReview(L5, begin(L5, 10, 20).chain.id, { defects: [] }, ++clock)
  const span = begin(L5, 0, 20)
  check('a range over two reviewed stretches is refused', !span.ok && span.code === 'spans')
  const L6 = C.newLedger()
  C.submitReview(L6, begin(L6, 0, 10).chain.id, { defects: [] }, ++clock)
  check('another project\'s timeline is another stretch', begin(L6, 0, 10, '/tmp/other/other.kadr').ok)
  check('not a range: reversed, negative, empty', !begin(C.newLedger(), 5, 4).ok && !begin(C.newLedger(), -1, 4).ok && !begin(C.newLedger(), 3, 3.05).ok)
}

// ---------------------------------------------------------------- the cap per turn
{
  const L = C.newLedger()
  let opened = 0
  for (let i = 0; i < LIM.roundsPerTurn + 5; i++) if (begin(L, i * 10, i * 10 + 8).ok) opened++
  check(`at most ${LIM.roundsPerTurn} rounds per user turn, whatever the ranges`, opened === LIM.roundsPerTurn)
  const capped = begin(L, 900, 910)
  check('… then a refusal that says to wait for the user', !capped.ok && capped.code === 'turn-cap' && /until the user writes/.test(capped.message))
  C.newTurn(L)
  check('… and the user\'s next message opens a new budget', begin(L, 900, 910).ok)
}

// ---------------------------------------------------------------- what a submission may say
{
  const L = C.newLedger()
  const a = begin(L, 10, 20)
  const id = a.chain.id
  check('more than three defects are refused', !C.submitReview(L, id, { defects: [D(11), D(12), D(13), D(14)] }, ++clock).ok)
  check('a defect far outside the range is refused', !C.submitReview(L, id, { defects: [D(25)] }, ++clock).ok)
  check('a "low" severity is not a defect', !C.submitReview(L, id, { defects: [D(12, { severity: 'low' })] }, ++clock).ok)
  check('what, evidence and fix are required', !C.submitReview(L, id, { defects: [D(12, { fix: '  ' })] }, ++clock).ok)
  check('end before t is refused', !C.submitReview(L, id, { defects: [D(12, { end: 11 })] }, ++clock).ok)
  check('a review round takes no verifications', !C.submitReview(L, id, { verified: [{ id: 'd1', status: 'fixed' }] }, ++clock).ok)
  check('… the round is still open after those refusals', a.chain.state === 'reviewing')
  const long = 'x'.repeat(5000)
  const ok = C.submitReview(L, id, { defects: [D(9.5, { what: long })], note: long }, ++clock)
  check('the frame before the range (within the slack) is accepted', ok.ok)
  check('long text is cut, not refused', ok.ok && ok.chain.defects[0].what.length === LIM.textMax && ok.chain.rounds[0].note.length === LIM.noteMax)
}

// ---------------------------------------------------------------- the frame budget
{
  const L = C.newLedger()
  const a = begin(L, 0, 30)
  const r1 = C.reserveFrames(L, a.chain.id, 36)
  const r2 = C.reserveFrames(L, a.chain.id, 36)
  const r3 = C.reserveFrames(L, a.chain.id, 5)
  check(`a round renders at most ${LIM.framesPerRound} frames`, r1.allowed === 36 && r2.allowed === LIM.framesPerRound - 36 && r3.allowed === 0)
  C.submitReview(L, a.chain.id, { defects: [] }, ++clock)
  check('a closed review renders nothing', !C.reserveFrames(L, a.chain.id, 1).ok)
}

// ---------------------------------------------------------------- it ends: an author that never stops asking
{
  // the worst author: after every answer it asks again — same range, a shifted
  // one, a sub-range, a neighbour — and the critic always finds three defects.
  // Within one turn the number of rounds must stay bounded, and every stretch
  // must get at most a review and a verification.
  let rnd = 7
  const rand = () => (rnd = (rnd * 1103515245 + 12345) % 2147483648) / 2147483648
  const L = C.newLedger()
  let rounds = 0
  for (let i = 0; i < 2000; i++) {
    const from = Math.floor(rand() * 50)
    const r = begin(L, from, from + 1 + rand() * 12)
    if (!r.ok) continue
    rounds++
    if (rand() < 0.15) continue // the critic died
    if (r.mode === 'review') C.submitReview(L, r.chain.id, { defects: [D(r.chain.from + 0.1), D(r.chain.from + 0.2), D(r.chain.from + 0.3)] }, ++clock)
    else C.submitReview(L, r.chain.id, { verified: r.chain.defects.map((d) => ({ id: d.id, status: 'not-fixed' })) }, ++clock)
  }
  check('2000 requests in one turn run at most the per-turn cap of rounds', rounds <= LIM.roundsPerTurn, `rounds=${rounds}`)
  const perChain = L.chains.map((c) => c.rounds.length)
  check('… and no stretch got more than a review and a verification', perChain.every((n) => n <= 2), perChain.join(','))
  const attempts = L.chains.flatMap((c) => c.rounds.map((r) => r.attempts))
  check(`… nor more than ${LIM.attemptsPerRound} attempts at a round`, attempts.every((n) => n <= LIM.attemptsPerRound))
  // and machine prompts in between change nothing
  const note = '<task-notification><result>ok</result></task-notification>'
  if (!C.isUserPrompt(note)) { /* the hook would not call newTurn */ }
  check('… machine-made prompts never open a turn', !C.isUserPrompt(note) && L.turn === 1)
}

// ---------------------------------------------------------------- the report
{
  const L = C.newLedger()
  const a = begin(L, 72.5, 90)
  a.chain.rounds[0].sheets.push('/tmp/film/kadr-reviews/film_sheet_1.png', '/elsewhere/x y.png')
  C.submitReview(L, a.chain.id, { defects: [D(75.25)], note: 'финал торопится' }, ++clock)
  const md = C.reportMarkdown(a.chain, (p) => (p.startsWith('/tmp/film/kadr-reviews/') ? p.split('/').pop() : p))
  check('the report names the range and the defect with its time', md.includes('# Критик: 1:12.50–1:30.00') && md.includes('### d1 · серьёзно · 1:15.25'))
  check('… links its sheets relative to its folder', md.includes('](film_sheet_1.png)') && md.includes('](/elsewhere/x%20y.png)'))
  check('… keeps the critic\'s note', md.includes('Заметка критика: финал торопится'))
  check('the report\'s file name sorts by time and says the range', /^critic_\d{4}-\d\d-\d\d_\d{4}_72,5-90,0s\.md$/.test(C.reportName(a.chain)), C.reportName(a.chain))
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
