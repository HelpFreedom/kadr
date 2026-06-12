// Subtitle utilities: SRT parse/serialize and the transcription flow shared
// by the UI dialog and the kadr MCP tool (window.kadrEditor.transcribe).
import type {
  Project, SubCue, TextDoc, TranscribeResult, TranscribeSegment, AudioSegment
} from '@shared/types'
import { useEditor, uid } from '@/state/store'
import { overlapFades } from './player'
import { evalAnim } from './anim'

// ------------------------------------------------------------------ SRT

const pad = (n: number, w: number) => String(n).padStart(w, '0')

export function srtTime(t: number): string {
  const ms = Math.max(0, Math.round(t * 1000))
  const h = Math.floor(ms / 3600000)
  const m = Math.floor((ms % 3600000) / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`
}

export function parseSrtTime(s: string): number {
  const m = s.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!m) return 0
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
}

export function cuesToSrt(cues: SubCue[]): string {
  return cues
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text.trim()}\n`)
    .join('\n') + (cues.length ? '' : '')
}

export function parseSrt(content: string): SubCue[] {
  const cues: SubCue[] = []
  const blocks = content.replace(/\r/g, '').split(/\n\n+/)
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim() !== '')
    if (!lines.length) continue
    let i = 0
    if (/^\d+$/.test(lines[0].trim())) i = 1 // index line is optional
    const tm = lines[i]?.match(/(\S+)\s+-->\s+(\S+)/)
    if (!tm) continue
    cues.push({
      start: parseSrtTime(tm[1]),
      end: parseSrtTime(tm[2]),
      text: lines.slice(i + 1).join('\n')
    })
  }
  return cues
}

/**
 * Segments → cues, shifting all times by `offset` seconds.
 * `maxWords` > 0 re-cuts the text into short cues of at most that many
 * words using the word-level timestamps (Remotion-grade timing): groups
 * never bridge sentence ends or pauses > 0.6 s, and words are distributed
 * evenly so no one-word orphans trail a long phrase.
 */
export interface RichCue {
  start: number
  end: number
  text: string
  /** word-level timing inside the cue (animated captions feed on this) */
  words: { word: string; start: number; end: number }[]
}

export function segmentsToRichCues(
  segments: TranscribeSegment[],
  offset = 0,
  maxWords = 0
): RichCue[] {
  if (!maxWords) {
    return segments.map((s) => ({
      start: Math.max(0, s.start + offset),
      end: Math.max(0, s.end + offset),
      text: s.text,
      words: (s.words ?? []).map((w) => ({
        word: w.word.trim(),
        start: Math.max(0, w.start + offset),
        end: Math.max(0, w.end + offset)
      }))
    }))
  }
  const cues: RichCue[] = []
  const flushRun = (run: { start: number; end: number; word: string }[]) => {
    if (!run.length) return
    // balanced chunks: 7 words at max 3 become 3+2+2, never 3+3+1
    const n = Math.ceil(run.length / maxWords)
    const base = Math.floor(run.length / n)
    let extra = run.length % n
    for (let i = 0; i < run.length; ) {
      const size = base + (extra > 0 ? 1 : 0)
      if (extra > 0) extra--
      const part = run.slice(i, i + size)
      i += size
      cues.push({
        start: Math.max(0, part[0].start + offset),
        end: Math.max(0, part[part.length - 1].end + offset),
        text: part.map((w) => w.word).join('').trim(),
        words: part.map((w) => ({
          word: w.word.trim(),
          start: Math.max(0, w.start + offset),
          end: Math.max(0, w.end + offset)
        }))
      })
    }
  }
  for (const seg of segments) {
    const raw = seg.words?.filter((w) => w.word.trim() !== '') ?? []
    // whisper splits compounds into continuation tokens without a leading
    // space ("мини" + "-программами") — glue them back into one word
    const words: { start: number; end: number; word: string }[] = []
    for (const w of raw) {
      const prev = words[words.length - 1]
      if (prev && !w.word.startsWith(' ')) {
        prev.word += w.word
        prev.end = w.end
      } else {
        words.push({ start: w.start, end: w.end, word: w.word })
      }
    }
    if (!words.length) {
      cues.push({
        start: Math.max(0, seg.start + offset),
        end: Math.max(0, seg.end + offset),
        text: seg.text,
        words: []
      })
      continue
    }
    let run: { start: number; end: number; word: string }[] = []
    for (const w of words) {
      // a pause before this word ends the current run
      if (run.length && w.start - run[run.length - 1].end > 0.6) {
        flushRun(run)
        run = []
      }
      run.push({ start: w.start, end: w.end, word: w.word })
      // sentence-ending punctuation ends the run after the word
      if (/[.!?…]"?\s*$/.test(w.word)) {
        flushRun(run)
        run = []
      }
    }
    flushRun(run)
  }
  return cues
}

