// Copied FILES on the clipboard → local paths (the Ctrl+V intake).
// Test: node scripts/check-fileurl.mjs
import { execFile } from 'child_process'
import { fileURLToPath } from 'url'

/** text/uri-list → paths. fileURLToPath, never `URL.pathname`: that gives
 *  "/C:/x" for a Windows drive and drops a UNC host. */
export function uriListToPaths(list: string): string[] {
  const out: string[] = []
  for (const line of list.split(/\r?\n/)) {
    const u = line.trim()
    if (!u.startsWith('file://')) continue
    try { out.push(fileURLToPath(u)) } catch { /* malformed */ }
  }
  return out
}

/** Windows: Explorer puts copied files in CF_HDROP, which Electron cannot
 *  read as a list — `clipboard.read('text/uri-list')` is "" even while
 *  availableFormats() names it, and the 'FileNameW' buffer holds only the
 *  first file. PowerShell's FileDropList has them all (~1 s, so the caller
 *  asks only when a file drop is on the clipboard). [] on any failure. */
export function readWinFileDrop(): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      '[Console]::OutputEncoding=[Text.Encoding]::UTF8; (Get-Clipboard -Format FileDropList).FullName'],
    { windowsHide: true, timeout: 10000, encoding: 'utf8' },
    (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)))
  })
}
