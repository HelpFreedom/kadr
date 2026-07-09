# Kadr — GPU-accelerated multi-track video editor

Electron + React + TypeScript. The preview is composited on the GPU
(WebGL2); export is WYSIWYG: the same compositor renders offline frames
into WebCodecs H.264, mp4-muxer writes a temp MP4, then the system ffmpeg
mixes audio and muxes/transcodes per preset.

## Commands
- `npm run dev` — launch in dev mode (Electron needs a display)
- `npm run build` — production build into `out/`
- `npm run typecheck` — both renderer (`tsconfig.web.json`) and main
  (`tsconfig.node.json`)
- `node scripts/e2eNN.mjs` — CDP smoke tests; first start the app with
  `npx electron-vite dev -- --remote-debugging-port=9777`; generate the
  test media with `scripts/gen-test-media.sh` (the older suites need it;
  newer suites create their own files in `/tmp/kadr-test`)

## Requirements
- Node.js ≥ 20, system `ffmpeg`/`ffprobe` in PATH
- Optional: `python3` + `faster-whisper` (speech-to-text), the `claude`
  CLI (embedded AI assistant), network access for the one-time Remotion
  workspace install

## Architecture
- `shared/types.ts` — the entire project model (Project/Track/Clip/Anim/
  Keyframe, TextDoc, FragmentSpec, ExportPreset/ExportJob, the `KadrApi`
  IPC surface). All times in seconds. `Anim` is a scalar that may carry
  keyframes; `evalAnim` interpolates. `tracks[0]` is the top video track
  (drawn last).
- `electron/main.ts` — window, `kadr://` streaming protocol with manual
  Range support, IPC: dialogs, project IO (incl. atomic autosave), export,
  user stores, proxy queue, reversed-media cache, media intake
  (`media:download` — browser-URL drops fetched into `userData/imported`,
  cached by URL hash; `media:save-blob` — path-less Files / data: URLs /
  clipboard images, cached by content hash; `media:portal-files` — XDG
  FileTransfer portal drops resolved over the session bus via gdbus;
  `media:clipboard-paste` — copied files or a copied image). A malformed
  `DBUS_SESSION_BUS_ADDRESS` in the launching environment silently breaks
  portal drops — main normalizes it to the live user socket at startup.
  The scheme MUST stay registered with `corsEnabled: true` (+ ACAO:*
  responses and `crossOrigin='anonymous'` on media elements incl. Image)
  — modern Chromium otherwise taints kadr:// pixels and preview/export go
  black. Startup sweeps leftover helper processes; shutdown force-exits
  (window-all-closed → app.exit failsafe, render-process-gone → exit).
- `electron/ffmpeg.ts` — ffprobe probing (+ thumbnails + peak/RMS waveform
  bins), `makeProxy` (540p preview proxies), `makeReversed` (backwards
  render of a clip's source range, RAM-bounded chunks), `ExportMuxer`
  (per-segment `volume,atempo*,afade,adelay,apad,atrim` → `amix` with
  exact level compensation), `RawVideoEncoder` (fallback raw-frame
  encoder; the primary one is spawned by the preload).
- `electron/claude.ts` — embedded Claude Code: node-pty PTY running the
  user's `claude` CLI inside a watchdog wrapper (kills its process group
  if Electron dies hard), per-session HTTP bridge (POST /eval →
  `webContents.executeJavaScript`); extra env/command via
  `userData/claude-env.json`, extra MCP servers via
  `userData/claude-mcp.json`; `sweepStaleSessions()` clears leftovers of
  hard-killed runs at startup.
- `electron/mcp-bridge.cjs` — MCP stdio server (SDK) that claude receives
  via a generated `--mcp-config`; tools: kadr_state / kadr_eval /
  kadr_export / kadr_transcribe / kadr_fragment_create.
- `electron/transcribe.ts` + `scripts/transcribe.py` — faster-whisper
  runner (VAD, anti-hallucination thresholds and post-filters, NDJSON
  segments with word timestamps); audio comes from an ExportMuxer mixdown
  (WYSIWYG).
- `electron/fragments.ts` — Remotion workspace (`~/kadr-fragments`):
  scaffold, vite dev server (watchdogged), fragment create/delete,
  `remotion render` once per content hash at near-lossless settings
  (PNG frames; vp9+alpha `--crf=12` for transparent, h264 `--crf=15`
  otherwise; cached in `userData/fragment-renders`), offscreen
  pixel-capture windows (created with `enableLargerThanScreen` — some
  window managers/displays clamp hidden windows otherwise). The player
  page syncs to the editor clock by nudging playbackRate, not seek jumps.
