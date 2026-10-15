---
name: kadr-editor
description: Editing the LIVE project inside the Kadr video editor through its kadr_* MCP tools (kadr_state, kadr_snapshot, kadr_sheet, kadr_eval, kadr_check, kadr_export, kadr_transcribe, kadr_fragment_create, kadr_typecheck, kadr_fragment_media, kadr_model_import, kadr_models, kadr_beats, kadr_audio_react, kadr_sounds, kadr_sound_add, kadr_sound_label, kadr_neon_wave, kadr_voice_*). The base skill — use it whenever those tools are available and the task concerns the open timeline, its clips, audio, captions, titles or motion graphics; it says which of kadr-music, kadr-motion and kadr-3d to add. Not for standalone Remotion authoring — a dedicated remotion skill, if installed, owns composition internals.
---
<!-- managed by Kadr: rewritten when Kadr updates (electron/skills/) -->

# Editing in Kadr

You are wired to a live editor: every change lands in the project the user is
watching. Work in a LOOK → ACT → VERIFY loop, like editing with your own eyes.

## Which skills this task needs

This is the base. Three more skills carry the rules of particular kinds of work;
load the ones the project calls for — often two or three together:

| the project has… | add |
|---|---|
| music, or anything meant to land on a beat | **kadr-music** — the music map, bar hierarchy, sound design |
| titles, captions, fragments, any motion graphics | **kadr-motion** — readability, style defaults, one-film architecture, checks |
| 3D models, a product or a mechanism shown in 3D, a 3D→footage match cut | **kadr-3d** — models, kit, camera, physical honesty |

A cut of plain footage needs only this one. A lyric video needs music + motion;
a product film to a song needs all three. The rules in those skills are
DEFAULTS: the user's own words override any of them.

## Before you build anything bigger than an edit

Almost every correction in a long session is an unstated requirement of style,
rhythm, readability or physical sense — not a technical failure. So:

1. **Ask first** (the user usually welcomes it): how the rhythm should feel,
   what counts as "template-looking" to them, how much text, whether there is
   sound design and of what kind, what the real facts and sources are. Two or
   three pointed questions, not a questionnaire.
2. **Show the plan before the build**: for music, the music map (kadr-music);
   then a storyboard — a table of sections/bars → what happens, what it says,
   where the camera is — and 4–6 KEY FRAMES (`kadr_sheet`) of a rough version.
   Build the rest only after a yes.
3. **Never export or render unless asked.** The user watches the preview.
4. **Report** what you did in numbers the user can check: tempo, which events
   sit on which bars, every caption with its hold time, which sounds and where.

## LOOK

