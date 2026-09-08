#!/usr/bin/env bash
# Build the self-contained Kadr archive (tar.gz + AppImage) for linux-x64.
#
# Run INSIDE a build toolchain (e.g. a Fedora distrobox), NOT on a bare
# immutable host — node-pty is compiled here once against the bundled Electron:
#
#   distrobox create --name kadr-build --image fedora:42
#   distrobox enter  kadr-build
#   sudo dnf install -y gcc-c++ make python3 nodejs npm tar xz which
#   cd ~/Projects/kadr && bash scripts/pack.sh
#
# Output: dist/kadr-<ver>-linux-x64.tar.gz and dist/Kadr-<ver>-linux-x86_64.AppImage
#
# Flags:
#   --lite            core editor + ffmpeg only (skip whisper + Remotion seed)
#   --model <name>    pre-bundle a faster-whisper model; repeat for several
#                     (e.g. --model base --model large-v3) — the first is default
#   --skip-build      reuse an existing out/ (don't re-run npm ci / electron-vite)
set -euo pipefail

# ---- pinned versions (bump as needed) --------------------------------------
NODE_VERSION="20.18.1"                     # bundled host node for npm/npx/mcp bridge
PBS_RELEASE="20241206"                     # astral python-build-standalone release tag
PYTHON_VERSION="3.12.8"                    # cpython version within that release
# BtbN static build (GPL): unlike johnvansickle it ships h264_nvenc/hevc_nvenc,
# so the "GPU encoding (NVENC)" export option works in the packaged app too. It
# dlopens the user's NVIDIA driver libs at runtime — no NVIDIA, no problem, the
# app's nvencAvailable() check just leaves the option off and x264 is used.
#
# PINNED, not `latest`, on purpose: BtbN's current builds require NVENC API 13.1
# (driver ≥ 610), so h264_nvenc won't open on the common 5xx driver line. The
# 2026-05-31 dated build is the last one built against nv-codec-headers API 13.0
# — verified encoding on driver 580 — and works on 610+ too via NVENC back-compat.
# Bump to `latest` once driver ≥ 610 is the norm. (BtbN prunes old dated builds
# eventually; if this 404s, pick the newest dated build whose h264_nvenc still
# opens on the target driver — see nvencAvailable()'s 1-frame test-encode.)
FFMPEG_URL="https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-05-31-13-22/ffmpeg-N-124714-g49a77d37be-linux64-gpl.tar.xz"

ARCH="x64"; UNAME_ARCH="x86_64"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
RUNTIME="$ROOT/runtime"
SEED="$ROOT/kadr-fragments-seed"
BIN="$RUNTIME/bin"

LITE=0; WHISPER_MODELS=""; SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --lite) LITE=1 ;;
    --model) WHISPER_MODELS="$WHISPER_MODELS ${2:-}"; shift ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "unknown flag: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n\033[1;36m==>\033[0m %s\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "missing tool: $1" >&2; exit 1; }; }
dl()  { echo "  fetch $1"; curl -fsSL --retry 3 -o "$2" "$1"; }

need curl; need tar; need node; need npm
cd "$ROOT"

# ---- 0. clean staging ------------------------------------------------------
log "clean staging (runtime/, kadr-fragments-seed/)"
rm -rf "$RUNTIME" "$SEED"
mkdir -p "$BIN"

# ---- 1. app build ----------------------------------------------------------
if [ "$SKIP_BUILD" -eq 0 ]; then
  log "npm ci + electron-vite build"
  npm ci
  npm run build
else
  log "reusing existing out/ (--skip-build)"
  [ -d "$ROOT/out/main" ] || { echo "out/ missing — drop --skip-build" >&2; exit 1; }
fi

# ---- 2. ffmpeg / ffprobe (static, with NVENC) ------------------------------
log "stage static ffmpeg/ffprobe (BtbN gpl, incl. nvenc)"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
dl "$FFMPEG_URL" "$TMP/ffmpeg.tar.xz"
tar -xJf "$TMP/ffmpeg.tar.xz" -C "$TMP"
FF_DIR="$(find "$TMP" -maxdepth 1 -type d -name 'ffmpeg-*' | head -n1)"
# BtbN layout is <dir>/bin/ffmpeg; johnvansickle was <dir>/ffmpeg
install -m755 "$FF_DIR/bin/ffmpeg"  "$BIN/ffmpeg"
install -m755 "$FF_DIR/bin/ffprobe" "$BIN/ffprobe"
if "$BIN/ffmpeg" -hide_banner -encoders 2>/dev/null | grep -q h264_nvenc; then
  log "  ffmpeg has NVENC ✓"
else
  log "  WARNING: bundled ffmpeg lacks nvenc"
fi

# ---- 3. bundled Node (host node/npm/npx for Remotion + MCP bridge) ---------
log "stage Node $NODE_VERSION"
NODE_TARBALL="node-v$NODE_VERSION-linux-$ARCH.tar.xz"
dl "https://nodejs.org/dist/v$NODE_VERSION/$NODE_TARBALL" "$TMP/$NODE_TARBALL"
tar -xJf "$TMP/$NODE_TARBALL" -C "$RUNTIME"
mv "$RUNTIME/node-v$NODE_VERSION-linux-$ARCH" "$RUNTIME/node"
ln -sf ../node/bin/node "$BIN/node"
ln -sf ../node/bin/npm  "$BIN/npm"
ln -sf ../node/bin/npx  "$BIN/npx"

