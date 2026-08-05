---
name: kadr-editor
description: Editing the LIVE project inside the Kadr video editor through its kadr_* MCP tools (kadr_state, kadr_snapshot, kadr_eval, kadr_export, kadr_transcribe, kadr_fragment_create). Use whenever those tools are available and the task concerns the open timeline, its clips, audio or captions. Not for standalone Remotion authoring — a dedicated remotion skill, if installed, owns composition internals.
---

# Editing in Kadr

You are wired to a live editor: every change lands in the project the user is
watching. Work in a LOOK → ACT → VERIFY loop, like editing with your own eyes.

## LOOK

- `kadr_state` — the structure: tracks (index 0 = topmost video track),
  clips ({start, duration, inPoint, speed, gain, transform, effects,
  transitions}), assets with absolute file paths, texts (SRT/TXT docs you can
  Read/Edit as files). All times are seconds. Asset waveform/thumbnail blobs
  are stripped; never echo whole project objects back (results cap at 4 MB).
- `kadr_snapshot` — your eyes: renders the WYSIWYG frame at time t to a PNG
  at source quality (originals are decoded for the shot, not the preview
  proxies; fragments included) and returns its path — Read it to actually
  SEE composition, text placement, colors. Pass importToBin:false when you
  only need to look. To understand motion or a sequence, snapshot a few
  spread timestamps and Read them side by side.
- Media files themselves are readable directly; ffmpeg/ffprobe are available
  for anything deeper (loudness, scene cuts, codecs).

## ACT (kadr_eval)

- Discipline: `pushHistory(label)` once before a batch of low-level edits
  (updateClip etc.) — that's one undo step for the user. High-level actions
  (insertClipsFromAssets, splitAtPlayhead, removeAssets…) push their own.
- Animatable scalars (gain, transform.x/y/scale/rotation/opacity) are Anim
  objects — write `{ value: 0.5 }`, never a bare number.
- Re-read `getState()` after every action; the store is immutable snapshots.
- High-level helpers already exist — prefer them over hand-rolling:
  `importFiles([paths], place?)`, `normalizeClip(clipId)` (loudness →
  −14 LUFS, true peak ≤ −1 dBTP, works on either half of a linked A/V pair),
  `reverseClip(clipId)`, `snapshotFrame({t, importToBin})`,
  `autoCaptions(...)`, plus kadr_transcribe / kadr_export as tools.

## VERIFY

- After any visual edit: `kadr_snapshot` at the affected time(s), Read the
  PNG, and check the result matches the intent (position, overlap, legibility).
- After audio edits: for exact numbers export a short range with the mp3
  preset and run ffmpeg loudnorm measurement on it.
- After timeline restructuring: `kadr_state` again — confirm starts,
  durations and track placement; overlapping audio on one track crossfades
  automatically, overlapping video on one track becomes a transition.

## Remotion fragments

`kadr_fragment_create` puts an animated React composition on the timeline as
a clip; edit its entry TSX with normal file tools — the preview hot-reloads
live, nothing renders until export. Keep `fragment = { component, meta }`
exported and meta.json's durationInFrames in sync with timing changes; media
used inside a composition must be imported from files copied INTO the
fragment folder. If a dedicated remotion skill is installed, follow it for
composition authoring (animation APIs, sequencing, styling); this skill only
defines how fragments plug into Kadr. Verify fragments visually with
`kadr_snapshot` — it captures them too.

## Recipes

- "Выровняй громкость" → for each clip whose asset hasAudio (skip muted and
  video halves of linked pairs — normalizeClip retargets them anyway):
  `await normalizeClip(id)`; report the per-clip gain in dB.
- "Что происходит на N-й секунде / в этом куске?" → snapshots at 2–5 spread
  timestamps, Read them, describe; correlate with kadr_state clips.
- "Добавь субтитры" → kadr_transcribe (word-precise cues) → SRT lands in
  project.texts; for animated captions use autoCaptions or a fragment.
- Long operations (transcribe, export, reverse, first fragment render) take
  minutes — warn the user, then call and wait; don't retry mid-flight.
