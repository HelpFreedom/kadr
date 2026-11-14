// NVENC detection for the H.264 encodes Kadr runs through the system ffmpeg
// (the export's raw-frame encode and the decode-proxy transcode). An ffmpeg
// that LISTS h264_nvenc proves nothing — without an NVIDIA card or with an
// old driver the encoder fails on open — so a one-frame test encode decides,
// once per process. KADR_NVENC=0 forces libx264.
import { spawnSync } from 'child_process'

let cached: boolean | null = null

export function hasNvenc(ffmpeg: string): boolean {
  if (cached !== null) return cached
  if (process.env.KADR_NVENC === '0') return (cached = false)
  const r = spawnSync(ffmpeg, [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=black:s=256x256:r=25:d=0.04',
    '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-'
  ], { timeout: 15000, windowsHide: true })
  cached = r.status === 0
  return cached
}
