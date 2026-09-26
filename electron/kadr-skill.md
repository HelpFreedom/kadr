---
name: kadr-editor
description: Editing the LIVE project inside the Kadr video editor through its kadr_* MCP tools (kadr_state, kadr_snapshot, kadr_eval, kadr_export, kadr_transcribe, kadr_fragment_create, kadr_beats, kadr_audio_react, kadr_sounds, kadr_sound_add, kadr_sound_label, kadr_neon_wave, kadr_voice_speak, kadr_voice_check, kadr_voice_verdict, kadr_voice_mark, kadr_voice_regenerate, kadr_voice_learn). Use whenever those tools are available and the task concerns the open timeline, its clips, audio, music, captions, titles or motion graphics. Not for standalone Remotion authoring — a dedicated remotion skill, if installed, owns composition internals.
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
  For anything with scenes or transitions, snapshot every scene at a SETTLED
  moment and every transition at its MIDDLE: overflow, collisions, low contrast
  and muddy double exposures show up there and nowhere else.
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

## Музыка, ритм и моушн — правила по умолчанию

These come from /brag (latent-spaces/brag), a skill that makes short launch
videos, and they apply to EVERY title, caption, fragment, promo or music-driven
cut you build here — not only when the user says "promo". Four tools carry them:

| tool | what it does |
|---|---|
| `kadr_beats` | finds the beats of the music (librosa's beat_track, ported and checked beat for beat) and lays them down as **beat markers**: thin pink lines, accents brighter, `kind:"beat"` in `project.markers`. Everything the user drags snaps to them. |
| `kadr_audio_react` | bakes the sound under a fragment into it: `import { useAudio, beats } from './audio'` |
| `kadr_sounds` | the library: 260 analysed bundled effects (CC0), 5 music beds (CC BY 4.0) and the user's OWN sounds (`origin:"user"`) |
| `kadr_sound_add` | puts one on a FREE audio track (never over the music) with its HIT on the time you give — music gets its beats at once |
| `kadr_sound_label` | describes one of the user's own sounds (uses, tags, a note) |

### The default workflow when there is music

1. **Beats first.** Before you cut, time or animate anything over music, run
   `kadr_beats` on the music clip (`clipIds`) — not on the whole mix when a
   voice-over runs on top of it. Read `tempo` and the beat list back.
2. **Cut on the beat.** Clip edges, scene changes and reveals go on beat
   times. Lock only the 1–3 biggest moments to **accents** (`strong`, within
   ±0.15 s); smaller entrances may sit within ±0.10 s of any beat. Say in a
   code comment which ones are locked: `// beat-locked: 5.80 s`.
3. **Fragments hear the music.** `kadr_fragment_create` bakes the sound under
   the clip by default. Use it: `beats` for reveals, `useAudio()` for subtle
   breathing. After moving the clip or changing the music, re-bake with
   `kadr_audio_react` (an export re-bakes stale ones itself; the live preview
   does not).
4. **Sound the movement.** A few well-timed effects from `kadr_sounds` where
   something visibly lands, clicks, types or slides in. Fewer and better, gentle
   ones first.
5. **Look, including between scenes** (see VERIFY) — then report the tempo,
   which moments are beat-locked and which sounds you added.

No music yet and the user wants something lively (an intro, a promo, a
montage)? Offer a bed from `kadr_sounds` (kind:"music") — say which and why —
and place it with `kadr_sound_add`, which marks its beats in the same step.

### Creative laws

- **The hook is everything.** The first 2 seconds decide whether anyone keeps
  watching — plan that moment first.
- **Readable, always.** Pace comes from motion and cuts, never from pulling
  text away early. A line stays fully visible and SETTLED (entered, not yet
  leaving) long enough to read: ~0.8 s for 1–3 words, ~0.3 s per word and at
  least ~1.2 s for a sentence, counted from when the WHOLE line is on screen.
  Fast in, then hold — never fast in, then gone. Too much text for a scene →
  cut words or split the scene, never speed it up.
- **Text against the beat grid.** Above ~110 BPM beats come every < 0.55 s:
  that is fine for accents (a glow, a dot, a tick) and far too fast for lines
  someone reads. Reveal text on every 2nd or 4th beat (`grid:"half"`/`"bar"`),
  or bring the items in quickly and HOLD the whole set.
- **Show the thing.** Real footage, real UI, real copy from the project — no
  abstract filler, no generic phrases ("streamline your workflow" is banned).
  Specific to THIS project.
- **Make it alive.** Things that arrive one by one, a simulated click, a swipe,
  text being typed — each with its sound at the same instant — beat static
  slides.
- **Every frame postable.** Any frozen frame should be worth sharing.
- **Transitions between busy scenes.** A plain crossfade of two dense layouts is
  a muddy double exposure. Stagger it (old content out, then new content in) or
  dip through the background (`dipToBlack`).
- **Short means short.** A promo/intro is 15–25 s (18–22 is the sweet spot),
  shaped Hook (2–3 s) → Reveal (2–4 s) → 2–3 sharp highlights → Outro (2–4 s).
- **Deterministic frames.** A composition frame is a pure function of time — no
  `Date.now()`, no unseeded `Math.random()`; wait for fonts and images.
- **Nothing secret on screen.** Keys, tokens, `.env` contents, e-mail addresses,
  real customer names, internal URLs never reach a frame or a caption — use
  plausible stand-ins and say so.

### Sound design

- **Levels.** Music bed at gain ~0.3–0.4 under effects, never above 0.5 once
  effects share the mix; effects ~0.55–0.85, softer for calm pieces. Under a
  voice-over the music drops to ~0.12–0.15 for as long as the voice speaks (run
  `normalizeClip` on the voice first). Effects sit UNDER the music, blended in,
  never harsh or spiky.
- **Timing.** Every sound has a measured `hit` — the attack of its main event,
  seconds into the file (a whoosh ~0.5 s, a boom with a rumble lead-in 1.5 s).
  `kadr_sound_add` puts the HIT on `at`, so give it the moment the visual
  LANDS: the lead-in then plays before it by itself. Aim the hit 0–0.1 s before
  the landing frame; a whoosh's hit on the middle of the move it accompanies; a
  transition sound's hit at the cut; a success sound when the thing is fully
  visible. Never place a lead-in sound by its file start — it arrives late.
- **The user's own sounds first.** `origin:"user"` sounds are the ones they
  picked for their own videos (family `mine`…): prefer them whenever one fits,
  and use the bundled set to fill the gaps. Their `note` says what each is.
- **Sequences.** For five cards arriving, accent the first, the last or the
  strongest — score every item only when that rhythm is the point.
- **Harshness.** Prefer `hfRisk` low/medium for anything repeated or polished;
  keep `high` for one tiny isolated accent or a deliberately chaotic piece.
- **Typing.** One keypress per character, a DIFFERENT `keyboard/keypress-*.wav`
  each time (the same file repeated sounds robotic); thin out for dense copy.
- **One palette.** A coherent family of sounds for the whole piece, not a grab
  bag of cute ones.

| moment | families / picks |
|---|---|
| big reveal, payoff | `impact/impactSoft_medium_*` (safest), `impact/impactBell_heavy_000/003/004`, `interface/bong_001` |
| cards / items one by one | `casino/card-slide-*`, `casino/card-place-*`, `interface/drop_*` |
| click, tap, selection | `interface/click_002/003/005`, `ui/click2`, `ui/mouseclick1` |
| toggle, mode change | `interface/switch_*`, `ui/switch*` |
| success, completion | `impact/impactBell_heavy_*`, `casino/chips-collide-*` |
| comedic or chaotic | `interface/glitch_*`, `interface/error_005/006`, `impact/impactPunch_heavy_*` |

### Audio-reactive taste

Let the music make EXISTING things breathe: a glow, 2–4 % of scale, the warmth
of a background, the depth of a vignette. Never an equaliser, waveform bars or
musical-note graphics (the neon wave is the one deliberate exception, when the
user asks for a visualiser), never strobing, never text pulsing so hard it
cannot be read. `a.bass` for weight, `a.treble` for sparkle, `a.accent` for the
one flash that matters.

## Озвучка и её дефекты (ElevenLabs + локальный детектор)

`kadr_voice_speak` synthesises a text and lands it on an audio track, creating
one if the project has none. It also writes the EXACT text it sent to a
`.script.txt` beside the audio and registers it in `project.texts`. The detector
aligns against THAT file — never retype it, never "tidy" it. It costs the user
ElevenLabs credits, so say so before calling.

`kadr_voice_check` runs the local detector over one voice-over and fills
`project.defects`. It takes minutes, holds the GPU, and refuses while an export
runs.

**Three different things that all look like "a marked spot". Do not mix them up:**

| | what it is | where it lives |
|---|---|---|
| `project.markers` | the user's own anchors, green flags over ALL tracks | `{id, time, label}`, timeline seconds |
| `project.markers` with `kind:"beat"` | detected musical beats (kadr_beats), thin pink lines | `{time, strength, strong}`, timeline seconds |
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

The editor was redesigned; two things about it change how you work.

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
| transport | `to-start` `play` `to-end` `split` `delete` `add-text` `snapshot` `popout` |
| timeline toolbar | `add-video` `add-audio` `transcribe-range` `captions` `beats` `beat-snap` `sounds` `neon-wave` `tts` `defects` `mark-defect` `mark-redo` `hide-defects` |
| beats dialog | `beats-run` `beats-clear` |
| sounds dialog | `sounds-tab-sfx` `sounds-tab-music` `sounds-use` `sound-play` `sound-add` `sounds-with-beats` |
| track head | `track-motion` `mute` `lock` |
| animation editor | `snap` `lock-x` `lock-y` `shape-edges` `shape-rect` `shape-ellipse` `shape-triangle` |
| media bin | `import` `delete-selected` |
| inspector | `fx-presets` `add-glow` `add-blur` `ar-source` `ar-bake` |

Prefer the store API (`kadrEditor`) for edits; use these handles when the action
only exists as a button (opening a dialog, toggling a panel).

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

- «Нарежь под музыку» → `kadr_beats` on the music clip → read the beats →
  cut/move clips so their edges land on beats (every 2nd or 4th for slower
  footage) → snapshots at a few cuts → report tempo and what landed where.
- «Сделай интро / промо / заставку» → the default workflow above: music bed
  (ask or offer one from `kadr_sounds`) → `kadr_beats` → a fragment per scene
  (sound baked in) with reveals on accents and readable holds → a few effects →
  snapshots of every scene and mid-transition → report.

- "Выровняй громкость" → for each clip whose asset hasAudio (skip muted and
  video halves of linked pairs — normalizeClip retargets them anyway):
  `await normalizeClip(id)`; report the per-clip gain in dB.
- "Что происходит на N-й секунде / в этом куске?" → snapshots at 2–5 spread
  timestamps, Read them, describe; correlate with kadr_state clips.
- "Добавь субтитры" → kadr_transcribe (word-precise cues) → SRT lands in
  project.texts; for animated captions use autoCaptions or a fragment.
- «Озвучь текст» → kadr_voice_speak; then, if asked to check it,
  kadr_voice_check → report the must-review list with TIMELINE timecodes and
  stop: the verdicts are the user's to give.
- Long operations (transcribe, export, reverse, first fragment render, a voice
  check) take minutes — warn the user, then call and wait; don't retry
  mid-flight.
