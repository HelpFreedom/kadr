# Kadr

**AI-native, GPU-accelerated video editor — with Claude Code built into the timeline.**

[Русская версия →](README.md) · [Full feature guide (RU) →](FEATURES.md)

![Kadr demo](demo.gif)

Kadr is a multi-track video editor (Electron + React + TypeScript) built
around one idea: *an AI agent should be able to edit video next to you, on
the same timeline, with the same tools.* Press 🤖, type «add animated
captions to this part», watch it happen live in the preview.

## Highlights

- 🎬 **Real multi-track editing** — video/audio/text tracks, trimming,
  speed, looping, fades, linked AV clips, ripple delete, full undo history.
- ⚡ **GPU compositing (WebGL2)** — the preview *is* the render: the same
  compositor draws both, so export is pixel-exact WYSIWYG.
- 🔑 **Keyframes everywhere** — position, scale, rotation, opacity, volume,
  masks; AE-style workflow with easing.
- 🧊 **True 3D** — per-clip tilt/depth and whole-track camera motion with
  perspective-correct texturing.
- 🎭 **Masks** — animatable edge crop plus up to 8 feathered shapes
  (rect/ellipse/triangle, invertible).
- 🌫️ **Effects: smoky outer glow and blur** — a glow of billow-noise
  smoke, ragged tendrils and drifting embers, plus per-layer gaussian
  blur with an intensity slider; fully parametric, preset-able,
  identical in preview and export.
- ⏪ **Clip reverse** — right-click → “Reverse”: the used source range is
  rendered backwards (cached), the linked AV pair flips in sync, and a
  second click instantly restores the original.
- 🔀 **26 transitions** — 14 overlap transitions (Vegas-style: just overlap
  two clips) and 12 cinematic edge transitions (whip pans, blur zooms, RGB
  split, glitch…) with spectral motion blur.
- 🗣️ **Local speech-to-text** — faster-whisper (large-v3) with word-level
  timestamps and serious anti-hallucination guards (a pure tone yields
  *zero* cues — enforced by tests). SRT/TXT editing built in.
- ✨ **Auto-captions** — one dialog: transcribe → animated karaoke captions
  (word-precise highlight, pop/rise/fade entrances), drag & scale them with
  the mouse right in the preview.
- ⚛️ **Remotion fragments** — programmable React/TSX motion graphics as
  timeline clips. Live preview with hot reload (no renders while
  iterating!), automatic pixel-capture mode when you put GL effects, 3D or
  transitions on a fragment, and exactly **one** real render at export
  (content-hash cached).
- 🤖 **Embedded Claude Code** — a real interactive Claude session in a
  terminal panel, wired to the live project over MCP: it reads the
  timeline, edits clips, transcribes, creates and iterates Remotion
  fragments while you watch the preview update.
- 📤 **Uncompromised export** — video is encoded by ffmpeg x264 at the
  preset's true bitrate (Chromium's built-in encoder ignored the bitrate
  and softened the picture — measured and replaced; frames reach ffmpeg
  with zero copies), mp4box-based fast decode (~8× over element seeks,
  with graceful fallback), 8-sample motion blur, automatic frame blending
  for fps-mismatched sources, presets for YouTube/Shorts/WebM/MP3.
- 🛟 **Quality-of-life** — background 540p preview proxies, autosave every
  5 minutes (atomic, skipped during exports/AI sessions), an
  unsaved-changes indicator with “✓ Saved” feedback, self-healing after
  hard closes (no lingering processes), effect & pose presets shared
  across projects, RU/EN interface.
- 🔒 **Clean `npm audit`** — Electron 42 / Chromium 148, vite 7, fresh
  tar: 0 known vulnerabilities in the dependency tree (thanks to
  [@Antony-hash512](https://github.com/Antony-hash512) for
  [issue #1](https://github.com/HelpFreedom/kadr/issues/1)).

## Requirements

| Component | Needed for | Notes |
|---|---|---|
| Node.js ≥ 20 | everything | |
| ffmpeg + ffprobe | import, audio mix, export | any recent build in PATH |
| python3 + [faster-whisper](https://github.com/SYSTRAN/faster-whisper) | speech-to-text, auto-captions | `pip install faster-whisper`; models download on first use |
| [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) | the 🤖 panel | optional; uses your existing login |
| network (one-time) | Remotion fragments workspace | `~/kadr-fragments`, ~150 MB |

## Getting started

```bash
git clone https://github.com/HelpFreedom/kadr.git && cd kadr
npm install        # postinstall rebuilds node-pty for Electron
npm run dev
```

Import media, edit, press Export. For the AI assistant press 🤖 (the
`claude` CLI must be installed and logged in). If your network needs a
proxy for Claude/npm, create `~/.config/kadr/claude-env.json`:

```json
{ "env": { "HTTPS_PROXY": "http://127.0.0.1:1080", "NO_PROXY": "127.0.0.1,localhost" } }
```

## How the AI integration works

Kadr starts a local HTTP bridge into the renderer and hands Claude an MCP
server with five tools:

| Tool | What it does |
|---|---|
| `kadr_state` | full live project: tracks, clips, asset paths, transcripts, presets |
| `kadr_eval` | run JS against the editor API (every edit lands in undo history) |
| `kadr_export` | render the project or a range and wait for the file |
| `kadr_transcribe` | local Whisper over a file or a timeline range |
| `kadr_fragment_create` | scaffold a Remotion composition as a timeline clip |

The killer loop: Claude creates a fragment, edits its TSX with normal file
tools, and vite hot-reloads it into your preview in ~2 seconds — you give
feedback in plain language, no rendering until the final export.

## Testing

E2E tests drive the real app over the Chrome DevTools Protocol:

```bash
npx electron-vite dev -- --remote-debugging-port=9777   # terminal 1
node scripts/e2e13.mjs                                  # terminal 2 (etc.)
```

They cover transitions, glow, presets, proxies, export fidelity
(fast-vs-fallback PSNR), motion blur, frame blending cadence, the MCP
bridge, transcription anti-hallucination, fragments and capture mode,
autosave semantics and auto-captions.

## Documentation

- [FEATURES.md](FEATURES.md) — the full feature guide (Russian, 1200+ lines).
- [CLAUDE.md](CLAUDE.md) — architecture map (also read by Claude Code).

## License

[GPL-3.0](LICENSE)
