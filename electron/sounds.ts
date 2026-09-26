// Music analysis and the bundled sound library.
//
// audio:analyze — mix a timeline range through the export segment graph (the
// same WYSIWYG mixdown transcription and the neon wave use), decode it to mono
// f32 at 44.1 kHz and stream it through shared/audioAnalysis.ts: tempo, a beat
// grid matching librosa's beat_track, and band energies for audio-reactive
// fragments.
//
// sounds:library — the sound effects and music shipped in resources/ (see
// resources/CREDITS.md) plus the user's own folder, userData/sfx/<family>/.
// Labels: /brag's for the 228 it analysed; shared/sfxFeatures.ts (rules fitted
// to /brag's, agreement checked by scripts/check-sfx-labels.mjs) for the rest —
// the bundled keyboard set and every user sound, analysed on first sight and
// cached by size+mtime in userData/sfx/kadr-sfx.json. The HIT time of every
// sound (bundled: resources/sfx/kadr-sfx.json) is what placement aligns.
import { ipcMain, app } from 'electron'
import { promises as fs } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { FFMPEG, FFPROBE, mixdownWav, runStream } from './ffmpeg'
import { AudioAnalyzer, analyzeBeats, featureCurves } from '@shared/audioAnalysis'
import { sfxFeatures, labelSfx, SFX_ANALYSIS_VERSION, type SfxLabels } from '@shared/sfxFeatures'
import type {
  AnalyzeRequest, AudioAnalysisResult, SfxEntry, MusicEntry, SoundLibrary
} from '@shared/types'

/**
 * 44.1 kHz, not librosa's default 22.05: the tempo is quantised to whole
 * analysis frames per beat, and at 22.05 kHz (43 frames/s) a 120.19 BPM track
 * can only read as 117.45 or 123.05 — the beats stay put, the number shown is
 * wrong. At 44.1 kHz (86 frames/s) it reads 120.19, and this is the rate the
 * beat path was checked against librosa at, beat for beat (/brag's cues).
 */
const SR = 44100

export async function analyzeRange(req: AnalyzeRequest): Promise<AudioAnalysisResult> {
  const duration = Number(req.duration)
  if (!(duration > 0)) throw new Error('analyze: bad duration')
  const an = new AudioAnalyzer(SR)
  // Nothing audible (silence, only text/fragment clips): analyse digital
  // silence of the right length — no beats, flat curves — rather than building
  // an ffmpeg command with no inputs, which fails.
  if (!req.audioSegments?.length) {
    // in one-second pieces: an hour of silence in one array would be 300 MB
    const zeros = new Float32Array(SR)
    for (let left = Math.round(duration * SR); left > 0; left -= SR) {
      an.push(left >= SR ? zeros : zeros.subarray(0, left))
    }
  } else {
    const wav = join(tmpdir(), `kadr-analyze-${Date.now()}-${process.pid}.wav`)
    try {
      await mixdownWav(req.audioSegments, duration, wav)
      // f32le chunks are not 4-byte aligned — carry the remainder across chunks
      let rest: Buffer = Buffer.alloc(0)
      await runStream(
        FFMPEG,
        ['-v', 'error', '-i', wav, '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'],
        (chunk) => {
          const buf = rest.length ? Buffer.concat([rest, chunk]) : chunk
          const usable = buf.length - (buf.length % 4)
          if (usable) {
            const f32 = new Float32Array(usable / 4)
            new Uint8Array(f32.buffer).set(buf.subarray(0, usable))
            an.push(f32)
          }
          rest = Buffer.from(buf.subarray(usable))
        }
      )
    } finally {
      fs.unlink(wav).catch(() => { /* never created */ })
    }
  }
  const frames = an.finish()
  const beats = analyzeBeats(frames)
  const r4 = (v: number) => Math.round(v * 1e4) / 1e4
  return {
    duration,
    frameRate: frames.frameRate,
    tempo: Math.round(beats.tempo * 100) / 100,
    beats: beats.beats
      .filter((b) => b.time <= duration)
      .map((b) => ({ time: r4(b.time), intensity: r4(b.intensity), strong: b.strong })),
    accentPhase: beats.accentPhase,
    ...(beats.attack ? { attack: beats.attack } : {}),
    curves: featureCurves(frames)
  }
}

// ------------------------------------------------------------------ library

export const RESOURCES = () => join(app.getAppPath(), 'resources')

/** Decode a sound to mono f32 at 44.1 kHz: the channel MEAN (ffmpeg's -ac 1
    matrix would scale a stereo file by √2), trimmed to the container duration —
    the input shared/sfxFeatures.ts is defined on and was checked against. */
