// Where an export keeps its intermediate video while it runs — main's mux
// input (electron/main.ts) and the direct encoder's stream (electron/preload.ts).
//
// It used to be the system temp folder, and on many Linux systems /tmp is a
// tmpfs: RAM. A video intermediate is the size of the export itself — 300 MB a
// minute at the 4K preset's 40 Mbit/s, so a 26-minute film needs ~7.8 GB — and
// on this machine /tmp is 7.7 GB in all: a long export died near the end with
// ENOSPC, or held gigabytes of memory while it ran (reported in
// HelpFreedom/kadr#17). It now goes NEXT TO THE OUTPUT: that disk has to hold
// the result anyway, the file is removed as before when the export ends or is
// cancelled, and a video kept after a failed mux sits where the user was
// looking for it. A folder that cannot be written falls back to the temp folder.
//
// The names keep their `kadr-export-` prefix: sweepStaleSessions finds a
// hard-killed run's leftover encoder by it (electron/claude.ts).
import { dirname, join } from 'path'

export function exportTempPath(
  outputPath: string | undefined,
  kind: 'mux' | 'raw',
  tmp: string,
  writable: (dir: string) => boolean,
  now = Date.now()
): string {
  const name = `${kind === 'raw' ? 'kadr-export-raw' : 'kadr-export'}-${now}.mp4`
  const dir = outputPath ? dirname(outputPath) : ''
  return join(dir && writable(dir) ? dir : tmp, name)
}
