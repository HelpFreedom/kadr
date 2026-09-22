// Node-side check of electron/chats.ts — Claude chats travelling inside the
// project file. No app, no network, no claude: a temp dir stands in for
// Claude Code's config dir (CLAUDE_CONFIG_DIR).
//
// The promise this guards: a chat started from the editor can be resumed
// from the saved .kadr on a machine (or a folder) where Claude Code's own
// copy of it no longer exists.
// Run: node scripts/check-chats.mjs
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { tmpdir } from 'os'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'electron', 'chats.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const chats = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

const line = (o) => JSON.stringify(o) + '\n'
const user = (content, ts, extra = {}) =>
  line({ type: 'user', message: { role: 'user', content }, timestamp: ts, ...extra })
const reply = (text, ts) =>
  line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, timestamp: ts })

// --- the folder name Claude Code files a working directory under
check('slug: drive path', chats.projectSlug('D:\\PORTABLE\\DevStack') === 'D--PORTABLE-DevStack',
  chats.projectSlug('D:\\PORTABLE\\DevStack'))
check('slug: posix path', chats.projectSlug('/home/u/my film') === '-home-u-my-film')

// --- title and time of a conversation
const T1 = '2026-09-18T10:00:00.000Z'
const T2 = '2026-09-18T10:05:00.000Z'
const whole =
  user('<command-name>/model</command-name>', T1) +
  user('Caveat: meta', T1, { isMeta: true }) +
  user([{ type: 'text', text: '  Убери паузы\nв начале  ' }], T1) +
  reply('Готово', T2)
const plain = whole + '{"type":"assistant","mess' // a line claude is still writing
const info = chats.chatInfo(plain)
check('title: first real user text, whitespace folded', info.title === 'Убери паузы в начале', JSON.stringify(info.title))
check('updated: newest timestamp', info.updated === Date.parse(T2), String(info.updated))
const named = whole + line({ type: 'custom-title', customTitle: 'Монтаж интро', sessionId: 'x' })
check('title: custom-title wins', chats.chatInfo(named).title === 'Монтаж интро')
check('title: empty chat', chats.chatInfo('').title === '')

// --- round trip through the project file
const cfg = mkdtempSync(join(tmpdir(), 'kadr-chats-'))
process.env.CLAUDE_CONFIG_DIR = cfg
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const GONE = '33333333-3333-4333-8333-333333333333'
const home = join(cfg, 'home-cwd')
const film = join(cfg, 'films', 'intro')
const storeOf = (cwd, id) => join(cfg, 'projects', chats.projectSlug(cwd), `${id}.jsonl`)
mkdirSync(dirname(storeOf(home, A)), { recursive: true })
writeFileSync(storeOf(home, A), plain)
writeFileSync(storeOf(home, B), user('второй', T1))

const project = { name: 'p', tracks: [], assets: [], claudeChats: [A, B, GONE] }
const saved = await chats.withTranscripts(project)
check('save: transcripts embedded', saved.claudeTranscripts?.[A] === plain && saved.claudeTranscripts?.[B] !== undefined)
check('save: chat without a transcript is not embedded', !(GONE in (saved.claudeTranscripts ?? {})))
check('save: an id with nothing to resume is dropped from the file', saved.claudeChats?.join() === [A, B].join(),
  JSON.stringify(saved.claudeChats))
check('save: the live project is untouched', !('claudeTranscripts' in project))

const listed = await chats.listChats([A, B, GONE])
check('list: only chats that have a transcript, newest first',
  listed.map((c) => c.id).join() === [A, B].join(), JSON.stringify(listed.map((c) => c.id)))

// the file travels to another machine: Claude Code's copies are gone
rmSync(join(cfg, 'projects'), { recursive: true, force: true })
const loaded = chats.takeTranscripts(JSON.parse(JSON.stringify(saved)))
check('open: transcripts leave the project object', !('claudeTranscripts' in loaded) && loaded.claudeChats.length === 2)
check('list: works from the opened file alone', (await chats.listChats([A])).length === 1)
await chats.ensureInStore(A, film)
check('resume: transcript restored under the new folder',
  existsSync(storeOf(film, A)) && readFileSync(storeOf(film, A), 'utf8') === plain)

// claude appended to its copy since: an older embedded copy must never win
const longer = plain + reply('ещё', T2)
writeFileSync(storeOf(film, A), longer)
await chats.ensureInStore(A, film)
check('resume: a longer store copy is kept', readFileSync(storeOf(film, A), 'utf8') === longer)
check('save: the longer store copy is what gets embedded',
  (await chats.withTranscripts(loaded)).claudeTranscripts[A] === longer)

rmSync(cfg, { recursive: true, force: true })
console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
