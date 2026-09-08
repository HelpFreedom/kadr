// Bundled-runtime wiring for packaged builds. MUST be imported before any
// module that reads KADR_FFMPEG/KADR_FFPROBE or resolves a spawned binary from
// PATH at load time — notably `./ffmpeg` (its FFMPEG/FFPROBE consts are captured
// at import). Keep this the very first import in electron/main.ts.
//
// The self-contained archive ships ffmpeg/ffprobe/node/npm/npx/python3 under
// resources/runtime/bin. Prepending that dir to PATH makes every literal spawn
// (`python3` in transcribe.ts, `npm`/`npx` in fragments.ts, `node` for the MCP
// bridge) resolve to the bundled copy first, and pointing KADR_FFMPEG/FFPROBE at
// it covers both the main-process ffmpeg.ts and the renderer's preload encoder
// (the renderer inherits this env when its process is spawned). In dev
// (`app.isPackaged` false) nothing changes — the host toolchain is used as before.
import { app } from 'electron'
import { readFileSync, mkdirSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

// Register with PipeWire/PulseAudio as "Kadr" instead of Chromium's default
// "Chromium" (Electron reports the Chromium product name). Beyond looking right
// in the mixer, this gives Kadr its OWN per-app volume: otherwise it shares the
// stream-restore entry of everything named "Chromium", so a remembered 0% there
// silences Kadr's output even though its audio graph runs. OVERRIDE (REPLACE)
// forces over Chromium's own proplist value; PULSE_PROP is a belt-and-braces
// fallback. Set for dev too, and before any window so the audio service — a
// later child process — inherits it. `??=` leaves a user-set value untouched.
// (Only application.name is settable this way — it's a client/context property.
// application.icon_name is stamped by Chromium on the stream itself and can't be
// overridden via env, so the mixer icon stays Chromium's; the Kadr logo still
// shows in the app menu, task bar and window from the packaged icon.)
process.env.PULSE_PROP_OVERRIDE ??= 'application.name=Kadr'
process.env.PULSE_PROP ??= 'application.name=Kadr'

// Export/render intermediates (the raw-video encode and the mux temp) can be
// multi-GB. os.tmpdir() is a small tmpfs on many Linux setups — here /tmp is a
// 7.7 GB RAM-backed tmpfs — so a big export fills it mid-run and ffmpeg dies with
// EDQUOT/ENOSPC ("Disk quota exceeded", errno -122). Route the temps to a
// disk-backed dir under userData instead; preload.ts and main.ts read
// KADR_TMPDIR (falling back to os.tmpdir()), and the renderer inherits this env
// when its process is spawned. Set for dev too — same tmpfs trap there.
try {
  const t = join(app.getPath('userData'), 'tmp')
  mkdirSync(t, { recursive: true })
  process.env.KADR_TMPDIR ??= t
} catch { /* fall back to os.tmpdir() at the call sites */ }

if (app.isPackaged) {
  const runtime = join(process.resourcesPath, 'runtime')
  const bin = join(runtime, 'bin')
  // Desktop/menu launches (e.g. an /opt copy started from the app menu) inherit
  // a minimal PATH that usually omits the user's own bin dirs, so a
  // user-installed `claude` CLI (the embedded AI panel) can't be found. Prepend
  // the bundled runtime (our ffmpeg must win); append the common user locations
  // so `claude` resolves however Kadr was launched. Missing dirs are harmless.
  const home = homedir()
  const userBins = [
    join(home, '.local', 'bin'),
    join(home, 'bin'),
    join(home, '.npm-global', 'bin'),
    join(home, '.claude', 'local'),
    '/home/linuxbrew/.linuxbrew/bin',
    '/usr/local/bin'
  ]
  process.env.PATH = [bin, process.env.PATH ?? '', ...userBins].filter(Boolean).join(':')
  process.env.KADR_FFMPEG ??= join(bin, 'ffmpeg')
  process.env.KADR_FFPROBE ??= join(bin, 'ffprobe')
  // Name of the whisper model pre-bundled by `pack.sh --model <name>`. The
  // renderer reads this (via preload) to default subtitles to the model that
  // was actually shipped, and transcribe.ts seeds it into the writable HF cache
  // (~/.cache/huggingface) on first use — so it's found, not re-downloaded, and
  // the read-only /opt copy is never written to. Absent → normal on-demand DL.
  try {
    const m = readFileSync(join(runtime, 'whisper-model.txt'), 'utf8').trim()
    if (m) process.env.KADR_WHISPER_MODEL = m
  } catch { /* no model bundled */ }
}
