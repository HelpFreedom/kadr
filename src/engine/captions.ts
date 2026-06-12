// Auto-captions: one click turns speech in a timeline range into an animated
// Remotion caption fragment — word-precise timing baked into generated TSX,
// position/size then adjusted with the mouse via the fragment gizmo.
import { useEditor, projectDuration } from '@/state/store'
import { transcribeFlow, segmentsToRichCues, type RichCue } from './subtitles'
import { createFragment } from './fragments'

export interface CaptionStyle {
  fontFamily: string
  fontSize: number // px in the composition
  bold: boolean
  color: string
  highlightColor: string
  entrance: 'pop' | 'fade' | 'rise' | 'none'
  highlight: 'color' | 'pop' | 'box' | 'none'
  /** animation speed multiplier, 0.5..2 */
  speed: number
}

export const CAPTION_DEFAULTS: CaptionStyle = {
  fontFamily: 'sans-serif',
  fontSize: 64,
  bold: true,
  color: '#ffffff',
  highlightColor: '#ffd23f',
  entrance: 'pop',
  highlight: 'color',
  speed: 1
}

/** The generated composition module (cues and style baked in). */
export function captionsTsx(cues: RichCue[], style: CaptionStyle): string {
  return `import React from 'react'
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion'
import meta from './meta.json'

// Auto-generated captions (Kadr). Word-precise timings from faster-whisper.
// Safe to edit by hand or by Claude — the preview hot-reloads.

const CUES = ${JSON.stringify(
    cues.map((c) => ({
      s: +c.start.toFixed(3),
      e: +c.end.toFixed(3),
      w: c.words.map((w) => ({ t: w.word, s: +w.start.toFixed(3), e: +w.end.toFixed(3) }))
    }))
  )}

const S = ${JSON.stringify(style)}

const easeOutBack = (p: number) => {
  const c = 1.70158
  const q = p - 1
  return 1 + (c + 1) * q * q * q + c * q * q
}
const clamp01 = (v: number) => Math.max(0, Math.min(1, v))

const Frag: React.FC = () => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = frame / fps
  const cue = CUES.find((c) => t >= c.s && t < c.e)
  if (!cue) return null

  // cue entrance, sped up by S.speed
  const et = (t - cue.s) * S.speed
  let op = 1
  let scale = 1
  let dy = 0
  if (S.entrance === 'fade') op = clamp01(et / 0.18)
  else if (S.entrance === 'pop') {
    op = clamp01(et / 0.1)
    scale = 0.6 + 0.4 * easeOutBack(clamp01(et / 0.22))
  } else if (S.entrance === 'rise') {
    const p = clamp01(et / 0.25)
    op = p
    dy = (1 - p) * (2 - p) * 30
  }

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center' }}>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          columnGap: '0.28em',
          justifyContent: 'center',
          maxWidth: '82%',
          textAlign: 'center',
          fontFamily: S.fontFamily,
          fontSize: S.fontSize,
          fontWeight: S.bold ? 800 : 400,
          lineHeight: 1.25,
          color: S.color,
          opacity: op,
          transform: \`translateY(\${dy}px) scale(\${scale})\`,
          textShadow: '0 2px 14px rgba(0,0,0,0.85), 0 0 4px rgba(0,0,0,0.7)'
        }}
      >
        {cue.w.map((w, i) => {
          const on = t >= w.s // karaoke fill: spoken words stay lit
          const active = t >= w.s && t < w.e
          const wp = active ? clamp01(((t - w.s) * S.speed) / 0.14) : 1
          const st: React.CSSProperties = {}
          if (S.highlight === 'color' && on) st.color = S.highlightColor
          if (S.highlight === 'pop') {
            if (active) st.transform = \`scale(\${1 + 0.18 * easeOutBack(wp)})\`
            if (on) st.color = S.highlightColor
          }
          if (S.highlight === 'box' && active) {
            st.background = S.highlightColor
            st.color = '#101014'
            st.borderRadius = '0.18em'
            st.padding = '0 0.18em'
          }
          return (
            <span key={i} style={{ display: 'inline-block', ...st }}>
              {w.t}
            </span>
          )
        })}
      </div>
    </AbsoluteFill>
  )
}

export const fragment = { component: Frag, meta }
`
}

export interface AutoCaptionsOpts {
  /** null = whole timeline */
  range: { start: number; end: number } | null
  style: CaptionStyle
  /** words per caption, 1..4 */
  maxWords: number
  model?: string
  language?: string
}

/**
 * Transcribe the target and drop an animated caption fragment over it.
 * Returns the created clip id (selected, gizmo-ready) and the cue count.
 */
export async function autoCaptions(opts: AutoCaptionsOpts) {
  const st = () => useEditor.getState()
  const project = st().project
  const start = opts.range?.start ?? 0
  const end = opts.range?.end ?? projectDuration(project)
  if (!(end > start)) throw new Error('empty target')

  const flow = await transcribeFlow({
    target: { kind: 'range', start, end },
    model: opts.model,
    language: opts.language,
    timecodes: 'relative',
    maxWords: opts.maxWords
  })
  const cues = segmentsToRichCues(flow.segments, 0, opts.maxWords)
  if (!cues.length) throw new Error('no speech recognized in the target')

  const frag = await createFragment({
    name: 'captions',
    start,
    end,
    transparent: true
  })
  await window.kadr.writeTextFile(frag.entry, captionsTsx(cues, opts.style))
  // captions live in the lower third by default; the gizmo moves them
  const clip = st().project.tracks.flatMap((t) => t.clips).find((c) => c.id === frag.clipId)
  if (clip) {
    st().updateClip(clip.id, {
      transform: { ...clip.transform, y: { value: Math.round(project.height * 0.3) } }
    })
    st().select([clip.id])
  }
  return { clipId: frag.clipId, fragmentId: frag.id, cues: cues.length, srtPath: flow.srtPath }
}
