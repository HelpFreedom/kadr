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
  newer suites create their own files in `/tmp/kadr-test`). The voice-over
  suites need `KADR_TTS_MOCK=1` in the app's environment, or they would
  spend real API credits.
- Pure node checks — no app, no network:
  `node scripts/check-envelope.mjs` (loudness envelope),
  `check-ttstext.mjs` (text splitting), `check-proxy.mjs` (proxy choice),
  `check-voicemap.mjs` (time remapping after a splice); plus
  `<python3.11> scripts/check-phrases.py` for the phrase-boundary maths.
- `node scripts/gen-icons.mjs [dir]` — regenerate `src/components/icons.tsx`
  from lucide (see the header for the two-line fetch); never hand-edit the
  paths.
- `node scripts/hold-viewport.mjs [w] [h]` — force the page's layout
  viewport while coordinate-driven suites run (a tiling window manager can
  pin the editor window at a size those suites do not expect).

## Requirements
- Node.js ≥ 20, system `ffmpeg`/`ffprobe` in PATH
- Optional: `python3` + `faster-whisper` (speech-to-text), the `claude`
  CLI (embedded AI assistant), network access for the one-time Remotion
  workspace install
- Optional for voice-over: an ElevenLabs API key (entered in the app,
  stored outside the project); for the defect detector, python ≥ 3.11
  with `torch` — the interpreter is a setting (`KADR_TTSQC_PYTHON`), and
  the module degrades to plain voice-over when it is missing

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
  THE CLI IS LOCATED IN NODE, NOT BY A SHELL: a bare name is walked along
  the session's PATH (with PATHEXT on Windows — npm installs a `claude.cmd`
  shim, the native installer a `claude.exe`, and CreateProcess alone would
  find only the latter), then `~/.local/bin`; a missing CLI is reported by
  name instead of as the pty's «File not found». On Windows the launcher is
  spawned directly, without the bash watchdog: the pseudoconsole belongs to
  the Electron process, so a hard death of Electron takes the console host
  and every attached process with it (verified with taskkill /F on main:
  claude.exe and its cmd.exe were gone within seconds), and node-pty's
  ConPTY kill terminates the console's whole process list. One caveat: a
  `.cmd` launcher runs through cmd.exe, whose parser rewrites `%VAR%`, `^`
  and unquoted `& | < >` — the built-in args avoid those (verified: quotes
  and non-ASCII reach claude.exe intact) and a user `args` override on
  Windows has to as well.
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
  COPYING THE PROJECT IS THE HOT PATH. A project is deep-copied TWICE per
  edit — once by `pushHistory`, once by the mutation itself (33
  `cloneProject` call sites) — so a drag copies it on every pointermove and
  the undo stack retains 50 of them. An asset's `waveform`/`thumbnail`/
  `thumbnailEnd` are almost all of a project's bytes: measured on a real
  78 MB project, the waveforms were 78.1 of it. A full
  `JSON.parse(JSON.stringify())` there took 248 ms — four frames a second
  while dragging a clip — and 50 history entries held 3.82 GB, which is
  exactly where V8 quits: that renderer died three times in one day with
  «OOM error in V8: JavaScript heap out of memory», the last GC line
  reading 3841 MB of 3847.8. `cloneProject` therefore SHARES those three
  fields instead of duplicating them: 0.58 ms and 18 MB for the same fifty
  entries.
  THE INVARIANT IT RESTS ON: nobody mutates a waveform or a thumbnail in
  place. They are written once, wholesale, by the probe in
  `electron/ffmpeg.ts` and only ever read afterwards — those three fields
  are assigned in exactly one file in the whole tree. If that stops being
  true, the sharing has to go with it.
  The copy is built key by key rather than by blanking the blobs and round
  tripping, so the live project is never modified even for an instant, key
  order survives, and the result serializes byte for byte like a plain deep
  copy; values JSON drops (undefined, functions, symbols) are dropped the
  same way, and junk in `assets` falls through to a plain copy. Test: e2e28
  — the sharing, that fifty entries hold one waveform, that undo restores it
  whole, and that a project written to disk AFTER an undo still carries its
  waveforms (a copy that quietly lost one would stay invisible until that
  project was reopened). The two behaviour checks were verified to fail with
  the sharing switched off.
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
- `electron/tts.ts` + `src/engine/tts.ts` + `shared/ttsText.ts` — ElevenLabs
  voice-over. THE KEY NEVER REACHES THE RENDERER: the page is scriptable
  (`kadr_eval`), so the key lives in `<userData>/elevenlabs-key.json`,
  written 0600 on the `open()` rather than chmod'ed afterwards, and the
  page can only set it or ask whether one exists. `TtsParams` has no key
  field. Long text is cut at the strongest available boundary (paragraph →
  sentence → clause → space) under the model's cap and stitched with
  previous_text/next_text plus previous_request_ids; the pieces rejoin to
  the input BYTE FOR BYTE, because the defect detector addresses the
  script by character offset and one lost space would shift every later
  index. The optional speed-up rides the same ffmpeg pass as the decode
  and is stored on the run, never re-read from the current settings — a
  regenerated phrase must be sped up like the file it goes into. Output is
  FLAC in the source's own channel layout: forcing stereo duplicated the
  channel and cost exactly 3.01 dB through ffmpeg's downmix matrix.
  `KADR_TTS_MOCK=1` synthesises speech-shaped audio locally so tests never
  spend credits.
