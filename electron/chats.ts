// Claude chats that belong to a project and travel inside its .kadr file.
//
// Claude Code keeps every conversation as
// <config>/projects/<slug of the cwd>/<session id>.jsonl, and `--resume <id>`
// looks for it only under the slug of the CURRENT cwd. The project stores
// the ids (Project.claudeChats); on save the transcripts are embedded as
// `claudeTranscripts: { id: jsonl }`, on open they are taken out again and
// held here — never in the renderer, whose project is deep-copied on every
// edit. Right before a resume the transcript is put where Claude looks.
// Transcripts only grow, so between two copies of one the longer one wins.
// No electron imports: scripts/check-chats.mjs runs this under plain node.
import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { ClaudeChatInfo, Project } from '@shared/types'

/** Claude Code's folder name for a working directory. */
export function projectSlug(cwd: string): string {
  // ponytail: Claude hashes-and-truncates slugs over 200 chars; such a cwd gets a
  // copy under the plain slug that resume cannot find — mirror its rule if it bites
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

// ponytail: a CLAUDE_CONFIG_DIR set only in claude-env.json is not seen here
const projectsDir = () =>
  join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')

/** Title (the chat's own name, else its first prompt) and last activity. */
export function chatInfo(jsonl: string): { title: string; updated: number } {
  let custom = ''
  let first = ''
  let updated = 0
  for (const line of jsonl.split('\n')) {
    let o
    try { o = JSON.parse(line) } catch { continue } // blank, or still being written
    if (o.type === 'custom-title' && typeof o.customTitle === 'string') custom = o.customTitle
    const t = Date.parse(o.timestamp)
    if (t > updated) updated = t
    if (!first && o.type === 'user' && !o.isMeta) {
      const c = o.message?.content
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.find((p) => p?.type === 'text')?.text ?? '' : ''
      // slash commands and their output arrive as <command-…> markup
      if (!text.startsWith('<')) first = text
    }
  }
  return { title: (custom || first).replace(/\s+/g, ' ').trim().slice(0, 80), updated }
}

/** copies that came in with an opened project file, by session id */
const embedded = new Map<string, string>()

/** The longest copy of a transcript: any of Claude's folders, or the opened file. */
async function transcriptOf(id: string): Promise<string | null> {
  let best = embedded.get(id) ?? null
  let dirs: string[] = []
  try { dirs = await fs.readdir(projectsDir()) } catch { /* no claude history yet */ }
  for (const d of dirs) {
    try {
      const text = await fs.readFile(join(projectsDir(), d, `${id}.jsonl`), 'utf8')
      if (!best || text.length > best.length) best = text
    } catch { /* not in this folder */ }
  }
  return best
}

/** The project as it goes to disk: its chats' transcripts embedded, and
 *  ids with nothing to resume (a chat never written to) left out. */
export async function withTranscripts(p: Project): Promise<Project> {
  const out: Record<string, string> = {}
  for (const id of p.claudeChats ?? []) {
    const text = await transcriptOf(id)
    if (text) out[id] = text
  }
  return { ...p, claudeChats: Object.keys(out), claudeTranscripts: out }
}

/** The project as the renderer gets it: transcripts moved into memory here. */
export function takeTranscripts(p: Project): Project {
  for (const [id, text] of Object.entries(p.claudeTranscripts ?? {})) {
    if (typeof text === 'string' && text.length > (embedded.get(id)?.length ?? 0)) embedded.set(id, text)
  }
  delete p.claudeTranscripts
  return p
}

/** Put the transcript where `claude --resume` run in `cwd` looks for it. */
export async function ensureInStore(id: string, cwd: string): Promise<void> {
  const best = await transcriptOf(id)
  if (!best) return
  const dir = join(projectsDir(), projectSlug(cwd))
  const target = join(dir, `${id}.jsonl`)
  const cur = await fs.readFile(target, 'utf8').catch(() => '')
  if (cur.length >= best.length) return
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(target, best)
}

/** The chats that can be resumed, newest first. */
export async function listChats(ids: string[]): Promise<ClaudeChatInfo[]> {
  const out: ClaudeChatInfo[] = []
  for (const id of ids) {
    const text = await transcriptOf(id)
    if (text) out.push({ id, ...chatInfo(text) })
  }
  return out.sort((a, b) => b.updated - a.updated)
}