/** SRT-grade cues (text only) — same grouping as segmentsToRichCues. */
export function segmentsToCues(
  segments: TranscribeSegment[],
  offset = 0,
  maxWords = 0
): SubCue[] {
  return segmentsToRichCues(segments, offset, maxWords).map((c) => ({
    start: c.start,
    end: c.end,
    text: c.text
  }))
}

export function cuesToTxt(cues: SubCue[]): string {
  return cues.map((c) => c.text.trim()).join('\n')
}

// ------------------------------------------------- audio collection (range)

/**
 * Everything audible in [start, end), as ffmpeg mix segments shifted so the
 * mixdown starts at 0 — the same flattening exports use.
 */
export function collectRangeAudio(project: Project, start: number, end: number): AudioSegment[] {
  const segs: AudioSegment[] = []
  for (const track of project.tracks) {
    if (track.muted) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'media' || clip.muted) continue
      const asset = project.assets.find((a) => a.id === clip.assetId)
      if (!asset?.hasAudio) continue
      const speed = clip.speed || 1
      const span = Math.max(0.05, asset.duration - clip.inPoint)
      const from = Math.max(clip.start, start)
      const to = Math.min(clip.start + clip.duration, end)
      if (to - from < 0.001) continue
      const gain = evalAnim(clip.gain, 0) * track.gain
      const { fadeIn, fadeOut } = overlapFades(track, clip)
      let local = from - clip.start
      const localEnd = to - clip.start
      while (local < localEnd - 0.001) {
        const srcOff = (local * speed) % span
        const untilWrap = (span - srcOff) / speed
        const segDur = Math.min(untilWrap, localEnd - local)
        const fiLocal = local < fadeIn ? Math.min(fadeIn - local, segDur) : 0
        const tail = clip.duration - (local + segDur)
        const foLocal = tail < fadeOut ? Math.min(fadeOut - tail, segDur) : 0
        segs.push({
          path: asset.path,
          inPoint: clip.inPoint + srcOff,
          duration: segDur * speed,
          start: clip.start + local - start,
          gain,
          speed,
          fadeIn: fiLocal,
          fadeOut: foLocal
        })
        local += segDur
      }
    }
  }
  return segs
}

// --------------------------------------------------------------- the flow

export interface TranscribeFlowOpts {
  /** 'asset' = whole media file; 'range' = timeline fragment mixdown */
  target: { kind: 'asset'; assetId: string } | { kind: 'range'; start: number; end: number }
  model?: string
  language?: string
  /** range docs: 'absolute' = project timecodes, 'relative' = from range start */
  timecodes?: 'absolute' | 'relative'
  /** words per cue (1–4 = short precise cues, 0 = whole phrases); default 3 */
  maxWords?: number
}

export interface TranscribeFlowResult {
  doc: TextDoc
  txtDoc: TextDoc
  srtPath: string
  txtPath: string
  segments: TranscribeSegment[]
  language: string
}

const sanitize = (s: string) => s.replace(/[^\p{L}\p{N}._ -]/gu, '').trim() || 'transcript'

/** Pick a free path: base.srt, base.1.srt, base.2.srt… (don't clobber). */
async function freePath(base: string, ext: string, takenOk: string[]): Promise<string> {
  for (let i = 0; i < 100; i++) {
    const p = i === 0 ? `${base}.${ext}` : `${base}.${i}.${ext}`
    if (takenOk.includes(p)) return p // re-transcription of the same doc — overwrite
    if ((await window.kadr.statFile(p)) === null) return p
  }
  return `${base}.${Date.now()}.${ext}`
}

