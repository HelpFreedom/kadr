// Kadr's agent skills → the user's skills directory (~/.claude/skills).
// No electron import, so scripts/check-skills.mjs runs it against temp dirs.
//
// A skill is a FOLDER: electron/skills/<name>/SKILL.md plus files it links
// (references/*.md), which the agent reads only when the task needs them —
// a skill's body stays small enough to survive Claude Code's post-compaction
// re-attach, which keeps only the first ~5000 tokens of each invoked skill.
//
// What may be touched, and why that narrowly:
//   • a shipped file is written when its content differs (temp file + rename);
//   • a file under a SUBFOLDER of a shipped skill that carries Kadr's mark but
//     is no longer shipped is removed — a reference that was renamed or merged
//     must not stay behind as a second, stale statement of the same rules;
//   • a top-level file that is not shipped is left alone: the user keeps
//     backups such as SKILL.md.bak-<date> next to SKILL.md, and those carry the
//     mark too, being copies;
//   • a kadr-* folder whose SKILL.md carries the mark but is no longer shipped
//     is removed whole; a folder without the mark is the user's own (a skill
//     of theirs may well be called kadr-something) and is never touched.
import { promises as fs } from 'fs'
import { dirname, join, relative, sep } from 'path'

/** the line every file Kadr ships carries — only such files are ever removed */
export const SKILL_MARK = '<!-- managed by Kadr'

export interface SkillSyncReport {
  written: string[]
  removed: string[]
  skipped: string[]
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (d: string) => {
    for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) out.push(relative(dir, p))
    }
  }
  await walk(dir)
  return out.sort()
}

/** the `name:` of a SKILL.md's front matter */
export function skillName(src: string): string | null {
  return /^---\n[\s\S]*?^name:\s*([a-z0-9-]+)\s*$/m.exec(src)?.[1] ?? null
}

export async function syncSkills(srcDir: string, root: string): Promise<SkillSyncReport> {
  const report: SkillSyncReport = { written: [], removed: [], skipped: [] }
  const shipped = new Set<string>()
  for (const e of (await fs.readdir(srcDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue // e.g. the user's kadr-editor.md.bak-<date>
    const md = await fs.readFile(join(srcDir, e.name, 'SKILL.md'), 'utf8').catch(() => null)
    if (md === null) continue
    if (skillName(md) !== e.name || !md.includes(SKILL_MARK)) {
      report.skipped.push(e.name)
      continue
    }
    shipped.add(e.name)
    const files = await filesUnder(join(srcDir, e.name))
    for (const f of files) {
      const src = await fs.readFile(join(srcDir, e.name, f))
      const dst = join(root, e.name, f)
      const cur = await fs.readFile(dst).catch(() => null)
      if (cur && cur.equals(src)) continue
      await fs.mkdir(dirname(dst), { recursive: true })
      const tmp = `${dst}.part-${process.pid}`
      await fs.writeFile(tmp, src)
      await fs.rename(tmp, dst)
      report.written.push(join(e.name, f))
    }
    const keep = new Set(files)
    for (const f of await filesUnder(join(root, e.name))) {
      if (keep.has(f) || !f.includes(sep)) continue // top level: the user's own files
      const body = await fs.readFile(join(root, e.name, f), 'utf8').catch(() => '')
      if (!body.includes(SKILL_MARK)) continue
      await fs.rm(join(root, e.name, f), { force: true })
      report.removed.push(join(e.name, f))
    }
  }
  if (!shipped.size) return report // nothing read: never take this as "remove everything"
  for (const d of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory() || !d.name.startsWith('kadr-') || shipped.has(d.name)) continue
    const md = await fs.readFile(join(root, d.name, 'SKILL.md'), 'utf8').catch(() => '')
    if (!md.includes(SKILL_MARK)) continue
    await fs.rm(join(root, d.name), { recursive: true, force: true })
    report.removed.push(d.name)
  }
  return report
}
