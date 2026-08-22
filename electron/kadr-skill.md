---
name: kadr-editor
description: Editing the LIVE project inside the Kadr video editor through its kadr_* MCP tools (kadr_capabilities, kadr_state, kadr_chapters, kadr_tasks, kadr_task_start, kadr_task_complete, kadr_snapshot, kadr_storyboard, kadr_eval, kadr_export, kadr_transcribe, kadr_voices, kadr_voice_clone, kadr_fragment_create). Use whenever those tools are available and the task concerns the open timeline, its chapters/groups, annotation tasks, clips, audio, effects, transitions, animation, masks, captions or export. Not for standalone Remotion authoring — a dedicated remotion skill, if installed, owns composition internals.
---

# Editing in Kadr

You are wired to a live editor: every change lands in the project the user is
watching. Work in a LOOK → ACT → VERIFY loop, like editing with your own eyes.

## LOOK

- `kadr_capabilities` — the authoritative contract of the RUNNING editor.
  Read only the relevant section before touching unfamiliar project fields:
  `model`, `projectFiles`, `timeline`, `animation`, `transforms`, `masks`,
  `effects`, `transitions`, `audioSpeech`, `captions`, `fragments`, `voice`,
  `export` or `store`. Use `all` for an
  audit. Its transition ids, defaults and export presets come from runtime
  registries; prefer it over prose, memory or guessed names.
- `kadr_state` — the structure: tracks (index 0 = topmost video track),
  clips ({start, duration, inPoint, speed, gain, transform, effects,
  transitions}), assets with absolute file paths, texts (SRT/TXT docs you can
  Read/Edit as files), markers (the user's numbered timeline anchors — respect
  them as reference points; add your own via addMarker(sec) when it helps).
  All times are seconds. Asset waveform/thumbnail blobs
  are stripped; never echo whole project objects back (results cap at 4 MB).
- `kadr_chapters` — the amber structural map under the ruler. Call without
  arguments to list it; pass the complete desired array to replace it as one
  undo entry. Preserve stable ids when revising existing chapters. After
  building or reorganizing an edit with distinct narrative/functional
  sections, mark those ranges with concise human titles. Keep ordinary
  chapters ordered and non-overlapping; do not create a meaningless single
  chapter for a short undivided timeline. Chapters organize the editor only
  and never render into the video.
- `kadr_tasks` — annotation tasks in timeline order. Work by stable task id,
  never by array position or remembered time. Call `kadr_task_start(id)` before
  editing and `kadr_task_complete(id, result, code?)` for the final short edit
  batch plus completion. Task tools intentionally cannot write start/duration:
  a user may move the annotation while you work. If completion says task not
  found, the user deleted it; do not recreate it.
- `kadr_snapshot` — your eyes: renders the WYSIWYG frame at time t to a PNG
  at source quality (originals are decoded for the shot, not the preview
  proxies; fragments included) and returns its path — Read it to actually
  SEE composition, text placement, colors. Pass importToBin:false when you
  only need to look.
- `kadr_storyboard` — understand motion or a sequence without manually
  managing stale PNGs. It captures up to 9 spread frames by default and
  returns one timestamped contact sheet plus individual full-resolution
  paths. Read the contact sheet first, then only the individual frames that
  need close inspection. `refresh:auto` reuses a result only while the exact
  request and visual fingerprint still match; timeline changes, overwritten
  source media, and Remotion source edits invalidate it. Use `refresh:force`
  only when explicitly checking capture freshness. Storyboards never enter
  the media bin; their PNGs live in Kadr's bounded visual cache rather than
  beside the project or in Downloads.
- Media files themselves are readable directly; ffmpeg/ffprobe are available
  for anything deeper (loudness, scene cuts, codecs).

## ACT (kadr_eval)

- Discipline: `pushHistory(label)` once before a batch of low-level edits
  (updateClip etc.) — that's one undo step for the user. High-level actions
  (insertClipsFromAssets, splitAtPlayhead, removeAssets…) push their own.
- Animatable scalars (gain, clip/track transforms, crop and shape-mask
  geometry) are Anim objects. A static value is `{value}`. A keyed value is
  `{value, keyframes:[{time,value,easing}], smooth?}`. Preserve the existing
  object and other keys when adding a key; never replace a keyed Anim with
  `{value}` unless the user asked to remove animation. Clip-property key
  times are relative to `clip.start`; Track Motion keys use absolute project
  seconds. Sort keys after an upsert. Read `kadr_capabilities:animation` for
  the exact easing values and example.