async function decodeMono(path: string): Promise<Float32Array> {
  const SFX_SR = 44100
  let probe = ''
  await runStream(FFPROBE, ['-v', 'error', '-select_streams', 'a:0', '-show_entries',
    'stream=channels:format=duration', '-of', 'json', path], (c) => { probe += c })
  const info = JSON.parse(probe)
  const ch = Math.max(1, Number(info.streams?.[0]?.channels) || 1)
  const dur = Number(info.format?.duration)
  const chunks: Buffer[] = []
  await runStream(FFMPEG, ['-v', 'error', '-i', path, '-ar', String(SFX_SR), '-f', 'f32le', '-'], (c) => chunks.push(c))
  const buf = Buffer.concat(chunks)
  const inter = new Float32Array(buf.length >> 2)
  new Uint8Array(inter.buffer).set(buf.subarray(0, inter.length * 4))
  let frames = Math.floor(inter.length / ch)
  if (dur > 0) frames = Math.min(frames, Math.round(dur * SFX_SR))
  const mono = new Float32Array(frames)
  for (let i = 0; i < frames; i++) {
    let v = 0
    for (let c = 0; c < ch; c++) v += inter[i * ch + c]
    mono[i] = v / ch
  }
  return mono
}

export async function analyzeSoundFile(path: string) {
  const x = sfxFeatures(await decodeMono(path), 44100)
  return { features: x, labels: labelSfx(x) }
}

/** the user's own sounds: userData/sfx/<family>/<file> — never part of the repository */
export const USER_SFX = () => join(app.getPath('userData'), 'sfx')
const USER_CATALOG = () => join(USER_SFX(), 'kadr-sfx.json')
const SOUND_EXT = /\.(ogg|wav|mp3|flac|m4a|opus|aac)$/i

interface UserCatalogEntry {
  path: string
  /** SFX_ANALYSIS_VERSION it was analysed with */
  v?: number
  size: number
  mtimeMs: number
  duration: number
  hit: number
  labels: SfxLabels
  features?: Record<string, number>
  /** written by a person (or by the embedded Claude on request) — survive re-analysis */
  uses?: string[]
  tags?: string[]
  note?: string
}

/**
 * Scan the user folder, analyse whatever is new or changed (by size+mtime),
 * drop entries whose file is gone, and keep the hand-written uses/tags/note of
 * a path across its re-analysis. The catalogue is rewritten only when it changed.
 */
async function userSounds(): Promise<SfxEntry[]> {
  const rootDir = USER_SFX()
  await fs.mkdir(rootDir, { recursive: true })
  let files: UserCatalogEntry[] = []
  try {
    const c = JSON.parse(await fs.readFile(USER_CATALOG(), 'utf8'))
    if (Array.isArray(c?.files)) files = c.files.filter((f: any) => typeof f?.path === 'string')
  } catch { /* first run, or a broken file: rebuilt below */ }
  const byPath = new Map(files.map((f) => [f.path, f]))
  const next: UserCatalogEntry[] = []
  let changed = false
  const dirs = (await fs.readdir(rootDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  for (const fam of dirs) {
    for (const name of (await fs.readdir(join(rootDir, fam))).filter((f) => SOUND_EXT.test(f)).sort()) {
      const rel = `${fam}/${name}`
      const abs = join(rootDir, fam, name)
      const st = await fs.stat(abs)
      const old = byPath.get(rel)
      if (old && old.v === SFX_ANALYSIS_VERSION && old.size === st.size &&
          Math.round(old.mtimeMs) === Math.round(st.mtimeMs)) {
        next.push(old)
        continue
      }
      try {
        const { features, labels } = await analyzeSoundFile(abs)
        next.push({
          path: rel, v: SFX_ANALYSIS_VERSION, size: st.size, mtimeMs: Math.round(st.mtimeMs),
          duration: features.duration, hit: features.hit, labels, features: { ...features },
          uses: old?.uses ?? [], tags: old?.tags ?? [], note: old?.note
        })
        changed = true
      } catch (err) {
        console.warn(`[kadr] sound analysis failed: ${abs}`, err)
      }
    }
  }
  if (changed || next.length !== files.length) {
    const tmp = `${USER_CATALOG()}.part`
    await fs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, files: next }, null, 1) + '\n')
    await fs.rename(tmp, USER_CATALOG())
  }
  return next.map((f) => ({
    id: `user:${f.path}`,
    path: join(rootDir, f.path),
    family: f.path.split('/')[0],
    origin: 'user' as const,
    duration: f.duration,
    hit: f.hit,
    brightness: f.labels.brightness,
    hfRisk: f.labels.hfRisk,
    envelope: f.labels.envelope,
    labelledBy: 'kadr' as const,
    tags: f.tags ?? [],
    uses: f.uses ?? [],
    note: f.note
  }))
}

/**
 * Describe one of the USER's sounds: what it is good for, tags, a short note.
 * Bundled sounds are not editable (their labels come from /brag). Kept in the
 * user catalogue and carried across re-analysis. Returns the updated entry.
 */
