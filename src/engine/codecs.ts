// Which video codecs this Chromium can decode by itself. Everything else
// (HEVC without a new-enough VAAPI, mpeg4, prores, …) renders 0×0 black in a
// <video> element and is rejected by WebCodecs — those sources go through a
// cached full-res ffmpeg H.264 intermediate for export, and always get a
// preview proxy regardless of size.
const CHROMIUM_DECODABLE = new Set(['h264', 'vp8', 'vp9', 'av1'])

/** Unknown codec (old projects probed before the field existed) → assume yes. */
export function chromiumCanDecode(codec: string | undefined): boolean {
  return !codec || CHROMIUM_DECODABLE.has(codec)
}
