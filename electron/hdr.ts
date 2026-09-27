// HDR sources (a phone's HLG video, PQ from a camera) made watchable in SDR.
//
// An iPhone records HEVC 10-bit BT.2020 HLG; Chromium cannot decode HEVC here,
// so everything shown or exported goes through intermediates ffmpeg makes —
// and those used to copy the HLG signal into a plain BT.709 file: flat,
// greyish, colours off, the "why does my video look washed out" that a real
// project had to fix with a hand-made ffmpeg command.
//
// The conversion itself — a 3D LUT computed in closed form, since ffmpeg 4.3
// here has no zscale — is in shared/hdr.ts (checked by scripts/check-hdr.mjs).
import { app } from 'electron'
import { promises as fs, statSync } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { FFPROBE, FFMPEG, runStream } from './ffmpeg'
import { type HdrKind, HDR_VERSION, hdrOfTransfer, hdrCube, hdrFilter } from '@shared/hdr'

export { hdrOfTransfer, hdrFilter }
export type { HdrKind }

const execFileP = promisify(execFile)

const cache = new Map<string, HdrKind | null>()

/** The HDR transfer of a file's first video stream, or null (SDR / not video). */
export async function sourceHdr(path: string): Promise<HdrKind | null> {
  let key = path
  try { const st = statSync(path); key = `${path}:${st.size}:${Math.round(st.mtimeMs)}` } catch { return null }
  if (cache.has(key)) return cache.get(key)!
  let kind: HdrKind | null = null
  try {
    const { stdout } = await execFileP(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries',
      'stream=color_transfer', '-of', 'default=nw=1:nk=1', path])
    kind = hdrOfTransfer(stdout.trim())
  } catch { /* not probeable: treat as SDR */ }
  cache.set(key, kind)
  return kind
}

const LUT_SIZE = 33

/** The .cube file for a transfer (written once into userData/luts). */
export async function hdrLut(kind: HdrKind): Promise<string> {
  const dir = join(app.getPath('userData'), 'luts')
  const path = join(dir, `${kind}-to-sdr709-v${HDR_VERSION}.cube`)
  try { await fs.access(path); return path } catch { /* build it */ }
  await fs.mkdir(dir, { recursive: true })
  const tmp = `${path}.part-${process.pid}`
  await fs.writeFile(tmp, hdrCube(kind, LUT_SIZE))
  await fs.rename(tmp, path)
  return path
}

// ------------------------------------------------------- media for fragments

/**
 * A video made fit for a Remotion fragment's <Video>: upright (ffmpeg applies
 * the rotation), SDR BT.709 (an HDR source tone-mapped), H.264 with a keyframe
 * every 30 frames (a fragment seeks all the time — a phone's long GOP made
 * every seek decode seconds of frames), no bigger than `maxSide`, in
 * <project>/kadr-lib/media/<name>.mp4 — imported in the fragment as
 * '@lib/media/<name>.mp4'. Rebuilt only when the source changed.
 */
export async function fragmentMedia(src: string, projectDir: string, opts: { name?: string; maxSide?: number } = {},
  onProgress?: (p: number) => void): Promise<{ path: string; import: string; cached: boolean; hdr: HdrKind | null }> {
  if (!projectDir) throw new Error('видео для фрагментов хранится в папке проекта (kadr-lib/media) — сначала сохраните проект')
  const st = statSync(src)
  const base = (opts.name ?? src.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, ''))
    .normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'clip'
  const dir = join(projectDir, 'kadr-lib', 'media')
  await fs.mkdir(dir, { recursive: true })
  const out = join(dir, `${base}.mp4`)
  const stamp = join(dir, `${base}.source.json`)
  const maxSide = Math.max(240, Math.round(opts.maxSide ?? 1920))
  const ident = { source: src, size: st.size, mtime: Math.round(st.mtimeMs), maxSide, v: 1, hdr: HDR_VERSION }
  try {
    const old = JSON.parse(await fs.readFile(stamp, 'utf8'))
    if (JSON.stringify(old) === JSON.stringify(ident) && (await fs.stat(out)).size > 0) {
      return { path: out, import: `@lib/media/${base}.mp4`, cached: true, hdr: await sourceHdr(src) }
    }
  } catch { /* build it */ }
  const hdr = await sourceHdr(src)
  const vf = [
    ...(hdr ? [hdrFilter(await hdrLut(hdr))] : []),
    `scale='if(gt(iw,ih),min(${maxSide},iw),-2)':'if(gt(iw,ih),-2,min(${maxSide},ih))'`,
    'format=yuv420p'
  ].join(',')
  let duration = 0
  try {
    const { stdout } = await execFileP(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', src])
    duration = Number(stdout.trim()) || 0
  } catch { /* progress unknown */ }
  const tmp = join(dir, `${base}.part-${process.pid}.mp4`)
  try {
    await runStream(FFMPEG, ['-y', '-v', 'error', '-progress', 'pipe:1', '-i', src, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-g', '30', '-keyint_min', '30', '-sc_threshold', '0',
      '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', tmp], (chunk) => {
      const m = String(chunk).match(/out_time_us=(\d+)/g)
      if (m && duration > 0 && onProgress) onProgress(Math.min(1, Number(m[m.length - 1].split('=')[1]) / 1e6 / duration))
    })
    await fs.rename(tmp, out)
  } catch (e) {
    await fs.unlink(tmp).catch(() => {})
    throw e
  }
  await fs.writeFile(stamp, JSON.stringify(ident))
  return { path: out, import: `@lib/media/${base}.mp4`, cached: false, hdr }
}