# ---- 4. Python + faster-whisper (relocatable) ------------------------------
if [ "$LITE" -eq 0 ]; then
  log "stage relocatable Python $PYTHON_VERSION + faster-whisper"
  PBS_FILE="cpython-$PYTHON_VERSION+$PBS_RELEASE-$UNAME_ARCH-unknown-linux-gnu-install_only.tar.gz"
  PBS_URL="https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/$PBS_FILE"
  dl "$PBS_URL" "$TMP/python.tar.gz"
  tar -xzf "$TMP/python.tar.gz" -C "$RUNTIME"   # extracts to runtime/python/
  "$RUNTIME/python/bin/python3" -m pip install --no-cache-dir --upgrade pip
  "$RUNTIME/python/bin/python3" -m pip install --no-cache-dir faster-whisper
  ln -sf ../python/bin/python3 "$BIN/python3"

  # Pre-bundle one or more faster-whisper models. Each is cached into the shared
  # HF tree runtime/whisper-seed (electron-builder ships it); at runtime
  # transcribe.ts copies ALL of them into the writable ~/.cache/huggingface so
  # none is re-downloaded. whisper-model.txt records the FIRST as the app default;
  # standard sizes (base/medium/large-v3) are also selectable in the UI.
  if [ -n "$WHISPER_MODELS" ]; then
    DEFAULT_MODEL=""
    for M in $WHISPER_MODELS; do
      log "pre-download whisper model: $M"
      HF_HOME="$RUNTIME/whisper-seed" \
        "$RUNTIME/python/bin/python3" - "$M" <<'PY'
import sys
from faster_whisper import WhisperModel
WhisperModel(sys.argv[1], device="cpu", compute_type="int8")
print("model cached:", sys.argv[1])
PY
      if [ -z "$DEFAULT_MODEL" ]; then DEFAULT_MODEL="$M"; fi
    done
    if [ ! -d "$RUNTIME/whisper-seed/hub" ]; then
      echo "ERROR: models '$WHISPER_MODELS' did not land in runtime/whisper-seed" >&2; exit 1
    fi
    printf '%s' "$DEFAULT_MODEL" > "$RUNTIME/whisper-model.txt"
    echo "  bundled models [$WHISPER_MODELS ] → whisper-seed ($(du -sh "$RUNTIME/whisper-seed" | cut -f1)); default=$DEFAULT_MODEL"
  fi
else
  log "lite build — skipping Python/whisper"
fi

# ---- 5. Remotion fragments seed (pre-installed node_modules) ---------------
if [ "$LITE" -eq 0 ]; then
  log "build Remotion seed (node_modules via bundled npm)"
  SEED_TMP="$(mktemp -d)"
  # deps mirror electron/fragments.ts PKG_JSON — keep in sync if that changes.
  cat > "$SEED_TMP/package.json" <<'JSON'
{
  "name": "kadr-fragments",
  "private": true,
  "dependencies": {
    "@remotion/cli": "4.0.247",
    "@remotion/player": "4.0.247",
    "react": "18.3.1",
    "react-dom": "18.3.1",
    "remotion": "4.0.247"
  },
  "devDependencies": {
    "@types/react": "18.3.3",
    "@vitejs/plugin-react": "4.3.1",
    "typescript": "5.5.4",
    "vite": "5.4.8"
  }
}
JSON
  ( cd "$SEED_TMP" && PATH="$BIN:$PATH" npm install --no-audit --no-fund )
  # Warm Remotion's headless chrome so a first render is offline when the cache
  # lands inside node_modules; harmless (best-effort) otherwise — a first
  # render then fetches chrome over the network using the bundled node.
  ( cd "$SEED_TMP" && PATH="$BIN:$PATH" npx remotion browser ensure ) || \
    echo "  (browser warm skipped — first render will fetch chrome over network)"
  mkdir -p "$SEED"
  mv "$SEED_TMP/node_modules" "$SEED/node_modules"
  rm -rf "$SEED_TMP"
else
  log "lite build — skipping Remotion seed"
fi

# ---- 6. package ------------------------------------------------------------
# refresh the launcher icon from SVG if a rasterizer is present; otherwise the
# committed build/icon.png is used as-is.
if command -v magick  >/dev/null 2>&1; then magick  -background none "$ROOT/build/icon.svg" -resize 512x512 "$ROOT/build/icon.png"
elif command -v convert >/dev/null 2>&1; then convert -background none "$ROOT/build/icon.svg" -resize 512x512 "$ROOT/build/icon.png"; fi

log "electron-builder → tar.gz + AppImage"
npx electron-builder --linux tar.gz AppImage

log "done. artifacts in dist/"
ls -lh "$ROOT/dist" 2>/dev/null || true