- Re-read `getState()` after every action; the store is immutable snapshots.
- High-level helpers already exist — prefer them over hand-rolling:
  `importFiles([paths], place?)`, `normalizeClip(clipId)` (loudness →
  −14 LUFS, true peak ≤ −1 dBTP, works on either half of a linked A/V pair),
  `reverseClip(clipId)`, `snapshotFrame({t, importToBin})`,
  `autoCaptions(...)`, plus kadr_transcribe / kadr_export as tools.

### Feature-safe edits

- 2D/3D: patch the existing `clip.transform`; 3D is enabled by the presence
  of `rotX`, `rotY` and `z`. Whole-track 3D lives in `track.motion` and uses
  project-time keyframes. Get current fields/ranges from
  `kadr_capabilities:transforms`.
- Masks: crop is `clip.mask`; drawn shapes are `clip.maskShapes`. Shape type,
  feather ranges, inversion and composition rules are in
  `kadr_capabilities:masks`. Keep unrelated shapes and their keyframes.
- Effects: use only types and params returned by `kadr_capabilities:effects`;
  give every new effect `id: uid()`. Effect and pose preset stores are
  exposed as `useFxPresets` / `usePosePresets`.
- Overlap transitions: overlap two visual clips on the same track, then call
  `setTransition(incomingClipId, type)` using an id from
  `kadr_capabilities:transitions`; `null` is a hard cut. Edge transitions use
  `setEdgeTransitions([{clipId, edge:'in'|'out', type, duration}])`; pair the
  outgoing and incoming edges at a butt joint for one continuous move.
- Audio: `gain` is Anim, fades are seconds. `normalizeClip` defaults to
  -14 LUFS / -1 dBTP. Overlaps on one audio track crossfade automatically.
- Voice: microphone recording needs UI permission and a real device. Local
  F5-TTS is callable through `window.kadr.voiceoverStatus/voiceoverGenerate`;
  use `kadr_voices` for the current voice ids, follow the exact workflow in
  `kadr_capabilities:voice`, and retain version history/raw-source metadata.
  `kadr_voices` also returns global and project-embedded custom clones; when a
  returned voice has `custom:true`, pass both its `settings.voiceId` and
  `settings.customVoice`. Custom reference WAVs are always embedded on project
  save/package so their paths remain portable.
  Use `kadr_voice_clone` for an existing local recording: pass an absolute path,
  a clear name and, when known, the exact spoken text; otherwise Kadr transcribes
  and stores it before creation. It creates a new global
  clone and adds it to the open project by default; do not call it repeatedly
  for the same source unless the user wants separate processed variants.
- Project files: use `kadr_capabilities:projectFiles` for non-interactive
  read/write, autosave and portable packages. Never overwrite a user project
  or package destination unless that target is explicit.

## VERIFY

- After any visual edit: `kadr_snapshot` at the affected time(s), Read the
  PNG, and check the result matches the intent (position, overlap, legibility).
- After audio edits: for exact numbers export a short range with the mp3
  preset and run ffmpeg loudnorm measurement on it.
- After timeline restructuring: `kadr_state` again — confirm starts,
  durations and track placement; overlapping audio on one track crossfades
  automatically, overlapping video on one track becomes a transition. When
  the result has distinct sections, finish by updating `kadr_chapters` and
  re-list it to verify titles and [start,end) boundaries.
- After animation/effect/transition work: verify both structure (`kadr_state`)
  and pixels (`kadr_storyboard`) across the affected interval. Use
  `kadr_snapshot` for a full-resolution close inspection of a suspicious
  timestamp. One good still is not evidence that motion is correct.

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
- "Что происходит в этом куске?" → `kadr_storyboard` over the range, Read the
  contact sheet, describe; correlate with kadr_state clips. For exactly one
  timestamp use `kadr_snapshot` with `importToBin:false`.
- "Добавь субтитры" → kadr_transcribe (word-precise cues) → SRT lands in
  project.texts; for animated captions use autoCaptions or a fragment.
- Long operations (transcribe, export, reverse, first fragment render) take
  minutes — warn the user, then call and wait; don't retry mid-flight.