- `shared/proxy.ts` — which proxy the API calls use, and how to spell it
  for Chromium (`https=host:port;http=host:port`, or a full `socks5://`).
  `net.fetch` always uses the DEFAULT session, whose proxy Chromium picks
  by itself and may well settle on HTTP_PROXY when only HTTPS_PROXY can
  reach the API — the proxy's own error PAGE then arrives where JSON was
  expected («Unexpected token '<'»). The module owns a partitioned session
  and sets the proxy explicitly. Node's fetch is not an option: it ignores
  proxy environment variables entirely. Test: `node scripts/check-proxy.mjs`.
- `electron/voice.ts` + `python/ttsqc` + `scripts/ttsqc_run.py` — the
  voice-over defect detector, vendored with its light weights. Findings
  land in `Project.defects`, runs in `Project.voiceRuns`; TIMES ARE SOURCE
  SECONDS AND THE RECORD BINDS TO `assetId`, not to a clip — clips are
  moved, trimmed, split and rippled, so a timeline number would be stale
  after the first edit, while a source number only goes wrong when the
  FILE changes, which is exactly what invalidates the finding anyway.
  Phrase boundaries are computed in `python/kadr_phrases.py` (pure
  numbers, testable on synthetic audio via `scripts/check-phrases.py`):
  the cut is the middle of the LONGEST REAL SILENCE in the gap between
  sentences, found from Silero speech probabilities refined by 5 ms RMS.
- `src/engine/voiceRegen.ts` + `shared/voiceMap.ts` — regeneration.
  EVERYTHING CONFIRMED ON ONE VOICE-OVER IS DONE IN ONE PASS: doing them
  one at a time would mean recomputing every later cut inside an
  already-shifted file. The patch is synthesised from the exact script
  substring with surrounding context, sped up by the RUN's factor, matched
  to the level and edge silence of what it replaces, and spliced with
  `acrossfade=c1=qsin:c2=qsin` (a linear fade dips 3 dB mid-speech). The
  new length is MEASURED with probeMedia, never computed, and everything
  to the right shifts on all unlocked tracks. A clip whose EDGE falls
  inside a replaced phrase is refused by name instead of being guessed at.
  `voice:reindex` carries the analysis over the splice, because the index
  describes the file as it was analysed and every splice rewrites it.
- `src/engine/voiceLearn.ts` — verdicts go to the run's own corpus in the
  detector's format. HAND-PLACED MARKS GO IN A SEPARATE FILE: a verdict
  row matching no candidate lowers the match count, and once such rows are
  more than half the file the WHOLE file is discarded, real labels
  included. Retraining is never automatic — it rebuilds from scratch, so
  the previous model is copied aside first, cross-validation numbers are
  printed, and it refuses below 30 examples across ≥2 files.
