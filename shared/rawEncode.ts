// ffmpeg argument builder for the raw-RGBA video encode, shared by the
// preload direct encoder (frames never leave the renderer process) and the
// main-process fallback. Input is WebGL readPixels output: bottom-up RGBA.
export interface RawEncodeOpts {
  /** raw input frame size — the compositor always renders at project size */
  width: number
  height: number
  /** target size when the preset differs from the project (fit + letterbox);
      omitted or equal → no resampling, output stays bit-identical to before */
  outWidth?: number
  outHeight?: number
  fps: number
  /** 'libx264' or a preset ffmpegVideo codec such as 'libvpx-vp9' */
  codec: string
  bitrate: number
  out: string
}

export function rawEncodeArgs(o: RawEncodeOpts): string[] {
  const b = Math.max(1_000_000, o.bitrate || 10_000_000)
  const ow = o.outWidth ?? o.width
  const oh = o.outHeight ?? o.height
  const vf = ow === o.width && oh === o.height
    ? 'vflip,scale=out_color_matrix=bt709:out_range=tv'
    // aspect-preserving fit, centered on black bars, even dims for yuv420p
    : `vflip,scale=${ow}:${oh}:out_color_matrix=bt709:out_range=tv` +
      ':force_original_aspect_ratio=decrease:force_divisible_by=2' +
      `,pad=${ow}:${oh}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`
  return [
    '-y', '-v', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgba',
    '-s', `${o.width}x${o.height}`, '-r', String(o.fps),
    '-i', 'pipe:0',
    '-vf', vf,
    ...(o.codec === 'libx264'
      ? ['-c:v', 'libx264', '-preset', 'faster',
         '-b:v', String(b), '-maxrate', String(Math.round(b * 1.6)), '-bufsize', String(b * 3)]
      : ['-c:v', o.codec, '-b:v', String(b),
         ...(o.codec === 'libvpx-vp9' ? ['-row-mt', '1', '-cpu-used', '4'] : [])]),
    '-pix_fmt', 'yuv420p',
    '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
    '-movflags', '+faststart',
    o.out
  ]
}
