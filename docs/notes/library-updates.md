# Notes on Library Updates and Known Limitations

## Adapting to New Versions

When updating core dependencies (Electron, React, Chromium, TypeScript), always verify:

1. **Removed/changed APIs:** Check deprecation warnings and changelogs. Example:
   - Electron 42 removed `webContents.on('crashed')` — replaced by `'render-process-gone'`.
   - Older Chromium let `<video>` on `kadr://` protocol work without `Content-Type` header; Electron 42+ requires it for decoder selection.

2. **New privilege requirements:** Custom URL schemes often need new flags in `protocol.registerSchemesAsPrivileged()`:
   - `standard: true` — enables host-based URLs and streaming Range requests
   - `corsEnabled: true` — allows cross-origin requests (e.g., dev server `http://localhost` → `kadr://media`)
   - Document why each privilege is needed; see `electron/main.ts` for examples.

3. **Test comprehensively:** Always run full e2e tests after updates:
   ```bash
   npm run typecheck
   npm run dev -- --remote-debugging-port=9777 &
   node scripts/e2e.mjs
   ```

## SwiftShader and Software GL: Upstream Limitations

**Status:** SwiftShader (Electron's software WebGL2 fallback) **cannot composite decoded video frames**. This is a fundamental Chromium limitation, not a bug in Kadr.

### The Problem

When a `<video>` element decodes under SwiftShader, the frame pipeline (`HTMLVideoElement` → `VideoDecoder` → GPU process) tries to wrap the frame in a **platform GpuMemoryBuffer SharedImage** via `MailboxVideoFrameConverter`. SwiftShader has no backing factory for platform-GMB format (`BGRA_8888, gmb_type: platform`), so:

```
ERROR: Could not find SharedImageBackingFactory with params: 
  usage: Gles2Read|RasterRead|DisplayRead, format: BGRA_8888, 
  gmb_type: platform, size: 1280x720, debug_label: MailboxVideoFrameConverter
ERROR: GPU process crashed / Context was lost
```

This happens **before** our `texImage2D` call — a CPU 2D-canvas workaround in the compositor cannot fix it.

### Why Not Fix It In-App?

The crash is in Chromium's core decode pipeline. Possible mitigations and why they don't work:

- **`--disable-gpu-memory-buffer-video-frames`** — Does not affect the zero-copy video→GPU path the decoder takes before our code sees it.
- **Canvas 2D blit fallback in compositor** — The crash happens before frames reach our texture upload; blitting a crashed frame does nothing.
- **Software H.264 decoder mode** — Chromium's video codec selection and HW acceleration are tightly coupled; switching codecs without GPU support is not exposed to embedders.

### Workaround for CI

Headless CI (no display server) that needs to test video preview must provide a **real or virtual GPU**:

```bash
# Option 1: xvfb-run with real Mesa OpenGL
xvfb-run -a npm run dev -- --remote-debugging-port=9777 &
xvfb-run -a node scripts/e2e.mjs

# Option 2: Docker with GPU pass-through (NVIDIA/AMD)
docker run --gpus all ...

# Option 3: Wayland/X11 in GitHub Actions with virgl (GPU emulation)
# (see runner documentation for your CI provider)
```

Do **not** rely on `KADR_SOFTWARE_GL=1` for video tests; video preview will be black and the test will fail.

### References

- **Chromium SwiftShader Docs:** [Using Chromium with SwiftShader](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/docs/gpu/swiftshader.md) — SwiftShader is designed for graphics API (WebGL, WebGPU), not video decode. Docs do not address video playback.
- **Upstream Issue:** [qutebrowser#8908 — MailboxVideoFrameConverter crash under SwiftShader](https://github.com/qutebrowser/qutebrowser/issues/8908) — Open since March 2026 with no upstream fix. Same crash, no workaround found.

### Current Configuration (Electron 42)

In `electron/main.ts`:

```typescript
const headless = !process.env.WAYLAND_DISPLAY && !process.env.DISPLAY
if (process.env.KADR_SOFTWARE_GL || headless) {
  // SwiftShader: only when explicitly requested or truly headless
  app.commandLine.appendSwitch('use-gl', 'angle')
  app.commandLine.appendSwitch('use-angle', 'swiftshader')
  app.commandLine.appendSwitch('enable-unsafe-swiftshader')
}
// Otherwise, use real GPU (NVIDIA, Intel, AMD, etc.)
```

On machines with a display server (Wayland, X11), the real GPU is always used, avoiding the software-GL video limitation.

## Key Files

- `electron/main.ts` — Protocol handler, GPU config, privilege setup
- `CLAUDE.md` — Requirement to use context7 MCP and consult current library docs