export async function setUserSoundMeta(id: string, meta: { uses?: unknown; tags?: unknown; note?: unknown }): Promise<SfxEntry> {
  if (typeof id !== 'string' || !id.startsWith('user:')) throw new Error('only the user\'s own sounds (id "user:…") can be described')
  const rel = id.slice(5)
  await userSounds() // make sure the catalogue knows the file
  const c = JSON.parse(await fs.readFile(USER_CATALOG(), 'utf8'))
  const f = (c.files as UserCatalogEntry[]).find((x) => x.path === rel)
  if (!f) throw new Error(`no such sound: ${id}`)
  const words = (v: unknown, max: number) => (Array.isArray(v)
    ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, max)
    : undefined)
  const uses = words(meta.uses, 8)
  const tags = words(meta.tags, 12)
  if (uses) f.uses = uses
  if (tags) f.tags = tags
  if (typeof meta.note === 'string') f.note = meta.note.trim().slice(0, 240) || undefined
  const tmp = `${USER_CATALOG()}.part`
  await fs.writeFile(tmp, JSON.stringify({ schemaVersion: 1, files: c.files }, null, 1) + '\n')
  await fs.rename(tmp, USER_CATALOG())
  const lib = await soundLibrary(true)
  return lib.sfx.find((s) => s.id === id)!
}

let cached: SoundLibrary | null = null
let building: Promise<SoundLibrary> | null = null

export function soundLibrary(rescan = false): Promise<SoundLibrary> {
  if (cached && !rescan) return Promise.resolve(cached)
  if (!building) {
    building = buildLibrary().then((lib) => {
      cached = lib
      return lib
    }).finally(() => { building = null })
  }
  return building
}

async function buildLibrary(): Promise<SoundLibrary> {
  const root = RESOURCES()
  const sfxRoot = join(root, 'sfx')
  const analysed = new Map<string, any>()
  try {
    const a = JSON.parse(await fs.readFile(join(sfxRoot, 'sfx-analysis.json'), 'utf8'))
    for (const f of a.files ?? []) if (typeof f?.path === 'string') analysed.set(f.path, f)
  } catch { /* the analysis is optional: entries fall back to ours */ }
  // ours: the hit of every bundled sound, labels for those /brag did not analyse
  const ours = new Map<string, any>()
  try {
    const k = JSON.parse(await fs.readFile(join(sfxRoot, 'kadr-sfx.json'), 'utf8'))
    for (const f of k.files ?? []) if (typeof f?.path === 'string') ours.set(f.path, f)
  } catch { /* regenerate with scripts/gen-sfx-catalog.mjs */ }
  const sfx: SfxEntry[] = []
  for (const family of (await fs.readdir(sfxRoot, { withFileTypes: true })).filter((d) => d.isDirectory())) {
    const files = (await fs.readdir(join(sfxRoot, family.name))).filter((f) => SOUND_EXT.test(f)).sort()
    for (const file of files) {
      const id = `${family.name}/${file}`
      const path = join(sfxRoot, family.name, file)
      const a = analysed.get(id)
      const k = ours.get(id)
      const typing = family.name === 'keyboard'
      sfx.push({
        id, path, family: family.name, origin: 'bundled',
        duration: Number(a?.duration ?? k?.duration) || 0,
        hit: Number(k?.hit) || 0,
        brightness: a?.labels?.brightness ?? k?.labels?.brightness,
        hfRisk: a?.labels?.highFrequencyRisk ?? k?.labels?.hfRisk,
        envelope: a?.labels?.envelopeShape ?? k?.labels?.envelope,
        labelledBy: a ? 'brag' : 'kadr',
        tags: Array.isArray(a?.labels?.tags) ? a.labels.tags : typing ? ['keypress'] : [],
        uses: Array.isArray(a?.labels?.suggestedUses) ? a.labels.suggestedUses : typing ? ['typing'] : []
      })
    }
  }
  sfx.push(...await userSounds())
  let music: MusicEntry[] = []
  try {
    const t = JSON.parse(await fs.readFile(join(root, 'music', 'tracks.json'), 'utf8'))
    music = (t.tracks ?? []).map((x: any) => ({
      id: String(x.file),
      path: join(root, 'music', String(x.file)),
      name: String(x.name ?? x.file),
      descRu: String(x.descRu ?? ''),
      descEn: String(x.descEn ?? ''),
      duration: Number(x.duration) || 0,
      tempo: Number(x.tempo) || 0,
      author: String(x.author ?? ''),
      license: String(x.license ?? '')
    }))
  } catch { /* no music folder: an empty list, not an error */ }
  return { root, userRoot: USER_SFX(), sfx, music, credits: join(root, 'CREDITS.md') }
}

// one analysis at a time: two dialogs must not race ffmpeg on the CPU
let chain: Promise<unknown> = Promise.resolve()

export function registerSoundsIpc() {
  ipcMain.handle('audio:analyze', (_e, req: AnalyzeRequest) => {
    const job = chain.then(() => analyzeRange(req))
    chain = job.catch(() => undefined)
    return job
  })
  ipcMain.handle('sounds:library', (_e, rescan?: boolean) => soundLibrary(!!rescan))
  ipcMain.handle('sounds:set-meta', (_e, id: string, meta: { uses?: unknown; tags?: unknown; note?: unknown }) =>
    setUserSoundMeta(id, meta ?? {}))
}
