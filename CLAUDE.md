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
  black. Those same privileges (plus `bypassCSP`) make the scheme a
  file-read capability, so every URL carries a per-run token: `fileUrl` in
  the preload appends `?t=<48 hex>` (fetched once over a sync `media:token`
  IPC) and the handler 403s anything else. Without it a page served by the
  FRAGMENT dev server — another origin, no node access, i.e. composition code
  written by hand, by an assistant, or arriving inside somebody else's
  project — could read any file the user can. A directory allowlist was
  considered and rejected: media lives wherever the user picked it, and a
  project loaded through `kadr_eval` never passes main at all, so the
  allowlist would have had holes exactly where a miss means a black preview. Startup sweeps leftover helper processes; shutdown force-exits
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
  Open and close are SERIALIZED through one promise chain and carry a
  generation: spawning is async (config read, `which`, the node-pty import)
  while a close is instant, so a close that overtakes an in-flight open would
  otherwise find no session, do nothing, and let the pending spawn install
  itself afterwards — an orphan nobody can reach or kill. React StrictMode
  turns that race into the norm in dev (it mounts the panel twice), which used
  to give every panel open two ptys writing into one terminal. Both pty
  handlers are keyed to their own session object, so a pty that outlived its
  panel can never paint into the live terminal.
  /eval IS AUTHENTICATED and must stay that way — it runs arbitrary JS in
  the page, and the page holds `window.kadr` (file writes, pty spawn), so a
  bare localhost socket would be reachable by anything on the machine and by
  any WEB PAGE too (a cross-origin fetch with a simple content type needs no
  permission, and an unreadable reply does not stop the code from running; a
  fragment previewed from the workspace dev server is such a page). Two
  locks: a per-session random token in an `x-kadr-token` header — a custom
  header forces a preflight, which the server 404s, so a page cannot even
  send the request — and a flat refusal of any request carrying an `Origin`.
  The token reaches the MCP server as argv[3] of the generated config; the
  liveness ping on `GET /` stays open.
- `electron/mcp-bridge.cjs` — MCP stdio server (SDK) that claude receives
  via a generated `--mcp-config`; tools: kadr_state / kadr_eval /
  kadr_snapshot / kadr_export / kadr_transcribe / kadr_fragment_create /
  kadr_neon_wave.
- `electron/transcribe.ts` + `scripts/transcribe.py` — faster-whisper
  runner (VAD, anti-hallucination thresholds and post-filters, NDJSON
  segments with word timestamps); audio comes from an ExportMuxer mixdown
  (WYSIWYG).
- `shared/envelope.ts` + `electron/envelope.ts` — loudness envelope of a
  timeline range (Blender "Bake Sound to F-Curves" semantics: channels
  summed, |s|, one-pole follower with 5 ms attack / 200 ms release, frame
  sampling by linear interpolation), computed in main over an ExportMuxer
  mixdown (`audio:envelope` IPC). Feeds `src/engine/neonWave.ts` — the 🌊
  neon-wave generator: an audio-reactive fragment whose TSX bakes the
  envelope (`ENV`) and style (`S`); the final look pass replays Blender's
  compositor Lens Distortion exactly in a WebGL shader (per-axis uv·sc
  with sc = 1/(1+max k), d = 1/(1+√(1−4k·r²)), per-channel k for
  dispersion). Empty segments short-circuit to zeros — ExportMuxer with
  no inputs builds an ffmpeg command without any `-i` and fails.
