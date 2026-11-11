// Application test of Kadr's agent skills: does the TEXT teach the traps?
//
// A real claude gets a realistic Kadr task in an empty temp folder whose
// .claude/skills holds the working-tree skills — `--setting-sources project`,
// so the user's own skills and the copies Kadr last synced stay out. It may
// only load skills and Read their files (`--tools Skill,Read`); the kadr_*
// tools are not connected, so it answers with a numbered PLAN of tool calls.
// Graded: which skills it loaded and which reference files it read (from the
// stream of its tool calls), and the order of the steps in its plan. A failure
// is a defect in the skill text — fix the skill, then run again; the method is
// scenario-labs/skills' "application test" (docs/application-test.md).
//
// COSTS the user's Claude usage: one short session per scenario (a few cents
// each on API pricing). Not part of the pure checks — run it after changing a
// skill. `--baseline` runs the same tasks with no skills installed, to see
// what the skills buy; `--only <id>` runs one scenario; KADR_SKILL_TEST_MODEL
// picks the model (default: the CLI's own).
// Run: node scripts/skill-plan-test.mjs [--baseline] [--only captions]
import { cpSync, mkdtempSync, mkdirSync, readdirSync, rmSync, statSync } from 'fs'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = join(root, 'electron', 'skills')
const args = process.argv.slice(2)
const baseline = args.includes('--baseline')
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null

const CONTRACT = `You are being tested on how you would carry out a task in the Kadr video editor.
The kadr_* MCP tools are NOT connected in this test: never try to call them.
First load the skills that apply (Skill tool) and read every file a skill tells you to read for this task (Read tool).
Then answer with ONLY a numbered plan, one step per line, in the order you would do them:
"N. tool_name(key args) — why". Write a step where you would speak to the user as ask_user("…") or report("…"),
and a sub-agent as Agent(subagent_type, prompt). No prose outside the plan.`

/**
 * The plan as steps. A tool counts as CALLED only when a step starts with it
 * ("4. kadr_voice_check(…)"): a good plan also says what it will NOT do
 * («no kadr_voice_verdict from me»), and a text search took that as a call.
 */
const steps = (plan) => plan.split('\n').flatMap((l) => {
  const m = /^\s*\d+[.)]\s*`?([A-Za-z_][\w-]*)`?\s*\(/.exec(l)
  return m ? [{ tool: m[1], text: l }] : []
})
/** index of the first step that calls a tool matching `re`, Infinity when none */
const call = (r, re, also = () => true) => { const i = r.steps.findIndex((s) => re.test(s.tool) && also(s.text)); return i < 0 ? Infinity : i }
/** index of the first step whose text matches `re` */
const says = (r, re) => { const i = r.steps.findIndex((s) => re.test(s.text)); return i < 0 ? Infinity : i }

