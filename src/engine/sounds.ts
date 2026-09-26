// The sound library: 260 bundled effects (resources/, credits in
// resources/CREDITS.md) with /brag's per-sound analysis, five music beds, and
// the user's own folder (userData/sfx/<family>/, analysed on first sight).
// Renderer side: search, and putting a sound on the timeline without
// disturbing anything — a free audio track or a new one, never on top of the
// music (overlapping audio on one track crossfades, which would duck the music
// under a click) — with its HIT, not its first sample, on the requested time.
import { useEditor } from '@/state/store'
import type { MusicEntry, SfxEntry, SoundLibrary } from '@shared/types'
import { detectBeats, type BeatGrid } from './beats'
import { logWarn } from './log'

let lib: Promise<SoundLibrary> | null = null

/** `rescan` re-reads the user folder (new files get analysed — a second or two each). */
export function loadSoundLibrary(rescan = false): Promise<SoundLibrary> {
  if (!lib || rescan) {
    lib = window.kadr.soundLibrary(rescan).catch((err) => {
      lib = null
      throw err
    })
  }
  return lib
}

/** Describe one of the user's own sounds (id "user:…"); refreshes the library. */
export async function setSoundMeta(id: string, meta: { uses?: string[]; tags?: string[]; note?: string }) {
  const entry = await window.kadr.soundSetMeta(id, meta)
  lib = null
  return entry
}

/** bundled families in display order; the user's own folders follow them */
export const SFX_FAMILIES = ['impact', 'interface', 'ui', 'casino', 'keyboard'] as const

/** every family present, bundled first, then the user's folders */
export function sfxFamilies(all: SfxEntry[]): string[] {
  const user = [...new Set(all.filter((s) => s.origin === 'user').map((s) => s.family))].sort()
  return [...SFX_FAMILIES.filter((f) => all.some((s) => s.family === f && s.origin === 'bundled')), ...user]
}

/** /brag's suggested uses — the keys found in its analysis, plus 'typing' for the keyboard set */
export const SFX_USES = [
  'major reveal', 'hard transition', 'soft reveal', 'logo payoff', 'success', 'reveal confirmation',
  'button press', 'selection', 'simulated user action', 'toggle', 'mode change',
  'card reveal', 'sequential item', 'swipe', 'panel opening', 'typing',
  'general accent', 'tiny accent only', 'chaotic accent', 'comedic interruption',
  // Kadr's own, for longer sounds /brag's set has none of
  'ambience', 'dissolve'
] as const

export interface SfxQuery {
  family?: string
  /** one of SFX_USES */
  use?: string
  /** leave out the high high-frequency-risk sounds (sharp, fatiguing when repeated) */
  soft?: boolean
  /** substring of the file name or a tag */
  text?: string
  limit?: number
}

const RISK = { low: 0, medium: 1, high: 2 } as const

/**
 * Filter the effects. Ordered the way /brag recommends picking: the gentlest
 * first (low high-frequency risk, warm before bright), then by name.
 */
export function findSfx(all: SfxEntry[], q: SfxQuery = {}): SfxEntry[] {
  const text = q.text?.trim().toLowerCase()
  const out = all.filter((s) =>
    (!q.family || s.family === q.family) &&
    (!q.use || s.uses.includes(q.use)) &&
    (!q.soft || s.hfRisk !== 'high') &&
    (!text || s.id.toLowerCase().includes(text) || s.tags.some((t) => t.includes(text)) ||
      !!s.note?.toLowerCase().includes(text)))
  const bright = { warm: 0, balanced: 1, bright: 2 } as const
  out.sort((a, b) =>
    (RISK[a.hfRisk ?? 'medium'] - RISK[b.hfRisk ?? 'medium']) ||
    (bright[a.brightness ?? 'balanced'] - bright[b.brightness ?? 'balanced']) ||
    a.id.localeCompare(b.id))
  return q.limit ? out.slice(0, q.limit) : out
}

export interface AddSoundOpts {
  /**
   * timeline seconds; default = the playhead. For an effect this is where its
   * HIT lands (see alignHit), for music where it starts.
   */
  at?: number
  /**
   * put the sound's hit (SfxEntry.hit — its attack, e.g. 1.5 s into a boom
   * with a lead-in) at `at` rather than its first sample. Default: true for
   * effects, and music always starts at `at`.
   */
  alignHit?: boolean
  /** clip gain 0..2; default 1 */
  gain?: number
  /** music only: lay beat markers over it right away (default true) */
  beats?: boolean
  /** music only: which beats (default 'all') */
  grid?: BeatGrid
}

export interface AddSoundResult {
  clipId: string
  assetId: string
  trackId: string
  kind: 'sfx' | 'music'
  duration: number
  /** where the clip starts */
  start: number
  /** where its hit landed (= at, unless the lead-in would have started before 0) */
  hitAt: number
  /** music with beats: what the detection found */
  tempo?: number
  beatMarkers?: number
}

/**
 * Put a library sound on the timeline. `id` is an SfxEntry.id
 * ("impact/impactSoft_medium_001.ogg") or a MusicEntry.id (its file name).
 */
export async function addSound(id: string, opts: AddSoundOpts = {}): Promise<AddSoundResult> {
  const L = await loadSoundLibrary()
  const sfx = L.sfx.find((s) => s.id === id)
  const music: MusicEntry | undefined = sfx ? undefined : L.music.find((m) => m.id === id)
  const entry = sfx ?? music
  if (!entry) throw new Error(`звук «${id}» не найден в библиотеке`)
  const st = useEditor.getState()
  const existing = st.project.assets.find((a) => a.path === entry.path)
  const asset = existing ?? (await window.kadr.probeMedia(entry.path)).asset
  const label = music ? music.name : id.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '')
  const at = opts.at ?? st.playhead
  const hit = sfx && opts.alignHit !== false ? sfx.hit : 0
  const start = Math.max(0, at - hit)
  const placed = st.placeAudio(asset, start, {
    gain: opts.gain,
    label,
    history: music ? 'hMusic' : 'hSfx'
  })
  const result: AddSoundResult = {
    ...placed,
    kind: music ? 'music' : 'sfx',
    duration: asset.duration,
    start,
    hitAt: start + hit
  }
  if (music && opts.beats !== false) {
    try {
      const b = await detectBeats({ clipIds: [placed.clipId], grid: opts.grid })
      result.tempo = b.tempo
      result.beatMarkers = b.placed
    } catch (err) {
      // the music is on the timeline either way; a failed analysis is a warning
      logWarn('биты', 'музыка добавлена, но биты разметить не удалось', err)
    }
  }
  return result
}
