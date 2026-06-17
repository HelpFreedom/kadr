# Kadr — macOS bring-up, native polish & packaging

**Date:** 2026-06-17
**Target:** Apple Silicon (arm64), macOS · Node v25 host · Electron 31

## Goal

Run Kadr on this Mac, give it native macOS UX (application menu + Mac-correct
GPU/keyboard behaviour), and produce a local, **ad-hoc-signed** `.app`/`.dmg`
with a placeholder icon. No Developer ID / notarization (out of scope).

## Decisions

| Question | Decision |
|---|---|
| Scope | Full Mac polish: run + native menu + packaged bundle |
| Missing deps | Install via Homebrew (already satisfied: ffmpeg 8.1, python3, claude) |
| Node version | Try v25 first — rebuild succeeded, no pin needed |
| Code signing | Local unsigned → ad-hoc `codesign -s -` (runs on this Mac) |
| App icon | Generated placeholder ("K", `build/make-icon.mjs`) |
| Packaging tool | electron-builder (best fit for the electron-vite `out/` layout) |
| asar | **Disabled** — the app spawns `node electron/mcp-bridge.cjs` and `python3 scripts/transcribe.py` by absolute path; unpacked = zero path rewriting |

## Environment gotchas (not project bugs)

1. **Electron binary download timed out** from GitHub. Fix: build/install with
   `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` (and
   `ELECTRON_BUILDER_BINARIES_MIRROR` for packaging). Recorded because anyone
   on a GitHub-throttled network will hit this.
2. **`ELECTRON_RUN_AS_NODE=1` leaks** from the VSCode/Claude Code host, which
   makes Kadr's Electron run as plain Node and crash at
   `protocol.registerSchemesAsPrivileged`. Launch with
   `env -u ELECTRON_RUN_AS_NODE`. Does not affect normal launches from Finder.
3. **Finder-launched apps get a minimal PATH** (`/usr/bin:/bin:/usr/sbin:
   /sbin`) — no Homebrew / `~/.local/bin` / nvm. In the packaged app this made
   the Claude PTY exit instantly ("session ended") because `claude` wasn't on
   PATH, and would equally have broken `node` (MCP bridge), ffmpeg/ffprobe and
   python3. Fixed in code (see Phase 2 → `fixUserPath`), not just an env note.

## Changes

### Phase 1 — Bring-up
- `npm install` with the Electron mirror. `postinstall` (`electron-rebuild -f
  -w node-pty`) rebuilt the native module cleanly on Node v25 / Electron 31.
- Verified `npm run dev`: editor mounts, `window.kadrEditor` present, RU UI.

### Phase 2 — Mac-native (`electron/`)
- `main.ts`: `fixUserPath()` — on packaged macOS launches, rebuild
  `process.env.PATH` from the user's login shell (`$SHELL -ilc`, marker-
  delimited) plus Homebrew/`~/.local/bin` fallbacks, before anything spawns.
  Fixes the Finder "session ended" Claude bug and unblocks ffmpeg/node/python3.
- `main.ts`: VAAPI hardware-codec switches (`ignore-gpu-blocklist`,
  `VaapiVideo*`) are **Linux-only** now — macOS uses native VideoToolbox; the
  flags were Linux/Intel-specific and only risked the GPU sandbox off-platform.
- `menu.ts` (new): real macOS application menu. File (New/Open/Save/Save As/
  Export) and project Undo/Redo are custom items with `CmdOrCtrl` accelerators
  forwarded to the renderer over `menu:command`; clipboard/selection keep
  standard roles so text fields + the Claude terminal stay native.
- `main.ts`: `Menu.setApplicationMenu(buildMenu(...))`; removed
  `setMenuBarVisibility(false)`.
- `preload.ts` + `shared/types.ts`: `onMenuCommand` IPC bridge.
- `src/App.tsx`: dispatch menu commands to the existing toolbar handlers
  (undo/redo defer to native text undo when an input is focused); the in-app
  keyboard handler no longer double-binds Save/Undo/Redo (the menu owns them,
  fixing the Mac ⌘-key gap since the old handler only checked `ctrlKey`).

### Phase 3 — Packaging
- `build/make-icon.mjs` (new): generates `build/icon.png` + `build/icon.icns`
  (geometric "K", no external image tooling). `npm run icon`.
- `electron-builder.yml`: `asar: false`, `npmRebuild: false`, arm64 dmg+zip,
  `mac.identity: null`, aux files included in `files`.
- `package.json`: `icon`, `package:mac` scripts; `electron-builder` devDep.
- Build → ad-hoc sign the bundle (`codesign --force --deep -s -`).

## Verification (evidence)

- **Dev:** CDP confirms editor mounts, `kadrEditor`/`onMenuCommand` present.
- **Typecheck:** `npm run typecheck` clean.
- **Packaged `.app`:** launches from `file://`, editor renders, **and the
  embedded Claude Code terminal starts inside the bundle** — proving node-pty,
  the PTY, and the `claude` spawn all work packaged.
- **DMG:** mounts with `Kadr.app` + `/Applications` symlink, detaches clean.
- **Not automatable here:** native menu *click* (AppleScript blocked by macOS
  Accessibility perms, error −1719). Menu build + IPC bridge + clean boot are
  verified; the click→action hop is testable manually from the built app.

## Out of scope (YAGNI)

Developer ID / notarization, Windows/Linux packaging, auto-update,
`titleBarStyle: hiddenInset` (the toolbar occupies the top edge where traffic
lights sit — kept the standard title bar), deep perf tuning.
