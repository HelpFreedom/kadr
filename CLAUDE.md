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
  `npx electron-vite dev -- --remote-debugging-port=9777`; test media
  lives in `/tmp/kadr-test` (generated with ffmpeg lavfi)

## Requirements
- Node.js ≥ 20, system `ffmpeg`/`ffprobe` in PATH
- Optional: `python3` + `faster-whisper` (speech-to-text), the `claude`
  CLI (embedded AI assistant), network access for the one-time Remotion
  workspace install
- **MCP (Claude Code):** When working with Claude Code, ensure `context7` MCP
  server is configured in `~/.claude/settings.json` with `CONTEXT7_API_KEY` env
  var set (get key from context7.com). This enables library/API lookups for
  dependencies used in the project. **You must consult the actual documentation
  for each library version used in this project** — do not rely on training data
  or assumptions about APIs. Always fetch current docs for: Electron, React, Zustand,
  TypeScript, WebGL, WebCodecs, mp4box.js, and any other dependencies before
  coding or debugging.

## Architecture
- `shared/types.ts` — the entire project model (Project/Track/Clip/Anim/
  Keyframe, TextDoc, FragmentSpec, ExportPreset/ExportJob, the `KadrApi`
  IPC surface). All times in seconds. `Anim` is a scalar that may carry
  keyframes; `evalAnim` interpolates. `tracks[0]` is the top video track
  (drawn last).
- `electron/main.ts` — window, `kadr://` streaming protocol with manual
  Range support, IPC: dialogs, project IO (incl. atomic autosave), export,
  user stores, proxy queue.
- `electron/ffmpeg.ts` — ffprobe probing (+ thumbnails + peak/RMS waveform
  bins), `makeProxy` (540p preview proxies), `ExportMuxer` (per-segment
  `volume,atempo*,afade,adelay,apad,atrim` → `amix` with exact level
  compensation).
- `electron/claude.ts` — embedded Claude Code: node-pty PTY running the
  user's `claude` CLI, per-session HTTP bridge (POST /eval →
  `webContents.executeJavaScript`); extra env/command via
  `userData/claude-env.json`.
- `electron/mcp-bridge.cjs` — MCP stdio server (SDK) that claude receives
  via a generated `--mcp-config`; tools: kadr_state / kadr_eval /
  kadr_export / kadr_transcribe / kadr_fragment_create.
- `electron/transcribe.ts` + `scripts/transcribe.py` — faster-whisper
  runner (VAD, anti-hallucination thresholds and post-filters, NDJSON
  segments with word timestamps); audio comes from an ExportMuxer mixdown
  (WYSIWYG).
- `electron/fragments.ts` — Remotion workspace (`~/kadr-fragments`):
  scaffold, vite dev server (watchdogged), fragment create/delete,
  `remotion render` once per content hash (vp8+alpha webm or h264; cached
  in `userData/fragment-renders`), offscreen pixel-capture windows.
- `src/state/store.ts` — zustand store. Undo convention: callers invoke
  `pushHistory(labelKey)` once before a discrete edit; high-level actions
  push their own. File-backed preset stores (pose/fx) via user-store IPC.
- `src/engine/player.ts` — pure layer/audio queries, `MediaPool`,
  `drawFrame` (shared by preview and export), `Player` (anchored rAF
  clock, ~4 fps idle when paused).
- `src/gl/compositor.ts` — WebGL2 quad compositor: perspective-correct 3D,
  masks (crop + up to 8 shapes), transition FBOs, motion-blur accumulator,
  glow passes, raw-BGRA capture upload.
- `src/gl/transitions.ts` / `src/gl/edges.ts` / `src/gl/glow.ts` — GLSL
  registries: 14 overlap transitions, 12 edge (tip) transitions, the smoky
  outer-glow effect.
- `src/engine/exporter.ts` — offline render: fragment materialization →
  fast decode (`src/engine/demux.ts`, mp4box + WebCodecs, element-seek
  fallback, `KADR_DISABLE_FAST_DECODE` kill-switch) → optional 8-sample
  motion blur and per-clip frame blending → `VideoEncoder` → main-process
  ffmpeg pass.
- `src/engine/subtitles.ts` / `captions.ts` — SRT parse/serialize,
  word-precise cue splitting (`segmentsToRichCues`), auto-captions
  fragment generator.
- `src/engine/fragments.ts` / `fragmentCapture.ts` — fragment create flow
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
- React 19 + Zustand 5 optimization: avoid calling object-constructing functions like `findClip` inside `useEditor` selectors to prevent infinite rendering loops. Extract primitive keys/IDs, and execute lookups during component render.