const SCENARIOS = [
  {
    id: 'captions',
    task: 'В проекте видеоклип с речью на 0–12 с. Сделай к нему анимированные субтитры — слово за словом, современно — и покажи мне.',
    checks: (r) => {
      const frag = call(r, /^kadr_fragment_create$/)
      const critic = call(r, /^Agent$/, (t) => t.includes('kadr-critic'))
      return [
        ['loads kadr-editor and kadr-motion', r.skills.has('kadr-editor') && r.skills.has('kadr-motion')],
        ['transcribes the speech (kadr_transcribe)', call(r, /^kadr_transcribe$/) < Infinity],
        ['a fragment it writes is type-checked with kadr_typecheck, not tsc',
          frag === Infinity || (call(r, /^kadr_typecheck$/) > frag && call(r, /^Bash$/, (t) => /\btsc\b/.test(t)) === Infinity)],
        ['reads references/fragments.md when it writes a fragment',
          frag === Infinity || r.reads.some((p) => p.endsWith('references/fragments.md'))],
        ['runs kadr_check, then the critic, before showing', call(r, /^kadr_check$/) < critic && critic < Infinity],
        ['never exports unasked', call(r, /^kadr_export$/) === Infinity],
        ['never calls the critic\'s own tools', call(r, /^kadr_review_/) === Infinity]
      ]
    }
  },
  {
    id: 'voice',
    task: 'Озвучь моим голосом этот абзац и проверь озвучку на дефекты: «Сегодня мы соберём книжную полку. Сначала разметим стену, потом закрепим кронштейны.»',
    checks: (r) => [
      ['reads references/voice.md', r.reads.some((p) => p.endsWith('references/voice.md'))],
      ['says it costs credits before synthesising', says(r, /кредит|credit/i) < call(r, /^kadr_voice_speak$/) && call(r, /^kadr_voice_speak$/) < Infinity],
      ['runs the detector (kadr_voice_check)', call(r, /^kadr_voice_check$/) < Infinity],
      ['leaves the verdicts to the user (no kadr_voice_verdict)', call(r, /^kadr_voice_verdict$/) === Infinity],
      ['regenerates nothing on its own', call(r, /^kadr_voice_regenerate$/) === Infinity]
    ]
  },
  {
    id: 'ui',
    task: 'Открой в редакторе окно «Биты» и запусти анализ ритма кнопкой в нём.',
    checks: (r) => [
      ['reads references/interface.md', r.reads.some((p) => p.endsWith('references/interface.md'))],
      ['uses the data-act handles', /data-act=\\?["']beats\\?["']/.test(r.plan) && /beats-run/.test(r.plan)],
      ['names no button by an emoji', !/\p{Extended_Pictographic}/u.test(r.plan)]
    ]
  },
  {
    id: 'music',
    task: 'Нарежь клипы с дорожки V1 под музыку на дорожке A1.',
    checks: (r) => [
      ['loads kadr-music', r.skills.has('kadr-music')],
      ['maps the music first (kadr_beats)', call(r, /^kadr_beats$/) < call(r, /^kadr_eval$/)],
      ['shows the music map to the user before cutting', call(r, /^(ask_user|report)$/) < call(r, /^kadr_eval$/)],
      ['never exports unasked', call(r, /^kadr_export$/) === Infinity]
    ]
  }
]

function run(task) {
  const dir = mkdtempSync(join(tmpdir(), 'kadr-skilltest-'))
  try {
    if (!baseline) {
      mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
      for (const n of readdirSync(SKILLS)) {
        if (statSync(join(SKILLS, n)).isDirectory()) cpSync(join(SKILLS, n), join(dir, '.claude', 'skills', n), { recursive: true })
      }
    }
    const cli = ['-p', task, '--append-system-prompt', CONTRACT, '--setting-sources', 'project',
      '--tools', 'Skill,Read', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--max-budget-usd', '1']
    if (process.env.KADR_SKILL_TEST_MODEL) cli.push('--model', process.env.KADR_SKILL_TEST_MODEL)
    const p = spawnSync('claude', cli, { cwd: dir, encoding: 'utf8', input: '', timeout: 600000, maxBuffer: 64 << 20 })
    const skills = new Set()
    const reads = []
    let plan = ''
    let cost = 0
    for (const line of (p.stdout || '').split('\n')) {
      let m
      try { m = JSON.parse(line) } catch { continue }
      if (m.type === 'assistant') {
        for (const c of m.message?.content ?? []) {
          if (c.type !== 'tool_use') continue
          if (c.name === 'Skill') skills.add(String(c.input?.skill ?? c.input?.name ?? ''))
          if (c.name === 'Read') reads.push(String(c.input?.file_path ?? ''))
        }
      }
      if (m.type === 'result') { plan = String(m.result ?? ''); cost = Number(m.total_cost_usd ?? 0) }
    }
    return { skills, reads, plan, steps: steps(plan), cost, error: plan ? '' : (p.stderr || '').slice(-400) }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

let fails = 0
let spent = 0
for (const s of SCENARIOS.filter((x) => !only || x.id === only)) {
  const r = run(s.task)
  spent += r.cost
  console.log(`\n== ${s.id}${baseline ? ' (no skills)' : ''} — skills: ${[...r.skills].join(', ') || '—'}; read: ${r.reads.map((p) => p.split('/.claude/skills/')[1] ?? p).join(', ') || '—'}`)
  if (!r.plan) { console.log(`FAIL  no plan came back: ${r.error}`); fails++; continue }
  if (!r.steps.length) { console.log('FAIL  the answer has no numbered steps:\n' + r.plan); fails++; continue }
  let bad = 0
  for (const [name, ok] of s.checks(r)) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`)
    if (!ok) bad++
  }
  if (bad) { fails += bad; console.log('--- the plan:\n' + r.plan) }
}
console.log(`\n${fails ? fails + ' FAILED' : 'all passed'} · ${spent ? '$' + spent.toFixed(3) : 'cost not reported'}`)
process.exit(fails ? 1 : 0)
