// Node-side check of Kadr's agent skills (electron/skills/<name>/) and of the
// sync that installs them (electron/skillSync.ts).
//
// Why each rule exists:
//   • BUDGET. After a context compaction Claude Code re-attaches only the first
//     ~5000 tokens of each invoked skill, from a shared ~25 000-token pool
//     (measured and written up by scenario-labs/skills, docs/decisions.md).
//     kadr-editor had grown to 2859 words / 19 KB — its tail (the interface
//     table, the voice-over rules, the recipes) was the part that went. A body
//     must stay under 2500 words AND 12 000 bytes: Cyrillic costs about twice
//     the bytes per token of English, so words alone under-count our skills.
//   • ONE LEVEL. Supporting files are linked straight from SKILL.md and say
//     nothing an agent must follow into a further file: an agent resolves a
//     reference once, not a chain.
//   • TRIGGERS. A description is what decides whether the skill is loaded; it
//     says WHEN ("Use when …"), not what the skill contains, in ≤ 500 chars.
//   • ONE FACT, ONE PLACE. Numbers the code enforces are stated in a skill too
//     (hold times, the beat window); they are compared with CHECK_LIMITS here,
//     so a change to one cannot silently leave the other behind. The critic
//     cannot load skills, so it carries its own copy of the AI-template tells —
//     compared with kadr-motion's list.
// Run: node scripts/check-skills.mjs
import { readFileSync, readdirSync, statSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, relative, resolve } from 'path'
import { tmpdir } from 'os'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = join(root, 'electron', 'skills')
const MARK = '<!-- managed by Kadr'
const MAX_WORDS = 2500
const MAX_BYTES = 12000
const MAX_DESC = 500

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const read = (p) => readFileSync(p, 'utf8')
const walk = (d) => readdirSync(d).flatMap((n) => {
  const p = join(d, n)
  return statSync(p).isDirectory() ? walk(p) : [p]
})
/** the body after the front matter, as scenario-labs counts it */
const body = (src) => src.replace(/^---\n[\s\S]*?\n---\n/, '')
const words = (s) => s.split(/\s+/).filter(Boolean).length
/** relative markdown link targets, anchors and URLs left out */
const links = (src) => [...src.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])
  .filter((t) => !/^[a-z]+:|^#/.test(t)).map((t) => t.split('#')[0])

// ---------------------------------------------------------------- the shipped skills
const names = readdirSync(SKILLS).filter((n) => statSync(join(SKILLS, n)).isDirectory()).sort()
check('the skills are folders, each with a SKILL.md', names.length >= 4 && names.every((n) => existsSync(join(SKILLS, n, 'SKILL.md'))), names.join(', '))
check('no loose skill file left in the old flat layout', !readdirSync(SKILLS).some((n) => n.endsWith('.md')))

for (const n of names) {
  const dir = join(SKILLS, n)
  const src = read(join(dir, 'SKILL.md'))
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(src)?.[1] ?? ''
  const keys = fm.split('\n').map((l) => /^([a-z_]+):/.exec(l)?.[1]).filter(Boolean)
  check(`${n}: front matter is name + description (+ license)`, keys[0] === 'name' && keys[1] === 'description' && keys.every((k) => ['name', 'description', 'license'].includes(k)), keys.join(','))
  check(`${n}: name equals its folder`, /^name:\s*(.+)$/m.exec(fm)?.[1].trim() === n)
  const desc = /^description:\s*(.+)$/m.exec(fm)?.[1].trim() ?? ''
  check(`${n}: description says when ("Use when …"), ≤ ${MAX_DESC} chars`, desc.startsWith('Use when') && desc.length <= MAX_DESC, `${desc.length} chars`)
  const b = body(src)
  const w = words(b)
  const bytes = Buffer.byteLength(b)
  check(`${n}: body within budget (≤ ${MAX_WORDS} words, ≤ ${MAX_BYTES} bytes)`, w <= MAX_WORDS && bytes <= MAX_BYTES, `${w} words, ${bytes} bytes`)

  const files = walk(dir).map((p) => relative(dir, p))
  for (const f of files.filter((f) => f.endsWith('.md'))) {
    check(`${n}/${f}: carries the managed mark`, read(join(dir, f)).includes(MARK))
  }
  const linked = new Set(links(src).map((t) => relative(dir, resolve(dir, t))))
  for (const t of linked) check(`${n}: link ${t} resolves`, existsSync(join(dir, t)))
  for (const f of files.filter((f) => f !== 'SKILL.md')) {
    check(`${n}: ${f} is linked from SKILL.md`, linked.has(f))
    const inner = links(read(join(dir, f))).filter((t) => /\.md$/.test(t))
    check(`${n}: ${f} sends the agent no further (one level)`, inner.length === 0, inner.join(', '))
  }
}

// ---------------------------------------------------------------- one fact, one place
const checks = read(join(root, 'src', 'engine', 'checks.ts'))
const limit = (k) => Number(new RegExp(`\\b${k}:\\s*([0-9.]+)`).exec(checks)?.[1])
const L = Object.fromEntries(['beatMs', 'textMovePxPerSec', 'readShortWords', 'readShort', 'readPhrase', 'readPerWord', 'readSub'].map((k) => [k, limit(k)]))
check('CHECK_LIMITS were read from checks.ts', Object.values(L).every(Number.isFinite), JSON.stringify(L))
const motion = read(join(SKILLS, 'kadr-motion', 'SKILL.md')).replace(/\s+/g, ' ')
const music = read(join(SKILLS, 'kadr-music', 'SKILL.md')).replace(/\s+/g, ' ')
const floor = `The floor that \`kadr_check\` enforces: ${L.readShort} s for 1–${L.readShortWords} words, ${L.readPerWord} s per word and at least ${L.readPhrase} s for a sentence, +${L.readSub} s for a subtitle.`
check('kadr-motion states the hold-time floor exactly as kadr_check enforces it', motion.includes(floor), floor)
check('kadr-motion states the moving-text speed kadr_check uses', motion.includes(`faster than ~${L.textMovePxPerSec} px/s`))
check('kadr-music states the beat window kadr_check uses', music.includes(`off the grid by more than ${L.beatMs} ms`))
const critic = read(join(root, 'electron', 'agents', 'kadr-critic.md')).replace(/\s+/g, ' ')
const tells = ['HUD frames', 'scanlines', 'running timecodes', 'neon outlines on text', 'stamps', 'progress bars', 'white flashes on cuts', 'camera shake or wobble', 'text pulsing on the beat']
for (const t of tells) check(`the AI-template tell «${t}» is in kadr-motion and in the critic`, motion.includes(t) && critic.includes(t))

// ---------------------------------------------------------------- the sync
const js = transformSync(read(join(root, 'electron', 'skillSync.ts')), { loader: 'ts', format: 'esm' }).code
const { syncSkills } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const tmp = mkdtempSync(join(tmpdir(), 'kadr-skills-'))
const put = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s) }
const skill = (name, extra = '') => `---\nname: ${name}\ndescription: Use when testing.\n---\n${MARK}: test -->\n${extra}\n`
try {
  const src = join(tmp, 'src')
  const dst = join(tmp, 'dst')
  put(join(src, 'kadr-a', 'SKILL.md'), skill('kadr-a', 'see [references/x.md](references/x.md)'))
  put(join(src, 'kadr-a', 'references', 'x.md'), `${MARK} -->\nx v1\n`)
  put(join(src, 'kadr-a.md.bak-2026-10-14'), 'a loose backup in the source folder')

  let r = await syncSkills(src, dst)
  check('sync: a fresh install writes the skill and its references', r.written.length === 2 && read(join(dst, 'kadr-a', 'references', 'x.md')).includes('x v1'), r.written.join(', '))
  r = await syncSkills(src, dst)
  check('sync: a second run writes nothing', r.written.length === 0 && r.removed.length === 0)

  // what the user keeps next to the installed skills
  put(join(dst, 'kadr-a', 'SKILL.md.bak-2026-10-14'), skill('kadr-a', 'an old copy — it carries the mark too'))
  put(join(dst, 'kadr-a', 'references', 'mine.md'), 'my own notes, no mark')
  put(join(dst, 'kadr-a', 'references', 'old.md'), `${MARK} -->\na reference Kadr no longer ships\n`)
  put(join(dst, 'kadr-mine', 'SKILL.md'), '---\nname: kadr-mine\ndescription: the user\'s own\n---\nrules\n')
  put(join(dst, 'kadr-gone', 'SKILL.md'), skill('kadr-gone'))
  put(join(dst, 'kadr-gone', 'SKILL.md.bak'), 'goes with its folder')
  put(join(src, 'kadr-a', 'references', 'x.md'), `${MARK} -->\nx v2\n`)
  r = await syncSkills(src, dst)
  check('sync: a changed reference is rewritten', read(join(dst, 'kadr-a', 'references', 'x.md')).includes('x v2'))
  check('sync: a reference Kadr no longer ships is removed', !existsSync(join(dst, 'kadr-a', 'references', 'old.md')))
  check('sync: the user\'s backup next to SKILL.md survives (it carries the mark)', existsSync(join(dst, 'kadr-a', 'SKILL.md.bak-2026-10-14')))
  check('sync: an unmarked file of the user\'s inside references survives', existsSync(join(dst, 'kadr-a', 'references', 'mine.md')))
  check('sync: the user\'s own kadr-* skill (no mark) is never touched', existsSync(join(dst, 'kadr-mine', 'SKILL.md')))
  check('sync: a managed skill Kadr no longer ships is removed whole', !existsSync(join(dst, 'kadr-gone')))
  check('sync: the report names what went', r.removed.includes(join('kadr-a', 'references', 'old.md')) && r.removed.includes('kadr-gone'), r.removed.join(', '))

  put(join(src, 'kadr-b', 'SKILL.md'), skill('kadr-other'))
  r = await syncSkills(src, dst)
  check('sync: a skill whose name differs from its folder is skipped, not installed', r.skipped.includes('kadr-b') && !existsSync(join(dst, 'kadr-b')) && !existsSync(join(dst, 'kadr-other')))

  const empty = join(tmp, 'empty')
  mkdirSync(empty)
  r = await syncSkills(empty, dst)
  check('sync: an empty source removes nothing', r.removed.length === 0 && existsSync(join(dst, 'kadr-a', 'SKILL.md')))

  const real = join(tmp, 'real')
  await syncSkills(SKILLS, real)
  const same = names.every((n) => walk(join(SKILLS, n)).every((p) => {
    const q = join(real, n, relative(join(SKILLS, n), p))
    return existsSync(q) && read(q) === read(p)
  }))
  check('sync: the shipped skills install byte for byte', same)
  check('sync: the source folder\'s loose backups are not installed', !walk(real).some((p) => p.includes('.bak')))
} finally {
  rmSync(tmp, { recursive: true, force: true })
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
