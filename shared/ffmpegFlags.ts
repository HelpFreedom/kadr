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
