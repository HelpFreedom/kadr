// Node-side check of electron/claudeArgs.ts and electron/claude-plugin/ — how the
// panel's claude gets Kadr's skills. No app, no network, no claude session.
//
// The bug this guards: the skills used to be copied into ~/.claude/skills, so
// they were listed in EVERY claude session on the machine (and on a CRLF
// checkout the front-matter regex skipped all four, leaving a stale copy
// behind). Now they are a plugin passed with --plugin-dir to the panel's
// claude only; Kadr writes nothing into ~/.claude/skills and removes the
// copies it once put there (marked ones only).
// Run: node scripts/check-claude-args.mjs
import { readFileSync, readdirSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

let mod = {}
try {
  const src = readFileSync(join(root, 'electron', 'claudeArgs.ts'), 'utf8')
  const js = transformSync(src, { loader: 'ts', format: 'esm', platform: 'node' }).code
  mod = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
} catch (err) {
  check('electron/claudeArgs.ts loads', false, String(err).split('\n')[0])
}
const { claudeArgs, removeManagedSkills } = mod

// --- the panel's claude gets --plugin-dir and --mcp-config, and nothing is written to ~/.claude/skills
if (claudeArgs) {
  const a = claudeArgs({ mcpConfig: 'M.json', systemHint: 'HINT', pluginDir: 'P', chat: { resume: false, id: 'abc' } })
  const at = (flag) => a[a.indexOf(flag) + 1]
  check('--plugin-dir points at the plugin', at('--plugin-dir') === 'P', JSON.stringify(a))
  check('--mcp-config points at the generated config', at('--mcp-config') === 'M.json')
  check('--append-system-prompt carries the hint', at('--append-system-prompt') === 'HINT')
  check('a new chat gets --session-id', at('--session-id') === 'abc' && !a.includes('--resume'))
  const r = claudeArgs({ mcpConfig: 'M.json', systemHint: 'H', pluginDir: 'P', chat: { resume: true, id: 'xyz' } })
  check('a known chat gets --resume', r[r.indexOf('--resume') + 1] === 'xyz' && !r.includes('--session-id'))
  const o = claudeArgs({ mcpConfig: 'M.json', systemHint: 'H', pluginDir: 'P', override: ['--foo'] })
  check('an args override replaces everything', JSON.stringify(o) === '["--foo"]')
}

if (removeManagedSkills) {
  const skills = join(tmpdir(), `kadr-skills-${process.pid}`)
  rmSync(skills, { recursive: true, force: true })
  const put = (name, body) => { mkdirSync(join(skills, name), { recursive: true }); writeFileSync(join(skills, name, 'SKILL.md'), body) }
  put('kadr-editor', '---\r\nname: kadr-editor\r\n---\r\n<!-- managed by Kadr: rewritten -->\r\n')
  put('kadr-3d', '---\nname: kadr-3d\n---\n<!-- managed by Kadr: rewritten -->\n')
  put('kadr-mine', '---\nname: kadr-mine\n---\nmy own\n')
  put('other', '<!-- managed by Kadr -->\n')
  const removed = await removeManagedSkills(skills)
  const left = readdirSync(skills).sort()
  check('marked kadr-* copies are removed, everything else kept',
    JSON.stringify(left) === '["kadr-mine","other"]', `left ${left.join(',')}; removed ${removed}`)
  const missing = join(skills, 'nope')
  check('a missing skills folder is not created', (await removeManagedSkills(missing)).length === 0 && !existsSync(missing))
  rmSync(skills, { recursive: true, force: true })
}

// --- the plugin itself
const plugin = join(root, 'electron', 'claude-plugin')
const manifest = (() => { try { return JSON.parse(readFileSync(join(plugin, '.claude-plugin', 'plugin.json'), 'utf8')) } catch { return null } })()
check('plugin.json names the plugin "kadr"', manifest?.name === 'kadr')
const want = ['3d', 'editor', 'motion', 'music']
const have = existsSync(join(plugin, 'skills')) ? readdirSync(join(plugin, 'skills')).sort() : []
check('the plugin ships the four skills', JSON.stringify(have) === JSON.stringify(want), have.join(','))
for (const name of have) {
  const md = readFileSync(join(plugin, 'skills', name, 'SKILL.md'), 'utf8')
  check(`${name}: LF only, front matter names it`, !md.includes('\r') && new RegExp(`^---\\n[\\s\\S]*?^name: ${name}$`, 'm').test(md))
  const stale = md.match(/kadr-(editor|music|motion|3d)\b/g)
  check(`${name}: no reference to the old skill names`, !stale, stale?.join(','))
}
const ts = readFileSync(join(root, 'electron', 'claude.ts'), 'utf8')
check('claude.ts builds args with claudeArgs and the plugin dir', /claudeArgs\(/.test(ts) && ts.includes("'claude-plugin'"))
check('claude.ts no longer writes skills (no syncSkill)', !ts.includes('syncSkill') && !/kadr-(editor|music|motion|3d)\b/.test(ts))

console.log(fails ? `\n${fails} FAIL` : '\nall PASS')
process.exit(fails ? 1 : 0)