- `electron/fragments.ts` — Remotion workspace (`~/kadr-fragments`):
  scaffold, vite dev server (watchdogged), fragment create/delete,
  `remotion render` once per content hash at near-lossless settings
  (PNG frames; vp9+alpha `--crf=12` for transparent, h264 `--crf=15`
  otherwise; cached in `userData/fragment-renders`), offscreen
  pixel-capture windows (created with `enableLargerThanScreen` — some
  window managers/displays clamp hidden windows otherwise). The player
  page syncs to the editor clock by nudging playbackRate, not seek jumps.
  Every cache in the app builds into a `<key>.part.<ext>` sidecar and is
  RENAMED on success, so the presence of a cache file always means
  "finished". This matters most for fragment renders: remotion writes its
  output progressively, and a killed render used to leave a truncated file
  exactly where the next export looks for a hit — loud for an opaque
  fragment (an mp4 without its moov box does not probe) but SILENT for a
  transparent one, since a short WebM parses fine and just ends early.
  `sweepPartFiles` drops leftover sidecars at startup: nothing is building
  then, so any that exist are corpses.
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
  upload, packed colour-over-matte sampling for alpha video
  (`LayerDraw.alphaPacked`), and pipelined readback for the export pipe
  (`startRead`/`finishRead` through a pixel-pack buffer). `holdSources`
  keeps a dynamic texture from re-uploading once per motion-blur
  sub-sample.
  CONTEXT LIFECYCLE: `dispose()` frees the GL resources and drops the
  context — ONLY for a compositor on a throwaway canvas (the exporter
  builds one per run). A canvas hands out the SAME context object
  forever, so disposing the preview's compositor would black the preview
  out for good; `Player.detach` therefore leaves it alone. `contextLost()`
  exists because a lost context makes every GL call a silent no-op —
  `readPixels` leaves its buffer untouched, so an export would finish
  "successfully" as a black file. The exporter checks per frame and after
  the last one; the preview asks for the context back on
  `webglcontextlost` and rebuilds on `webglcontextrestored`. Two traps
  worth knowing: `getExtension` returns null on a LOST context (take the
  `WEBGL_lose_context` handle while it is alive), and `restoreContext()`
  is ignored when called from inside the lost event — defer it a turn.
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
  DECODE SPEED is the whole game here: an element seek costs ~0.2 s per
  frame, so everything that can avoid it does.
  * ALPHA VIDEO (VP9+alpha WebM — every transparent fragment render —
    ProRes 4444, HEVC-alpha) has no WebCodecs path in any browser, so
    `alphaPackedFallback` builds a cached LOSSLESS H.264 mp4 that stacks
    the colour frame over its alpha matte (2× height) and the shader
    splits it apart again. The packer normalises the picture to BT.709
    with a pure matrix change and writes NO colour tags, and
    `Mp4FrameSource` re-wraps the frames as BT.709 on the CPU: a tagged
    frame goes through Chromium's colour-managed upload, which rewrites
    mid-tones and would lift the matte (128 → 143). `KADR_DISABLE_ALPHA_PACK`
    forces the old path.
  * MOOV AT THE END (any file not written with faststart) is picked up by
    fetching the file's tail (`pumpTail`) instead of dropping to element
    seeks.
  * A STATIC SHUTTER collapses: `frameSignature` records what drawFrame
    would draw without touching the GPU, and when every motion-blur
    sub-sample matches, one draw stands in for eight — exact, and
    `KADR_FORCE_FULL_SHUTTER` restores the full pass.
  * Frame blending is skipped for alpha sources: compositing B over A
    reproduces lerp(A,B,w) only while the layer is opaque.
  * `rawEncodeFrame` resolves on stdin's WRITE CALLBACK — `write()`
    returning true only means "keep writing" while the chunk may still
    point at the buffer the exporter is about to refill (torn frames).
  * ffmpeg leaves x264's b_deterministic off, so two identical runs never
    produce identical files: verify picture changes by hashing rendered
    frames (`globalThis.KADR_FRAME_HASH = []`), never by comparing output.
  * The raw-frame ring is TWO buffers by measurement, not by default. The
    loop does spend a few ms per frame waiting there, but the pipe is
    drained by libuv on the same thread, so a deeper ring adds no
    concurrency, only working set: 1080p60, alternating rounds, 2 slots
    50.5 fps / 3 slots 45.7 / 4 slots 45.3, pixels identical at every depth.
  WHERE AN EXPORT'S TIME GOES, so the next person profiling does not repeat
  the dead ends. Every run prints `[kadr] export stage ms/frame`; on a real
  1080p60 project it reads roughly prepare 0.3 · draw 1.7 · read 9.4 ·
  encode 6.2, i.e. most of the time is the frame LEAVING the renderer, not
  compositing or decoding. Two traps: `read` is TRANSFER, not a wait on the
  GPU (a `gl.finish()` after the draw moves nothing between the laps), and
  it is contention-sensitive — the same 8.3 MB measured 3.3 ms on an idle
  machine and 9.4 ms on a busy one, so profile idle or you will chase a
  ghost. The one real lever left is that ffmpeg receives RGBA and converts
  it to yuv420p itself, which costs it more than the encode: measured
  ceilings on identical frames are 89.5 fps for what ships, 121.5 from
  yuv444p and 181.8 from yuv420p, and converting on the GPU would cut the
  readback to 3.1 MB as well — worth roughly 2×. It is NOT done because it
  cannot yet be made bit-exact, and exports must not change a pixel.
  swscale's path is understood — textbook BT.709 limited matrix (exact on
  uniform fields), a plain horizontal pair average, and an 8-tap vertical
  chroma filter (-2,-6,16,56,56,16,-6,-2)/128 summing to exactly 1 — which
  gets a float model within ONE unit of 255 on 0.05% of luma and ~1.4% of
  chroma samples (whole-frame PSNR 71.3 dB), but the last unit is
  swscale's internal fixed-point rounding and no one- or two-stage integer
  model reproduced it, for 4:2:0 or 4:4:4. Implement it from libswscale's
  source, not by measurement. Also: `-sws_flags` on the command line does
  NOT reach this conversion (the scale filter's own `flags` default wins),
  so an A/B on those flags that compares output bytes proves nothing, and
  filter threading is already on by default.
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
- `src/engine/chime.ts` — short WebAudio two-note signal when a render
  finishes (wired to export progress in `src/main.tsx`).
- Timeline markers live in `project.markers` (`addMarker`/`moveMarker`/
  `removeMarker` in the store, flags drawn by `Timeline.tsx`, M key in
  `App.tsx`): project-wide time labels, not bound to a track, and part of
  `kadr_state` so the embedded Claude can read and place them.
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
