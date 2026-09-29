// Which file in a folder a missing media file is relinked to («Искать в папке»).
// Pure: the listing and the probe come from the caller (main), so
// `node scripts/check-relink-match.mjs` runs it on a fake folder.
//
// A wrong pick is the wrong footage silently swapped into the edit, so every
// rule errs towards «not found» (the user can still point at the file by hand):
// - by NAME first (case-insensitive), then by SIZE — a renamed file;
// - a candidate must agree with everything the asset knows: the size when it
//   was recorded, the duration always (images have none to check);
// - it must be the only candidate that fits, and one file never serves two
//   missing assets.
// An asset with no recorded size (imported before sizes were kept) is found by
// name only.

export interface RelinkWanted {
  id: string
  /** the path the project remembers (its name is what the folder is searched for) */
  path: string
  /** bytes, from the probe at import; absent on older projects */
  size?: number
  /** seconds; 0 for images */
  duration: number
}

export interface RelinkFile {
  path: string
  size: number
}

/** container duration in seconds, or null when the file is not media */
export type DurationProbe = (path: string) => Promise<number | null>

const DURATION_TOLERANCE = 0.05

export function baseName(p: string): string {
  return p.slice(Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\')) + 1)
}

/** assetId → the file to relink it to; ids with no safe match are left out */
export async function relinkMatch(
  wanted: RelinkWanted[],
  files: RelinkFile[],
  probe: DurationProbe
): Promise<Record<string, string>> {
  const durations = new Map<string, Promise<number | null>>()
  const durationOf = (p: string) => {
    if (!durations.has(p)) durations.set(p, probe(p).catch(() => null))
    return durations.get(p)!
  }
  const fits = async (w: RelinkWanted, f: RelinkFile) => {
    if (w.size != null && f.size !== w.size) return false
    if (w.duration <= 0) return true // an image: nothing more to compare
    const d = await durationOf(f.path)
    return d !== null && Math.abs(d - w.duration) <= DURATION_TOLERANCE
  }
  const only = async (w: RelinkWanted, pool: RelinkFile[]) => {
    const ok: RelinkFile[] = []
    for (const f of pool) if (await fits(w, f)) ok.push(f)
    return ok.length === 1 ? ok[0].path : null
  }

  const found: Record<string, string> = {}
  for (const w of wanted) {
    const name = baseName(w.path).toLowerCase()
    const byName = await only(w, files.filter((f) => baseName(f.path).toLowerCase() === name))
    const pick = byName ?? (w.size != null ? await only(w, files.filter((f) => f.size === w.size)) : null)
    if (pick) found[w.id] = pick
  }
  // one file, two assets: nothing tells which one it really is
  const uses = new Map<string, number>()
  for (const p of Object.values(found)) uses.set(p, (uses.get(p) ?? 0) + 1)
  for (const [id, p] of Object.entries(found)) if (uses.get(p)! > 1) delete found[id]
  return found
}
