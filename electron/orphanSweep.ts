/**
 * Which processes a startup sweep may kill on Windows. Pure, so a node check
 * can feed it recorded process lists (scripts/check-sweep-match.mjs).
 *
 * Windows has no process groups and no /proc: the list comes from one
 * `Get-CimInstance Win32_Process` call (WIN_PROCESS_QUERY). A process is
 * Kadr's orphan when its command line carries one of Kadr's paths AND the
 * process that spawned it is gone — pid missing, or reused by a process born
 * after it. The second condition is what keeps a user's own node or ffmpeg
 * working in the same folders alive, and a second, live Kadr's helpers too:
 * their parent is still running. Killing an orphan with `taskkill /T` takes
 * its descendants along (remotion's Chrome is a child of the orphan, not an
 * orphan itself).
 */
export interface WinProc {
  pid: number
  ppid: number
  /** creation time, ms (any epoch, only compared) */
  created: number
  cmd: string | null
}

/** one line of PowerShell → JSON [{pid, ppid, created, cmd}]; UTF-8 so non-ASCII paths still match */
export const WIN_PROCESS_QUERY =
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { ' +
  '[pscustomobject]@{ pid=$_.ProcessId; ppid=$_.ParentProcessId; ' +
  'created=$(if($_.CreationDate){[math]::Floor($_.CreationDate.ToFileTimeUtc()/10000)}else{0}); cmd=$_.CommandLine } } ' +
  '| ConvertTo-Json -Compress'

/** Windows paths: case-insensitive, either slash, sometimes quoted */
const norm = (s: string) => s.toLowerCase().replace(/\//g, '\\')

/** pids to kill with `taskkill /T /F` — never `self` or one of its ancestors */
export function pickWinOrphans(procs: WinProc[], marks: string[], self: number): number[] {
  const byPid = new Map(procs.map((p) => [p.pid, p]))
  const safe = new Set<number>()
  for (let cur = byPid.get(self), i = 0; cur && i < 64 && !safe.has(cur.pid); i++) {
    safe.add(cur.pid)
    const up = byPid.get(cur.ppid)
    cur = up && up.created <= cur.created ? up : undefined
  }
  const m = marks.filter(Boolean).map(norm)
  const out: number[] = []
  for (const p of procs) {
    if (safe.has(p.pid) || !p.cmd) continue
    const cmd = norm(p.cmd)
    if (!m.some((k) => cmd.includes(k))) continue
    const parent = byPid.get(p.ppid)
    if (parent && parent.created <= p.created) continue // its spawner is alive
    out.push(p.pid)
  }
  return out
}

/** the JSON WIN_PROCESS_QUERY prints (one object when there is one process) */
export function parseWinProcs(json: string): WinProc[] {
  const v = JSON.parse(json.replace(/^﻿/, '').trim() || '[]')
  return (Array.isArray(v) ? v : [v]).map((p) => ({
    pid: Number(p.pid), ppid: Number(p.ppid), created: Number(p.created) || 0, cmd: p.cmd ?? null
  }))
}
