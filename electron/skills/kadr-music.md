---
name: kadr-music
description: Music in a Kadr project — the music map (kadr_beats: meter, the "one" of every bar, sections, pauses, kick offset), cutting and animating to a bar hierarchy (accentAt/useAccent/breathAt in a fragment's audio.ts), and sound design (kadr_sounds, kadr_sound_add; mechanical sounds under songs). Use together with kadr-editor whenever the open Kadr project has music or the user wants anything timed to a beat; combine with kadr-motion and kadr-3d as the project needs.
---
<!-- managed by Kadr: rewritten when Kadr updates (electron/skills/) -->

# Music, rhythm and sound in Kadr

Defaults for any music-driven piece — the user's words override them. They
come from two places: /brag (latent-spaces/brag, a launch-video skill) and a
real 3D film cut to a song, where six iterations were spent learning that a
beat grid without bars feels wrong, that an onset detector is worse than the
grid for a 4/4 feel, and that effects under a song with vocals fight it.

| tool | what it does |
|---|---|
| `kadr_beats` | the MUSIC MAP on the timeline: beats, bars (meter + the "one"), sections, pauses, the kick offset. Everything the user drags snaps to it. |
| `kadr_audio_react` | bakes the sound AND the map into a fragment: `import { useAccent, breathAt, bars, sections, pauses, useAudio } from './audio'` |
| `kadr_sounds` | the library: 260 analysed bundled effects (CC0), 5 music beds (CC BY 4.0), the user's OWN sounds (`origin:"user"`) |
| `kadr_sound_add` | puts one on a FREE audio track (never over the music) with its HIT on the time you give |
| `kadr_sound_label` | describes one of the user's own sounds (uses, tags, a note) |

## 1. The music map comes first — and goes to the user

Before you cut, time or animate anything over music, run `kadr_beats` on the
music clip (`clipIds`) — not on the whole mix when a voice-over runs on top.
Then SHOW the user the map and get a yes before building:

- tempo and meter (`meter`, `meterConfidence`);
- which beat is the "one" (`phaseConfidence` — below ~0.2, say so and ask them
  to listen: "the one is on the kick at 12.40 s, right?");
- the sections with their bars and energy (intro / build / verse / chorus /
  break / outro — the labels are a heuristic of loudness and repetition, say
  that too), and the pauses;
- `kickOffsetMs` — where the kicks really sit against the grid (e.g. −15: the
  kick lands 15 ms BEFORE the beat line; lead the visual accents by that — the
  accent helpers already do).

Then the storyboard by bars: one row per bar (or phrase of bars) — the event,
the caption, the camera. The drama follows the song: quiet intro → build →
the drop gets the first real payoff → the chorus gets the finale.

## 2. The bar's hierarchy

- **The "one" of a bar** — the BIG moments: a scene or version change, a part
  landing or clicking in, a reveal. Big response (light, scale, a cut).
- **The other beats** — small things: a click, a turn, a layer, a step of a
  mechanism. Small response.
- **A pause in the music is a pause in the picture.** Nothing happens there,
  nothing pulses.
- **Glow breathes, it does not pulse.** `breathAt(frame, fps)` swells once per
  bar and is deeper in energetic sections; `accent.hit` adds the hierarchical
  kick on top. A uniform pulse on every beat reads as a template and as
  "jittery" — never.
- Not everything on a beat needs an event; but a first beat with nothing on it
  inside a clip that declares events is worth a second look (kadr_check notes it).

In a fragment (after kadr_beats, bake with `kadr_audio_react`):

```tsx
import { useAccent, breathAt, bars, sectionAt, inPause } from './audio'
const a = useAccent()                 // { hit, bar, beat, beatInBar, barNumber, section, energy, pause }
const glow = 0.25 + 0.35 * breathAt(frame, fps) + 0.4 * a.hit
// big events: schedule them on bars[k] (composition seconds of every "one")
```

Declare the events in `inspect.events` (`{t, kind: 'big'|'small'}`), so
`kadr_check` can tell you which big event missed its "one", which event is off
the grid by more than 40 ms, and which sits in a pause (kadr-motion).

## 3. Cutting to music

- Clip edges, scene changes and reveals go on beat times; the biggest ones on
  the "one" (the magnet next to «Биты» makes the timeline snap to all of it).
- Text against the grid: above ~110 BPM beats come every < 0.55 s — fine for
  accents, far too fast for lines someone reads. Reveal text on every 2nd or
  4th beat (`grid:"half"`/`"bar"`), or bring items in quickly and HOLD the set.
- Fragments hear the music: `kadr_fragment_create` bakes the sound under the
  clip by default. After moving a clip or changing the music, re-bake with
  `kadr_audio_react` (an export re-bakes stale ones itself; the preview does
  not).

No music yet and the user wants something lively? Offer a bed from
`kadr_sounds` (kind:"music") — say which and why — and place it with
`kadr_sound_add`, which lays its map in the same step.

## 4. Sound design

- **Under a song with vocals: mechanics only.** `kadr_sounds` with
  `use:"mechanical"` — clicks, switches, latches, light metal / plastic / wood
  knocks — each on something visibly clicking into place IN THE FRAME, quiet
  (gain 0.4–0.5). No booms, no whooshes, no "cinematic" hits: they fight the
  song. Sixteen of them under a song were all cut in a real project.
- **Levels** (instrumental beds): music ~0.3–0.4 under effects, never above 0.5
  once effects share the mix; effects ~0.55–0.85, softer for calm pieces.
  Under a voice-over the music drops to ~0.12–0.15 while the voice speaks (run
  `normalizeClip` on the voice first). Effects sit UNDER the music.
- **Timing.** Every sound has a measured `hit` — the attack of its main event.
  `kadr_sound_add` puts the HIT on `at`: give it the moment the visual LANDS
  (0–0.1 s before the landing frame). A whoosh's hit on the middle of its move,
  a transition sound's at the cut. Never place a lead-in sound by its file start.
- **The user's own sounds first** (`origin:"user"`, their `note` says what each
  is); the bundled set fills the gaps.
