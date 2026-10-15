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