- `src/state/store.ts` — zustand store. Undo convention: callers invoke
  `pushHistory(labelKey)` once before a discrete edit; high-level actions
  push their own. `sanitizeProject` heals foreign/script-written projects
  on load (scalar Anims → {value}, broken keyframes dropped, missing
  fields defaulted). File-backed preset stores (pose/fx) via user-store IPC.
  `insertClipsFromAssets` lays several assets back-to-back in one undo
  (audio → audio track, AV twins as usual); `removeAssets` drops bin
  entries AND every clip using them (one undo); `setClipSpeed` rescales
  keyframes/fades and takes an optional `start` (left-edge speed drags
  keep the right edge anchored).
- `src/engine/mediaImport.ts` — every media intake path: `importFiles`
  (probe → bin, deduped by path, optional timeline placement),
  `dropPayload` (reads dataTransfer SYNCHRONOUSLY: files → uri-list /
  x-moz-url / DownloadURL → portal key), `importDrop` (paths → URLs →
  raw blobs), window-level catch-all drop in App.tsx, drop forensics to
  `window.__dragLog` + `userData/drop-log.jsonl`.
- Clip speed UX (`Timeline.tsx`): Ctrl-drag on either extend grip or
  clip edge = 0.02–100× with ~16 px snapping to round multipliers AND
  neighbouring clip edges/playhead; a cursor-following ×N badge lights up
  when snapped. Preview clamps element playbackRate to Chromium's hard
  [0.0625, 16] range — out-of-range assignment THROWS.
- `src/engine/player.ts` — pure layer/audio queries, `MediaPool`,
  `drawFrame` (shared by preview and export), `Player` (anchored rAF
  clock, ~4 fps idle when paused; the tick is exception-proof — one bad
  frame never kills playback; element resync never reseeks mid-seek and
  aims ahead by 0.08×speed so software decode can't storm).
- `src/gl/compositor.ts` — WebGL2 quad compositor: perspective-correct 3D,
  masks (crop + up to 8 shapes), transition FBOs, motion-blur accumulator,
  glow + gaussian-blur effect passes (`drawLayerFx`), raw-BGRA capture
  upload, `readPixels` for the export pipe.
- `src/gl/transitions.ts` / `src/gl/edges.ts` / `src/gl/glow.ts` — GLSL
  registries: 14 overlap transitions, 12 edge (tip) transitions, the smoky
  outer-glow effect.
- `src/engine/exporter.ts` — offline render: fragment materialization →
  fast decode (`src/engine/demux.ts`, mp4box + WebCodecs, element-seek
  fallback, `KADR_DISABLE_FAST_DECODE` kill-switch) → optional 8-sample
  motion blur and per-clip frame blending → ffmpeg x264 encode at the
  preset bitrate (the preload spawns ffmpeg and receives readPixels
  frames BY REFERENCE — contextIsolation is off exactly for this; every
  IPC/bridge route copies ~8 MB per 1080p frame and tripled render time;
  Chromium's own WebCodecs encoder ignores the requested bitrate and
  stays behind the «fast encoder» checkbox) → main-process ffmpeg mux
  pass. `src/engine/reverse.ts` — clip reversal flow (cached backwards
  renders, linked AV pairs, ⏳ progress).
- `src/engine/subtitles.ts` / `captions.ts` — SRT parse/serialize,
  word-precise cue splitting (`segmentsToRichCues`), auto-captions
  fragment generator.
- `src/engine/fragments.ts` / `fragmentCapture.ts` — fragment create and
  delete flows (`deleteFragment` removes the clips referencing it too)
  and the hybrid preview: iframe overlay by default, automatic pixel
  capture when the clip carries GL-only features (effects/3D/masks/
  transitions).
- `src/engine/autosave.ts` — 5-minute autosave with `activity` flags
  (paused during export and Claude sessions).
- `window.kadrEditor` (set in `src/main.tsx`) — scripting surface for
  automation / AI / MCP integration.

## Testing
`scripts/e2e*.mjs` drive the app over CDP. Async evals park results in
globals and poll (`awaitPromise` is flaky under GC). Tests autosave any
non-empty live project before reloading the page, and back up/restore
`claude-env.json` when they override the Claude command.

## Conventions
- All timeline math in seconds; keyframe times are clip-local.
- Mutations never auto-push history; see the store convention above.
- `electron-vite dev` does NOT hot-restart the main process — main/preload
  edits need a full app restart.
