// The panel's claude command line, and the cleanup of skills Kadr once copied
// into ~/.claude/skills. Pure (fs only, no electron) so
// scripts/check-claude-args.mjs can run it.
//
// Kadr's skills are a session plugin (electron/claude-plugin, name "kadr"):
// --plugin-dir loads them for the panel's claude only, as kadr:editor,
// kadr:music, kadr:motion and kadr:3d. They used to be copied into
// ~/.claude/skills, which listed them in every claude session on the machine.
import { promises as fs } from 'fs'
import { join } from 'path'

export interface ClaudeArgsInput {
  mcpConfig: string
  systemHint: string
  pluginDir: string
  /** a chat to resume, or the id a new one starts with; absent with an override */
  chat?: { resume: boolean; id: string }
  /** claude-env.json `args`: replaces everything, plugin included */
  override?: string[]
}

export function claudeArgs(a: ClaudeArgsInput): string[] {
  if (a.override) return a.override
  return [
    '--mcp-config', a.mcpConfig,
    '--plugin-dir', a.pluginDir,
    '--append-system-prompt', a.systemHint,
    ...(a.chat ? [a.chat.resume ? '--resume' : '--session-id', a.chat.id] : [])
  ]
}

/** the line every skill Kadr once copied carried — only such folders are removed */
const SKILL_MARK = '<!-- managed by Kadr'

/**
 * Remove the `kadr-*` folders in `root` (~/.claude/skills) whose SKILL.md
 * carries Kadr's mark: copies from the versions that synced skills globally.
 * A folder without the mark is the user's own and is never touched. Returns
 * the names removed.
 */
export async function removeManagedSkills(root: string): Promise<string[]> {
  const removed: string[] = []
  for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || !d.name.startsWith('kadr-')) continue
    const md = await fs.readFile(join(root, d.name, 'SKILL.md'), 'utf8').catch(() => '')
    if (!md.includes(SKILL_MARK)) continue
    await fs.rm(join(root, d.name), { recursive: true, force: true })
    removed.push(d.name)
  }
  return removed
}
