// Script preparation for speech synthesis. No node/electron imports: the whole
// contract here is "the pieces concatenate back to the original exactly", and
// that has to be checkable from plain node (see scripts/check-ttstext.mjs).

/**
 * CRLF and a stray BOM out, trailing spaces off, runs of blank lines squeezed.
 *
 * Whatever comes out of here is what gets synthesised AND what the defect
 * detector aligns against, so it is written to disk verbatim and never touched
 * again: ttsqc addresses defects by script word index, and a script that does
 * not match the audio byte for byte makes every one of those indices a lie.
 */
export function normalizeScript(text: string): string {
  return text.replace(/^﻿/, '').replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim() + '\n'
}

/** Offsets just past each match — the candidate cut points of one strength. */
function breakPoints(text: string, source: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(new RegExp(source, 'g'))) out.push(m.index + m[0].length)
  return out
}

/**
 * Cut a script into pieces no longer than `limit` characters, preferring the
 * strongest boundary available: paragraph break, then sentence end, then clause
 * punctuation, then any whitespace.
 *
 * Every character is kept — `pieces.map(p => text.slice(p.from, p.to)).join('')`
 * is the input again. That is what keeps ttsqc's character offsets valid, and
 * it is why nothing here trims.
 */
export function chunkText(text: string, limit: number): Array<{ from: number; to: number }> {
  if (limit <= 0) throw new Error('chunkText: limit must be positive')
  if (text.length <= limit) return [{ from: 0, to: text.length }]
  const levels = ['\\n\\s*\\n', '[.!?…]+["»”)]*\\s+', '[,;:—–]\\s+', '\\s+']
  const out: Array<{ from: number; to: number }> = []
  let from = 0
  while (from < text.length) {
    if (text.length - from <= limit) {
      out.push({ from, to: text.length })
      break
    }
    const window = text.slice(from, from + limit)
    let cut = -1
    for (const src of levels) {
      const pts = breakPoints(window, src)
      if (pts.length) {
        cut = pts[pts.length - 1]
        break
      }
    }
    // one unbroken run longer than the limit (a URL, a wall of digits): a hard
    // cut is the only option left, and losing a character would be worse
    if (cut <= 0) cut = limit
    out.push({ from, to: from + cut })
    from += cut
  }
  return out
}

/** End offsets of sentences, used for the mock voice and for tests. */
export function sentenceEnds(text: string): number[] {
  const out: number[] = []
  for (const m of text.matchAll(/[.!?…]+["»”)]*\s+/g)) out.push(m.index + m[0].length)
  return out
}
