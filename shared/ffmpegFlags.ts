// Command-line spellings that differ between ffmpeg releases.
// Pure, so scripts/check-ffmpegflags.mjs tests it on known version strings.

export type FilterFileFlag = '-/filter_complex' | '-filter_complex_script'

/**
 * How to hand ffmpeg a filter graph that lives in a FILE (the export's audio
 * graph always does: with a thousand clips it passes Linux's 128 KB limit on
 * one argument). ffmpeg 7.0 added the generic `-/<option> <file>` form and
 * deprecated `-filter_complex_script`; ffmpeg 9 no longer has the old option,
 * and ffmpeg 6 and older know only the old one — Ubuntu 22.04 ships 4.4 and
 * 24.04 ships 6.1. `versionOutput` is what `ffmpeg -version` prints. A build
 * without a numbered release (`N-112345-g…`, `git-…`) is one from the
 * development branch, i.e. newer than any release, so it takes the new form.
 */
export function filterFileFlag(versionOutput: string): FilterFileFlag {
  const m = /ffmpeg version\s+n?(\d+)\.\d+/i.exec(versionOutput)
  if (!m) return '-/filter_complex'
  return Number(m[1]) >= 7 ? '-/filter_complex' : '-filter_complex_script'
}

/**
 * "Pass every decoded frame through as it is" (no duplicating or dropping to a
 * constant rate). `-fps_mode` arrived in ffmpeg 5.1 and replaced `-vsync`,
 * which ffmpeg 9 no longer has; ffmpeg 5.0 and older know only `-vsync`.
 * Undated development builds take the new form, as above.
 */
export function passthroughFrameArgs(versionOutput: string): [string, string] {
  const m = /ffmpeg version\s+n?(\d+)\.(\d+)/i.exec(versionOutput)
  const modern = !m || Number(m[1]) > 5 || (Number(m[1]) === 5 && Number(m[2]) >= 1)
  return modern ? ['-fps_mode', 'passthrough'] : ['-vsync', 'passthrough']
}

/** the major release in `ffmpeg -version` output; Infinity for a development build or no answer */
export function ffmpegMajor(versionOutput: string): number {
  const m = /ffmpeg version\s+n?(\d+)\.\d+/i.exec(versionOutput)
  return m ? Number(m[1]) : Infinity
}

/** colormatrix's own name for an ffprobe colour space; null = it has no such matrix */
export function colormatrixName(space: string): string | null {
  if (space === 'bt2020nc' || space === 'bt2020c') return 'bt2020'
  return ['bt709', 'fcc', 'bt601', 'bt470', 'bt470bg', 'smpte170m', 'smpte240m', 'bt2020'].includes(space) ? space : null
}

/**
 * The packed alpha intermediate's colour step: the picture → BT.709 limited,
 * a pure matrix change ('' = nothing to do, the samples are copied).
 *
 * swscale's own matrix change (`scale=in_color_matrix=…`) was measured on
 * ffmpeg 9 against a float BT.601→BT.709 reference: up to 2.5 levels off on
 * in-gamut colours, and neutral grey 126,128,128 → 125,128,127. colormatrix
 * lands within 0.64 and keeps grey exact. Releases before 8 keep the swscale
 * step they were checked with — nothing here can measure them. A BT.709
 * source needs no conversion at all.
 */
export function packedColourChain(versionOutput: string, matrix: string): string {
  if (matrix === 'bt709') return ''
  const cm = colormatrixName(matrix)
  if (cm && ffmpegMajor(versionOutput) >= 8) return `colormatrix=${cm}:bt709`
  return `scale=in_color_matrix=${matrix}:out_color_matrix=bt709`
}