/**
 * Transcribe an asset or a timeline range: mixdown → whisper → SRT + TXT
 * next to the (dominant) source media, registered as project text docs.
 */
export async function transcribeFlow(opts: TranscribeFlowOpts): Promise<TranscribeFlowResult> {
  const st = () => useEditor.getState()
  const project = st().project
  const model = opts.model || 'large-v3'
  const language = opts.language || 'auto'

  let audioSegments: AudioSegment[]
  let duration: number
  let cueOffset: number // added to whisper times when writing the files
  let baseDir: string
  let baseName: string
  let assetId: string | undefined
  let docOffset: number | undefined

  if (opts.target.kind === 'asset') {
    const asset = project.assets.find((a) => a.id === (opts.target as { assetId: string }).assetId)
    if (!asset) throw new Error('asset not found')
    if (!asset.hasAudio) throw new Error('asset has no audio')
    audioSegments = [{
      path: asset.path, inPoint: 0, duration: asset.duration,
      start: 0, gain: 1, speed: 1, fadeIn: 0, fadeOut: 0
    }]
    duration = asset.duration
    cueOffset = 0 // cue times = source-media times
    assetId = asset.id
    baseDir = asset.path.replace(/\/[^/]*$/, '')
    baseName = sanitize(asset.name.replace(/\.[^.]+$/, ''))
  } else {
    const { start, end } = opts.target
    if (!(end > start)) throw new Error('empty range')
    audioSegments = collectRangeAudio(project, start, end)
    if (!audioSegments.length) throw new Error('no audible audio in range')
    duration = end - start
    const absolute = opts.timecodes !== 'relative'
    cueOffset = absolute ? start : 0
    docOffset = absolute ? 0 : start
    // dominant source: the segment covering the most of the range
    const byDur = [...audioSegments].sort((a, b) => b.duration - a.duration)[0]
    baseDir = byDur.path.replace(/\/[^/]*$/, '')
    const mm = (t: number) => `${Math.floor(t / 60)}m${pad(Math.round(t % 60), 2)}s`
    baseName = `${sanitize(project.name)}_${mm(start)}-${mm(end)}`
  }

  const result: TranscribeResult = await window.kadr.transcribe({
    audioSegments, duration, model, language
  })

  const cues = segmentsToCues(result.segments, cueOffset, opts.maxWords ?? 3)
  const known = (st().project.texts ?? []).map((t) => t.path)
  const srtPath = await freePath(`${baseDir}/${baseName}`, 'srt', known)
  const txtPath = await freePath(`${baseDir}/${baseName}`, 'txt', known)
  await window.kadr.writeTextFile(srtPath, cuesToSrt(cues))
  await window.kadr.writeTextFile(txtPath, cuesToTxt(cues))

  const mkDoc = (path: string, format: 'srt' | 'txt'): TextDoc => ({
    id: uid(),
    name: path.split('/').pop()!,
    path,
    format,
    assetId,
    offset: docOffset,
    language: result.language
  })
  const doc = mkDoc(srtPath, 'srt')
  const txtDoc = mkDoc(txtPath, 'txt')
  st().addTexts([doc, txtDoc])
  return { doc, txtDoc, srtPath, txtPath, segments: result.segments, language: result.language }
}

/** Project-time second a cue time of `doc` corresponds to (for seeking). */
export function docTimeToProject(project: Project, doc: TextDoc, t: number): number | null {
  if (doc.offset !== undefined) return doc.offset + t
  if (doc.assetId) {
    // cue times are source times: map through the first clip using the asset
    for (const track of project.tracks) {
      for (const clip of track.clips) {
        if (clip.assetId !== doc.assetId) continue
        const speed = clip.speed || 1
        const rel = (t - clip.inPoint) / speed
        if (rel >= -0.5 && rel <= clip.duration + 0.5) {
          return clip.start + Math.max(0, Math.min(clip.duration, rel))
        }
      }
    }
    // asset not on the timeline (or cue outside every clip) — no mapping
    return null
  }
  return t
}
