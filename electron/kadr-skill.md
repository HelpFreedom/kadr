---
name: kadr-editor
description: Editing the LIVE project inside the Kadr video editor through its kadr_* MCP tools (kadr_state, kadr_snapshot, kadr_eval, kadr_export, kadr_transcribe, kadr_fragment_create, kadr_neon_wave). Use whenever those tools are available and the task concerns the open timeline, its clips, audio or captions. Not for standalone Remotion authoring — a dedicated remotion skill, if installed, owns composition internals.
---

# Editing in Kadr

You are wired to a live editor: every change lands in the project the user is
watching. Work in a LOOK → ACT → VERIFY loop, like editing with your own eyes.

## LOOK

- `kadr_state` — the structure: tracks (index 0 = topmost video track),
  clips ({start, duration, inPoint, speed, gain, transform, effects,
  transitions}), assets with absolute file paths, texts (SRT/TXT docs you can
  Read/Edit as files), markers (the user's numbered timeline anchors — respect
  them as reference points; add your own via addMarker(sec) when it helps).
  All times are seconds. Asset waveform/thumbnail blobs
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
live, nothing renders until export. For a SAVED project the fragment folder
lives next to the .kadr file in `<projectDir>/kadr-fragments/<id>/` (the
returned entry path points there; the shared workspace only holds a
symlink). Unsaved projects keep fragments in the workspace until the first
save moves them over. After opening a project through kadr_eval
(readProject + setProject), call `await kadrEditor.syncProjectFragments(
project, path)` so project-owned fragments get their workspace links back.
Keep `fragment = { component, meta }` exported and meta.json's
durationInFrames in sync with timing changes; media used inside a
composition must be imported from files copied INTO the fragment folder.

`kadr_neon_wave` is a ready-made audio-reactive fragment: a glowing sine line
whose wiggles follow the loudness of the range (whole mix or one audio track
via trackId). Use it when the user asks for a sound wave / audio visualizer
over a piece of the timeline; restyle by editing `S` in the returned TSX, and
call it again after the audio under it changes (the loudness is baked in).
To embed video inside a composition use `<Video>` — NOT `<OffthreadVideo>`:
OffthreadVideo needs Remotion's native compositor binary, which requires
glibc ≥ 2.32 and refuses to start on older systems (render dies with
"GLIBC_2.3x not found" / HTTP 500 on /proxy frame requests). `<Video>`
renders through headless Chrome itself and works everywhere. If a dedicated remotion skill is installed, follow it for
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