- `src/styles.css` — THE design system, and the only place a colour, a
  size, a radius or a duration may be born: `:root` holds the neutral ramp
  and accent, the same colours as channels for washes, and the editing
  colours that are part of the model rather than decoration. Nothing below
  `:root` carries a literal colour — a grep for `#` outside the token
  block must come back empty. Contrast is MEASURED against WCAG 2.2 AA.
  SCROLLBARS are a trap: Chromium's standard properties and the
  `::-webkit-scrollbar` pseudo-elements are mutually exclusive — set
  `scrollbar-width` to anything but `auto` and every pseudo-element rule
  is dropped silently, and only the pseudo-element path can set a MINIMUM
  thumb size, which the timeline needs (its thumb is proportional to the
  zoom and degenerates to under a pixel at high zoom).
- `src/components/icons.tsx` — the icon set: lucide (ISC) inlined as SVG,
  no dependency and no network. GENERATED by `scripts/gen-icons.mjs`; add
  a glyph by adding a line to its MAP, never by hand-editing the paths.
  Emoji used to do this job and are banned from the interface: their
  shape, weight and colour come from whatever font the OS ships.
- `src/components/Modal.tsx` — the one shell all dialogs use: titled head,
  scrolling body, fixed footer, `role="dialog"`, Escape, a real focus trap
  and focus restored. It also exports `modalsOpen()`, which App.tsx checks
  before acting on a global shortcut — Space on a focused dialog button
  used to press the button AND start playback behind it.
- `src/engine/log.ts` + `src/components/DebugPanel.tsx` — the session log.
  Twenty places reported failures with `console.warn` and nothing else, so
  a snapshot that did not happen and an import that brought nothing in
  both looked like "I clicked and nothing happened". IN MEMORY ONLY: a
  ring of 500 entries that dies with the window. The button is silent
  until something fails; INFO never raises it, and benign browser notices
  (`ResizeObserver loop …`) are recorded as INFO rather than as failures.
- `electron/storage.ts` + `electron/cacheKeys.ts` + `StoragePanel.tsx` —
  what the editor has left on disk. The split that governs everything is
  REBUILDABLE vs REFERENCED: a proxy, a decoded intermediate and a
  fragment render are named after their source (a hash of path+size+mtime),
  so deleting one costs time and nothing else; a reversed clip, a download
  and a voice-over run are stored BY PATH in the project and cannot be
  derived again. The key formula lives in its own file because a second
  copy would drift, and a drifted formula aims a delete button at the
  wrong file. Projects are keyed BY PATH, never by name. `storage:prune`
  FAILS CLOSED: without an explicit `confirm: true` it only counts, so a
  caller newer than the handler errs towards keeping the files.
- `src/engine/popout.ts` — the preview in an OS window of its own. NOTHING
  IS REBUILT ON THE WAY OVER: the preview always lives in ONE host div
  that a React portal renders into, and popping out only moves that div
  into the popup's document — re-creating it would mean a fresh GL context
  every toggle (Chromium keeps 16 per renderer and force-loses the oldest)
  and a reload of every fragment iframe. The popup is `about:blank` opened
  with `window.open`: same origin and same renderer process, which is the
  only reason the live canvas can be adopted. THE CLOCK AND THE OBSERVERS
  FOLLOW THE CANVAS, not the window they were born in — the rAF loop
  re-reads `canvas.ownerDocument.defaultView` every frame, and the
  ResizeObservers in the moved subtree are rebuilt in the new window (an
  observer belongs to the document it was created in and delivers NOTHING
  for an element in another one). Rule of thumb for anything added inside
  the preview: if it says `window.`, ask which window.
- `window.kadrEditor` (set in `src/main.tsx`) — scripting surface for
  automation / AI / MCP integration.

## Testing
`scripts/e2e*.mjs` drive the app over CDP. Async evals park results in
globals and poll (`awaitPromise` is flaky under GC). Tests autosave any
non-empty live project before reloading the page, and back up/restore
`claude-env.json` when they override the Claude command.

A suite that touches a user store MUST snapshot and restore it: the
preset stores, the Claude command override, the voice-over settings and
the ElevenLabs key are all real user data shared with real sessions, and
each of them has been destroyed by a test at least once.

## Conventions
- All timeline math in seconds; keyframe times are clip-local.
- Mutations never auto-push history; see the store convention above.
- `electron-vite dev` does NOT hot-restart the main process — main/preload
  edits need a full app restart.
