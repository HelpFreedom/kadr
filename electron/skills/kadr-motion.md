---
name: kadr-motion
description: Motion graphics in Kadr — titles, captions, callouts, promos, multi-scene fragment pieces. Readability rules with numbers, style defaults that keep work from looking AI-templated, the one-film architecture for pieces made of several fragments, and the checks (kadr_check, kadr_sheet) to run before showing anything. Use together with kadr-editor whenever you write or change a fragment, a title or captions; add kadr-music when there is music and kadr-3d for 3D.
---
<!-- managed by Kadr: rewritten when Kadr updates (electron/skills/) -->

# Motion in Kadr

Defaults, not laws — the user's words override any of them. Most of them were
paid for: a real session needed six iterations, and nearly every correction was
one of these rules left unsaid.

## Readable, always

- **One main caption at a time.** A note or a subtitle may accompany it; two
  titles competing never.
- **Readable text stands still.** A caption does not ride along with the
  camera or the object; if it points at something, it stays fixed on screen
  and only a LINE goes to the point (`Callout` in `@kadr/three`). Anything
  moving faster than ~20 px/s while it should be read is a failure.
- **Hold long enough, counted from when the WHOLE line is settled** (entered,
  not yet leaving). The floor that `kadr_check` enforces: 0.8 s for 1–3 words,
  0.3 s per word and at least 1.2 s for a sentence, +0.7 s for a subtitle. What
  a real user found comfortable: ≥ 1.6 s for 2–4 words, ≥ 2.3 s with a
  subtitle, and each caption stays until the next one replaces it.
- **Short**: a title up to ~5 words, a subtitle up to ~5. Numbers as
  "было → стало" inside the same caption. Too much text for a scene → cut
  words or split the scene, never speed it up.
- **Human words with a reason** ("развернул ось шарнира — трещотка молчала"),
  not slogans; facts only from the project's sources — if a fact is not there,
  do not show it. No generic phrases ("streamline your workflow" is banned).
- **Contrast**: titles ≥ 3:1, other text ≥ 4.5:1 against the REAL background
  (`kadr_check` with pixels measures it).

## Style defaults (what reads as an AI template)

Unless the user asks for them: no HUD frames, scanlines, running timecodes,
neon outlines on text, giant "v6" stamps, progress bars, white flashes on cuts,
camera shake or wobble, text pulsing on the beat. Every one of these was in a
first draft and every one was cut.

- **Palette from reality**: the colour of the actual object and footage (the
  printed plastic, the wood of the desk, a warm dark), not "cyberpunk".
- **The hook**: the first 2 seconds decide whether anyone keeps watching —
  plan that moment first.
- **Show the thing**: real footage, real UI, real copy from the project.
- **Make it alive**: things arriving one by one, a simulated click, text being
  typed — each with its sound at the same instant — beat static slides.
- **Every frame postable.** Any frozen frame should be worth sharing.
- **Transitions between busy scenes**: a plain crossfade of two dense layouts is
  a muddy double exposure — stagger it (old out, then new in) or dip through
  the background.
- **Short means short**: a promo/intro is 15–25 s, shaped Hook (2–3 s) →
  Reveal (2–4 s) → 2–3 sharp highlights → Outro (2–4 s).
- **Nothing secret on screen**: keys, tokens, `.env` contents, e-mail
  addresses, real customer names, internal URLs — use stand-ins and say so.

## One film, not a pile of scenes

A piece with several scenes is ONE function of time: `frame(t)` — the camera,
the world and the captions all computed from the timeline second. Scenes built
separately each start and stop on their own, and the cuts show as jumps.

- Put the film in the project library: `kadr-lib/film.tsx` exporting a
  component that takes `t` (and whatever the window needs); every fragment is
  a WINDOW onto it: `<Film t={T0 + frame / fps} />`. One source, no copies.
- Consecutive windows of the same film declare `inspect: { continuous: true }`;
  `kadr_check` with pixels then compares the last frame of one with the first of
  the next (a visible step > 3/255 is reported).
- Clips cut from ONE fragment that continue each other (the second starting in
  the source where the first ends) play in the preview without a reload.
- Effects particular to one window start after its beginning and end before its
  end; anything visible at a seam is computed globally.

## Declare, then check

Export what the fragment IS alongside it — it changes no pixel, Kadr reads it
in a hidden page:

```tsx
import { defineInspect } from '@kadr/runtime'
export const fragment = { component: Film, meta, inspect: defineInspect({
  events: [{ t: 2.0, kind: 'big', label: 'v7 lands' }, { t: 2.47, kind: 'small' }],
  texts: [{ from: 2.3, to: 4.6, text: 'Ось шарнира', sub: 'развернул на 90°', role: 'title',
            box: [110, 150, 520, 110], color: '#fff' }],
  camera: (t) => cam(t),            // 3D: checked for jerks
  continuous: true                  // a window of one film
}) }
```

Then, before showing the user:

1. `kadr_typecheck <fragmentId>`;
2. `kadr_check` — events against the bars (with kadr-music), hold times,
   moving text, overlapping or simultaneous titles, camera jerks; with
   `pixels:true` also contrast and seams; results in TIMELINE seconds, and the
   «Проверка» button shows the same list to the user with a click to each place;
3. `kadr_sheet` — every scene settled, every transition at its middle, both
   sides of every cut; Read it.

Fix what they report before you show anything.

## Tuning by eye

What the user will want to adjust — an angle, a delay, a size, a colour — goes
into `defineParams` (`'@kadr/runtime'`): sliders in the Inspector, live
preview, saved to `params.json`. Cheaper for everybody than a round of "a bit
more to the left" through you.