- `kadr_state` — the structure: tracks (index 0 = topmost video track),
  clips ({start, duration, inPoint, speed, gain, transform, effects,
  transitions}), assets with absolute file paths, texts (SRT/TXT docs you can
  Read/Edit as files), markers (the user's numbered timeline anchors — respect
  them as reference points; add your own via addMarker(sec) when it helps;
  `kind:"beat"|"section"|"pause"` markers are the music map, not the user's).
  All times are seconds. Asset waveform/thumbnail blobs are stripped; never
  echo whole project objects back (results cap at 4 MB).
- `kadr_snapshot` — your eyes: renders the WYSIWYG frame at time t to a PNG
  at source quality (originals decoded, fragments included — heavy 3D too: it
  waits until the fragment has really drawn that frame) and returns its path —
  Read it to actually SEE composition, text placement, colours. Pass
  importToBin:false when you only need to look.
- `kadr_sheet(times[])` — a contact sheet: many frames in ONE image, labelled
  with time (and bar.beat when there is a music map). The way to see a
  sequence: every scene settled, every transition at its middle, both sides of
  every cut.
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
  `contactSheet({times})`, `autoCaptions(...)`, `openProject(path)`, plus
  kadr_transcribe / kadr_export as tools.

## VERIFY

- After any visual edit: `kadr_snapshot` / `kadr_sheet` at the affected
  time(s), Read the image, and check the result matches the intent (position,
  overlap, legibility). For anything with scenes or transitions, look at every
  scene SETTLED and every transition at its MIDDLE: overflow, collisions, low
  contrast and muddy double exposures show up there and nowhere else.
- Fragments: `kadr_check` (see kadr-motion) before showing the user.
- After audio edits: for exact numbers export a short range with the mp3
  preset and run ffmpeg loudnorm measurement on it.
- After timeline restructuring: `kadr_state` again — confirm starts,
  durations and track placement; overlapping audio on one track crossfades
  automatically, overlapping video on one track becomes a transition.
- "Why didn't that work?" — the session log is on `window.kadrEditor`
  (`logAsText()`); read what failed instead of guessing.

## Remotion fragments

`kadr_fragment_create` puts an animated React composition on the timeline as
a clip; edit its entry TSX with normal file tools — the preview hot-reloads
live, nothing renders until export. For a SAVED project the fragment folder
lives next to the .kadr file in `<projectDir>/kadr-fragments/<id>/` (the
returned entry path points there; the shared workspace only holds a
symlink). Unsaved projects keep fragments in the workspace until the first
save moves them over. After opening a project through kadr_eval, call
`await kadrEditor.syncProjectFragments(project, path)` so project-owned
fragments get their workspace links back (`kadrEditor.openProject(path)` does
all of it — and asks the user first when the open project has unsaved
changes; it resolves false if they keep it).

- Keep `fragment = { component, meta }` exported (plus `inspect` —
  kadr-motion) and meta.json's durationInFrames in sync with timing changes.
- **Shared code, once.** A saved project has `<projectDir>/kadr-lib/`; every
  fragment of the project imports from it as `'@lib/…'` — modules, models
  (`@lib/models/…`), media (`@lib/media/…`), anything. Never copy a module into
  several fragments with a script. An edit there reloads that project's
  fragments and invalidates their renders.
- **Fonts**: drop them in `kadr-lib/fonts/` — Kadr registers them for the
  preview and the render (family = file name: `Inter-700.woff2` → Inter 700).
  Never load fonts inside a component; `loadFont(url, family)` from
  `'@kadr/runtime'` for anything else.
- **Video inside a fragment**: `kadr_fragment_media` (assetId) makes an
  upright, SDR, keyframe-dense copy in `kadr-lib/media` — a phone's HDR or
  rotated file played directly looks grey or sideways and seeks slowly.
  Use `<Video>`, NOT `<OffthreadVideo>` (it needs a native binary that needs
  glibc ≥ 2.32 and dies on older systems).
- **Parameters the user tunes**: `defineParams({ az: { value: 30, min, max,
  step, label } })` + `useParams(P)` from `'@kadr/runtime'` — sliders appear in
  the Inspector of the selected clip, the preview follows live, values land in
  the fragment's `params.json` (which the render reads). To set a value
  yourself, write params.json; it hot-updates with no reload. Offer this for
  anything that is tuned by eye (an angle, a delay, a colour).
- **Types**: `kadr_typecheck <fragmentId>` after an edit — not tsc over the
  workspace (hundreds of unrelated fragments live there).
- Frames are a pure function of time: no `Date.now()`, no unseeded
  `Math.random()`; heavy work in `useMemo`, never rebuilt per frame; nothing
  expensive at module level (every preview page evaluates it).
- If a dedicated remotion skill is installed, follow it for composition
  authoring; this skill only defines how fragments plug into Kadr.

`kadr_neon_wave` is a ready-made audio-reactive fragment: a glowing sine line
whose wiggles follow the loudness of the range. Use it when the user asks for a
sound wave / audio visualizer; restyle by editing `S` in the returned TSX, and
call it again after the audio under it changes.

## Озвучка и её дефекты (ElevenLabs + локальный детектор)

`kadr_voice_speak` synthesises a text and lands it on an audio track, creating
one if the project has none. It also writes the EXACT text it sent to a
`.script.txt` beside the audio and registers it in `project.texts`. The detector
aligns against THAT file — never retype it, never "tidy" it. It costs the user
ElevenLabs credits, so say so before calling.

`kadr_voice_check` runs the local detector over one voice-over and fills
`project.defects`. It takes minutes, holds the GPU, and refuses while an export
runs.

**Different things that all look like "a marked spot". Do not mix them up:**

| | what it is | where it lives |
|---|---|---|
| `project.markers` | the user's own anchors, green flags over ALL tracks | `{id, time, label}`, timeline seconds |
| `project.markers` with `kind:"beat"/"section"/"pause"` | the music map (kadr_beats) | timeline seconds |
| `range` | the blue in/out fragment (Shift+drag), transient, never saved | not in kadr_state at all |
| `project.defects` | a suspected flaw INSIDE one voice-over clip, violet striped band | `src`/`phrase` in SOURCE seconds of that clip's asset |

Rules that matter:

- `proposed → confirmed / rejected` is the **user's** judgement, made by clicking
  the violet flags (left = defect, right = not a defect). Call
  `kadr_voice_verdict` only when they have told you their decision in words.
  These verdicts are also training data for the detector: guessing on their
  behalf teaches it something false.
- To seek to a defect, use `voiceDefects[].timeline` / `phraseTimeline` from
  `kadr_state`. Do NOT convert `src` yourself — clip `speed` and `inPoint` are
  in that conversion and getting it wrong points at the wrong second.
- `phrase` is what a regeneration would replace: whole sentences, cut in the
  middle of the silence around them. `cut: ['silence', ...]` means the seam is
  clean; `'gap'` or `'fallback'` mean the sentences ran together there.
- `kadr_voice_mark` records a defect the detector never proposed. It is the only
  channel that can widen what the detector finds at all — and for the same
  reason it must only ever be used where the USER pointed, never on a hunch.
- Editing a `.script.txt` after synthesis invalidates every word index in that
  run; the check will refuse until the text is put back or the voice-over is
  redone.
- `kadr_voice_regenerate` re-synthesises the CONFIRMED phrases and splices them
  back. It costs one ElevenLabs request per phrase — say how many before
  calling. Everything after the splice is shifted so the picture stays in sync,
  and the whole thing is one undo entry. It refuses when a clip edge falls
  inside a phrase being replaced.
- `kadr_voice_learn` reports what the training corpus holds; with
  `retrain:true, confirm:true` it rebuilds the model from scratch. That model is
  shared with the user's own console ttsqc, so only ever on an explicit request.
  Be accurate about what it buys: confirming and rejecting raises PRECISION.
  Recall moves only for marks the generator already had a candidate for; marks
  it never proposes at all are counted (`userUnmatched`) and cannot be learned
  by this model.

## Интерфейс: как он устроен и как о нём говорить

**There are no emoji in the interface.** Every control is a lucide SVG icon
(`src/components/icons.tsx`) plus, where it fits, a word. So never tell the user
to «нажмите 🎯» — name the button by its label («Дефекты», «Озвучка», «Волна»)
or by what its icon shows («кнопка с мишенью справа от „Авто субтитры“»). When
you write a label yourself, keep it a word: an emoji dropped into this UI is
immediately visible as foreign.

**Every control has a stable handle.** Icon-only buttons carry `data-act` and an
`aria-label`, so `kadr_eval` can drive the UI without guessing at text:

```js
document.querySelector('[data-act="play"]').click()
```

| where | data-act |
|---|---|
| top bar | `undo` `redo` `new-project` `open-project` `save` `save-as` `export` `storage` `debug` `claude` `lang` |
| transport | `to-start` `play` `to-end` `split` `delete` `add-text` `snapshot` `popout` `onion` `onion-opacity` `onion-diff` |
| timeline toolbar | `add-video` `add-audio` `transcribe-range` `captions` `beats` `beat-snap` `checks` `sounds` `neon-wave` `tts` `defects` `mark-defect` `mark-redo` `hide-defects` |
| beats dialog | `beats-run` `beats-clear` |
| checks dialog | `checks-run` |
| sounds dialog | `sounds-tab-sfx` `sounds-tab-music` `sounds-use` `sound-play` `sound-add` `sounds-with-beats` `sounds-rescan` |
| track head | `track-motion` `mute` `lock` |
| animation editor | `snap` `lock-x` `lock-y` `shape-edges` `shape-rect` `shape-ellipse` `shape-triangle` |
| media bin | `import` `delete-selected` `fragment-media` `model-insert` |
| inspector | `fx-presets` `add-glow` `add-blur` `ar-source` `ar-bake` `fp-reload` `fp-reset` (a parameter row: `[data-param="<name>"]`) |
| debug panel | `gpu-pref` |

Prefer the store API (`kadrEditor`) for edits; use these handles when the action
only exists as a button (opening a dialog, toggling a panel).
Every clip on the timeline carries `data-clip="<clip id>"` — but only clips near
the visible stretch (and selected ones) are in the DOM; scroll or select first.
"Why does the preview/sound stutter?" — measure instead of guessing:
`kadrEditor.previewPoolStats()` (media elements held, corrective seeks so far,
drift of the audible clips) and `kadrEditor.audioStats()` (sources on the audio
graph, AudioContext underruns); `kadrEditor.silencePreview(true)` mutes the
output while you play something to measure, `false` restores it.

**The preview may not be in the editor's document.** `popout` detaches it into
an OS window of its own and a second click brings it back
(`kadrEditor.usePopout.getState().win`, `openPreviewWindow()`,
`dockPreviewWindow()`). It is the same live canvas either way, so
`kadr_snapshot` works unchanged — but a hand-written
`document.querySelector('.preview canvas')` finds nothing while it is
detached; look in `usePopout.getState().win.document` instead, or dock it first.

**Dialogs** all share one shell (`src/components/Modal.tsx`): `role="dialog"`,
Escape closes, Tab is trapped inside, and while one is open the editor's global
shortcuts (Space, S, D…) are suppressed. If you open a dialog through the UI,
close it before sending keyboard shortcuts.

**Colours and sizes are tokens.** `:root` in `src/styles.css` holds the whole
palette (`--c-bg-*`, `--c-text*`, `--c-accent*`, the editing colours
`--c-sel`, `--c-playhead`, `--c-marker`, `--c-defect`, `--c-redo`), spacing
`--s1..--s8`, radii `--r1..--r4`, motion `--t-fast/--t-base`. Any interface code
you write, or any style you change, must read a token instead of inventing a
hex. Canvas-drawn surfaces read the same tokens through `token()` in
`src/theme.ts`. Contrast was measured, not guessed: keep text at 4.5:1 and
control outlines at 3:1 against what they sit on.

## Recipes

- "Выровняй громкость" → for each clip whose asset hasAudio (skip muted and
  video halves of linked pairs — normalizeClip retargets them anyway):
  `await normalizeClip(id)`; report the per-clip gain in dB.
- "Что происходит на N-й секунде / в этом куске?" → `kadr_sheet` of 2–6 spread
  times, Read it, describe; correlate with kadr_state clips.
- "Добавь субтитры" → kadr_transcribe (word-precise cues) → SRT lands in
  project.texts; for animated captions use autoCaptions or a fragment
  (kadr-motion for the reading rules).
- «Озвучь текст» → kadr_voice_speak; then, if asked to check it,
  kadr_voice_check → report the must-review list with TIMELINE timecodes and
  stop: the verdicts are the user's to give.
- Anything to music → kadr-music. Titles, a promo, an intro → kadr-motion (and
  kadr-music if there is music). A model, a product, a mechanism → kadr-3d.
- Long operations (transcribe, export, reverse, first fragment render, a voice
  check, `kadr_check` with collisions) take minutes — warn the user, then call
  and wait; don't retry mid-flight.
