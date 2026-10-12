---
name: kadr-effects
description: Per-clip effects in Kadr — listing what the editor can draw (kadr_effects), adding, tuning, animating, reordering and removing effects on clips through window.kadrEditor.effects, the order the chain runs in, writing a NEW effect as a .glsl file in the project library without rebuilding Kadr, and checking the result with kadr_snapshot. Use together with kadr-editor whenever a clip needs a look (glow, blur, and whatever effects this build or the project library adds).
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

## Writing a new effect (no rebuild)
A saved project has `kadr-lib/effects/` next to its .kadr file
(`kadr_effects` → `library.dir`). One file per effect, `<name>.glsl`
(letters, digits, - and _), used as `lib:<name>`:
```glsl
/* kadr-effect
{ "name": { "ru": "Сепия", "en": "Sepia" }, "group": "color",
  "params": {
    "amount": { "kind": "number", "default": 1, "min": 0, "max": 1,
                "name": { "ru": "Сила", "en": "Amount" } },
    "tint": { "kind": "color", "default": "#704214", "name": "Tint" } } }
*/
vec4 effect(vec4 c, vec2 uv) {
  vec3 sepia = luma(c.rgb) * mix(vec3(1.0), u_tint * 2.0, 0.5);
  return vec4(mix(c.rgb, sepia, u_amount), c.a);
}
```
- `c` is the layer's STRAIGHT colour at `uv` (0..1, origin bottom-left);
  return straight colour, alpha included (a key lowers it).
- Every param is a uniform `u_<name>`: float for number, select (its
  option value) and toggle (0/1), vec3 for a colour. Kinds: number
  (default, min, max, step), color ("#rrggbb"), select (options:
  [{ value, name }]), toggle (true/false). Only numbers animate.
- Also available: `uTime` (clip seconds — reading it marks the effect as
  moving by itself), `uRes` (pixels), `uRatio`, `texel(uv)` to read the
  layer anywhere (blur, displacement, RGB split), `luma`, `rgb2hsv`,
  `hsv2rgb`, `hash12`.
- Groups: color, key, stylize, light, blur; the Inspector lists project
  effects in their own «Эффекты проекта» group.
- Saving the file is enough: the editor re-reads the folder. A bad header
  shows in `library.issues`; a GLSL error shows as the effect's `error`
  (and on its block), and the effect is skipped until the file is fixed.
- Add it like any other: `effects.add(clipId, 'lib:sepia')`, then
  `kadr_snapshot`. The file travels with the project.
