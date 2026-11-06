---
name: kadr-editor
description: Use when the kadr_* MCP tools are connected and the task concerns the project open in the Kadr video editor — its timeline, clips, audio, captions, titles, motion graphics, fragments or voice-over. The base skill for every Kadr task; it says which of kadr-music, kadr-motion and kadr-3d to add. Not for standalone Remotion projects outside Kadr.
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

## The critic (fresh eyes)

You know what you meant, so you see it in the frames. The **kadr-critic**
subagent does not: it judges a stretch of the timeline from rendered frames and
measurements only, and names at most the three worst defects, each with a time,
the evidence and one local fix. Kadr chooses which frames it sees, not you.

- **When:** you finished a visual block — a new or reworked scene or fragment,
  titles, captions, transitions, a promo — ran your own `kadr_check` /
  `kadr_sheet`, and are about to show or report it to the user. Not for small
  edits (moving or trimming a clip, a gain, a value the user dictated), audio
  work, answers to questions, or when the user said to skip it. A long run that
  builds scenes one after another: one critic per finished scene, on its range.
- **How:** the Agent tool, `subagent_type: "kadr-critic"`. The prompt holds the
  range in timeline seconds and, VERBATIM, the user's own requirements that
  apply (style, rules, facts, things they asked to avoid). Never your
  intentions, explanations or a list of what you did — that is what the
  critic is there to be free of. Wait for its answer.
- **Then do what its answer's NEXT says.** Defects → repair ONLY those, each
  locally, then call the critic ONCE more on the same range: it verifies those
  defects and looks for nothing new. After that verification you stop: tell
  the user what was repaired and what is still open, with times. If a defect
  contradicts what the user explicitly asked for, do not repair it — say so.
- **The limit is Kadr's, not a suggestion:** one review and one verification
  per stretch of timeline until the user writes again (and a cap per message).
  A refusal is final — report it; never work around it with another range or a
  split. Never call `kadr_review_*` yourself; they are the critic's tools.
- The findings also land in the «Проверка» dialog (with a click to each place)
  and, for a saved project, as a report with its contact sheets in
  `<projectDir>/kadr-reviews/` — read earlier reports there when you pick up a
  project.
- No kadr-critic agent in this session (a custom claude command in
  `claude-env.json` replaces Kadr's flags): say so once and rely on your own
  checks.

## Remotion fragments

`kadr_fragment_create` puts an animated React composition on the timeline as
a clip; edit its entry TSX with normal file tools — the preview hot-reloads
live, nothing renders until export. Read [references/fragments.md](references/fragments.md)
before you create or change one: where its folder lives, shared code and fonts
in `kadr-lib`, video inside a fragment, sliders the user tunes, the neon wave.
Two rules hold for every edit:

- **Types**: `kadr_typecheck <fragmentId>` after an edit — not tsc over the
  workspace (hundreds of unrelated fragments live there).
- Frames are a pure function of time: no `Date.now()`, no unseeded
  `Math.random()`; heavy work in `useMemo`, never rebuilt per frame; nothing
  expensive at module level (every preview page evaluates it).

## Voice-over and the interface

- **Voice-over costs the user money.** `kadr_voice_speak` and
  `kadr_voice_regenerate` spend ElevenLabs credits: say what you are about to
  synthesise, and how many requests, before calling. Read
  [references/voice.md](references/voice.md) before any `kadr_voice_*` call,
  and whenever defects, verdicts or the script file come up.
- **There are no emoji in the interface.** Every control is a lucide SVG icon
  plus, where it fits, a word. So never tell the user to «нажмите 🎯» — name
  the button by its label («Дефекты», «Озвучка», «Волна») or by what its icon
  shows («кнопка с мишенью справа от „Авто субтитры“»). A label you write
  yourself is a word, never an emoji. Read
  [references/interface.md](references/interface.md) before you drive the UI
  through the DOM, write interface code or styles, or measure why the preview
  or the sound stutters.

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
