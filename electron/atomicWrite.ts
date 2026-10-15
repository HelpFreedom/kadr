import { promises as fs } from 'fs'
import { join } from 'path'

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Remove the `<name>.part-<pid>` sidecars in `dir` (starting with `prefix`) that
 * a killed process left behind — a crash mid-write leaves one, full size, next
 * to the file it was replacing. A sidecar whose writer is still alive is kept.
 */
export async function sweepPartSidecars(dir: string, prefix = ''): Promise<void> {
  let names: string[]
  try { names = await fs.readdir(dir) } catch { return }
  for (const n of names) {
    const m = /\.part-(\d+)$/.exec(n)
    if (!m || !n.startsWith(prefix) || alive(Number(m[1]))) continue
    await fs.rm(join(dir, n), { force: true }).catch(() => {})
  }
}

const RETRY = new Set(['EPERM', 'EACCES', 'EBUSY'])

/**
 * Write a file so that a crash, a full disk or a locked target can never
 * leave it torn: `<path>.part-<pid>` is written and fsync'ed, then renamed
 * over the original. On failure the original is untouched and the sidecar
 * removed; the error propagates. Windows refuses a rename over a file some
 * other program holds open (antivirus, sync client) with EPERM/EBUSY, so the
 * rename is retried 3× with backoff before giving up.
 */
export async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const part = `${path}.part-${process.pid}`
  try {
    const fh = await fs.open(part, 'w')
    try {
      await fh.writeFile(data, typeof data === 'string' ? 'utf-8' : undefined)
      await fh.sync()
    } finally {
      await fh.close()
    }
    for (let i = 0; ; i++) {
      try {
        await fs.rename(part, path)
        return
      } catch (err) {
        if (i >= 3 || !RETRY.has((err as NodeJS.ErrnoException).code ?? '')) throw err
        await new Promise((r) => setTimeout(r, 100 * 2 ** i))
      }
    }
  } catch (err) {
    await fs.rm(part, { force: true }).catch(() => {})
    throw err
  }
}
