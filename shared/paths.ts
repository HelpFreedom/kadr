// Separator-tolerant path helpers for the renderer: asset paths are OS paths
// (`/` on Linux/macOS, `\` on Windows), and node's `path` is not available
// there. Naive `/`-only parsing left Windows paths whole — the transcriber
// then treated `D:\dir\Video.mp4` as a directory and ENOENT'd (issue #6).
export function dirOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  if (i < 0) return '.'
  if (i === 0) return p.slice(0, 1)
  return p.slice(0, i)
}

export function baseOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i >= 0 ? p.slice(i + 1) : p
}