- **Fewer and better.** For five cards arriving, accent the first, the last or
  the strongest. Prefer `hfRisk` low/medium for anything repeated.
- **Typing**: one keypress per character, a DIFFERENT `keyboard/keypress-*.wav`
  each time; thin out for dense copy.
- **One palette** — a coherent family for the whole piece.

| moment | families / picks |
|---|---|
| a mechanism in frame (under a song) | `use:"mechanical"`: `interface/click_*`, `interface/switch_*`, `impact/impactTin_medium_*`, `impact/impactWood_light_*`, `impact/impactMetal_light_*` |
| big reveal, payoff (no vocals) | `impact/impactSoft_medium_*` (safest), `impact/impactBell_heavy_000/003/004`, `interface/bong_001` |
| cards / items one by one | `casino/card-slide-*`, `casino/card-place-*`, `interface/drop_*` |
| click, tap, selection | `interface/click_002/003/005`, `ui/click2`, `ui/mouseclick1` |
| success, completion | `impact/impactBell_heavy_*`, `casino/chips-collide-*` |
| comedic or chaotic | `interface/glitch_*`, `interface/error_005/006`, `impact/impactPunch_heavy_*` |

## 5. Audio-reactive taste

Let the music make EXISTING things breathe: a glow, 2–4 % of scale, the warmth
of a background, the depth of a vignette. Never an equaliser, waveform bars or
musical-note graphics (the neon wave is the one deliberate exception, when the
user asks for a visualiser), never strobing, never text pulsing so hard it
cannot be read. `a.bass` for weight, `a.treble` for sparkle, `accent.hit` for
the one response that matters.

## Recipes

- «Нарежь под музыку» → `kadr_beats` on the music clip → show the map → cut so
  edges land on beats (the "one" for scene changes; every 2nd or 4th beat for
  slower footage) → `kadr_sheet` of a few cuts → report tempo and what landed
  on which bar.
- «Сделай интро / промо / заставку» → music bed (ask, or offer one) →
  `kadr_beats` → the map + a storyboard by bars to the user → fragments (sound
  baked in, events declared) → a few effects → `kadr_check` + `kadr_sheet` →
  report.
