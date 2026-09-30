---
name: kadr-effects
description: Per-clip effects in Kadr — listing what the editor can draw (kadr_effects), adding, tuning, reordering and removing effects on clips through window.kadrEditor.effects, the order the chain runs in, and checking the result with kadr_snapshot. Use together with kadr-editor whenever a clip needs a look (glow, blur, and whatever effects this build or the project library adds).
---
<!-- managed by Kadr: rewritten when Kadr updates (electron/skills/) -->

# Per-clip effects in Kadr

## What exists
`kadr_effects` lists every effect this editor can draw: `id`, `group`,
`stage`, and each param with its `kind` (number, color, select, toggle),
range and default — plus `error` when an effect's shader does not compile.
Never guess ids or param names; read them there.

## Changing effects (kadr_eval)
```js
const fx = window.kadrEditor.effects
const id = fx.add(clipId, 'blur', { size: 12 })   // → effect id, appended to the chain
fx.set(clipId, id, { params: { size: 30 } })      // merge params
fx.set(clipId, id, { enabled: false })             // switch off, keep settings
fx.move(clipId, id, 0)                             // first in the chain
fx.remove(clipId, id)
```
Each call is one undo step for the user; do not wrap them in pushHistory.
Params you leave out get their defaults. Colours are `'#rrggbb'`, a toggle is
0 or 1, a select takes one of its option values.

## Animating a param
Numeric params are Anims like the transform: a number, or
`{ value, keyframes: [{ time, value, easing }] }` with clip-local times.
```js
fx.set(clipId, id, { params: { size: { value: 0, keyframes: [
  { time: 0, value: 0, easing: 'easeOut' }, { time: 0.5, value: 40, easing: 'linear' }] } } })
```
Colours, selects and toggles do not animate. Splitting, trimming and speed
changes move the keys with the clip. People key the same params in the
Inspector (the diamond beside a slider) and in the animation editor's
«Эффекты» mode.

## Keying
`chromaKey` makes its key colour transparent (distance in chroma, so the
screen's shadows go too), with `similarity`, `softness` and `spill` (takes
the key colour's cast out of what stays). Put it FIRST in the chain and put
the new background on a track below. The key colour defaults to pure green;
for a real screen read it from a `kadr_snapshot` taken with the key switched
off. People pick it with the eyedropper beside the swatch.

## How the chain runs
- In the clip's order, AFTER the clip transform, in project pixels: an
  effect sees the layer as it sits in the frame (scaled, rotated, masked).
- `stage: 'layer'` effects replace the layer one after another (a key
  before a grade, a grade before a stylize). `stage: 'under'` effects (glow)
  paint beneath the finished layer, whatever their position in the list.
- Effects with `timeDependent` move on their own (glow smoke); the others
  change only when their params do.
- An effect type the running build does not know is kept in the project but
  not drawn.

## Check it
After any change: `kadr_snapshot` at a time inside the clip, Read the image.
For a look across a sequence, `kadr_sheet` over the clips you changed.
