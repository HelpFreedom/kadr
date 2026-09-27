---
name: kadr-3d
description: 3D in Kadr fragments — importing real models (STL, 3MF, STEP, OBJ, GLB via kadr_model_import), Kadr's 3D kit ('@kadr/three' - useModel, Scene3D, Studio, cameraPath/Camera, Part with print layers/outline/x-ray, Callout, Balloons, PortraitReveal), one continuous camera, physical honesty (no parts passing through each other - kadr_check collisions), showing what changed, and matching a 3D camera to real footage (onion skin + defineParams sliders). Use together with kadr-editor and kadr-motion whenever a Kadr project shows a model, a product or a mechanism in 3D; add kadr-music if it is cut to music.
---
<!-- managed by Kadr: rewritten when Kadr updates (electron/skills/) -->

# 3D in Kadr

Defaults grown out of a real film (13 revisions of a 3D-printed part, one
continuous shot cut to a song, ending in a match cut to phone footage). The
user's words override them.

## Models: real ones, imported once

- `kadr_model_import({ paths })` (saved project) → `kadr-lib/models/<name>.glb`
  + sizes and parts. 3MF is read the way the slicer builds it (build items,
  components, units — skipping that once made a 150 mm part 2 mm tall), CAD
  Z-up becomes Y-up, heavy meshes are decimated (200k triangles by default),
  every part gets a size and an oriented box. **Check the returned sizes
  against the real object before you build on it.** `kadr_models` lists what
  is already there. Never convert models by hand into base64 modules.
- In a fragment:

```tsx
import { useModel, Scene3D, Studio, ShadowFloor, Camera, cameraPath, Part } from '@kadr/three'
import standUrl from '@lib/models/stand-v7.glb'
const model = useModel(standUrl)          // null until loaded (the render waits for it)
// model.list / model.parts[name] → { geometry, edges, box, center, size }
```

- Units: 1 scene unit = 10 cm; the model stands on y = 0, centred
  (`useModel(url, { origin: 'file' })` keeps the file's own coordinates — use
  it when several files are parts of ONE assembly and must stay registered).
- Models of every version in shared world coordinates: any version then drops
  into place without fitting.
- A model tile in the media bin has «Вставить как 3D-фрагмент» (`model-insert`,
  or a double click; `insert` in kadr_model_import does the same): a ready
  turntable fragment to start from.

## The kit ('@kadr/three')

| piece | for |
|---|---|
| `Scene3D`, `Studio`, `ShadowFloor` | the canvas, soft studio light (`intensity`), a contact shadow |
| `cameraPath(keys)` → `cam(t)`; `<Camera cam={cam(t)} />` | ONE camera for the whole shot: keys `{t, target, az, el, r, fov, shift}` joined by a monotone spline — no overshoot, no stops |
| `Part` | one part: `look` (color, metal, rough, edges, `outline` + `outlineColor`, `xray`, `glow`), `layer` = print-layer cut `{y, keep:'below'|'above'}`, `exempt` from the collision check |
| `Layer` | the glowing disk of the layer plane that sweeps with a `layer` cut |
| `HeatPart` | a heat/stress map (FEA-like) on the GPU |
| `Cord` | a cable along a spline that grows (`p` 0..1) |
| `Callout` + `calloutText` | a caption FIXED on screen with a line to a 3D point; `calloutText` gives the record for `inspect.texts` |
| `Balloons` | numbered balloons of an exploded view |
| `PortraitReveal` | «чертёж → реальность»: a portrait video window opens over the 3D, then becomes a card on a blurred copy of the same video |
| `project(p, cam)` | a 3D point → screen pixels |

Everything takes `t` (composition seconds) — never read a clock. The preview
draws 3D on demand at the size it is shown; the render at full size.

## Camera

- **One trajectory** for the whole 3D piece (`cameraPath` over `kadr-lib`,
  sampled by every window of the film — kadr-motion "one film"). A camera that
  starts from rest and stops in every scene is what "дёргано" means.
- **No shake, no nudges on impacts** — a camera bump on every click reads as
  jitter, not as an accent. Let light and the part do the accent.
- Declare it: `inspect.camera = cam` → `kadr_check` reports speed steps, jumps
  and jitter.
- The camera looks at the part that CHANGED.

## Physical honesty

- **Parts never pass through each other.** Disassembly and assembly follow the
  real order (what comes off first, what slides where); an object in the way
  (the desk, the phone) moves out for that moment. Check it: `kadr_check` with
  `collisions:true` plays the fragment and tests every pair of `<Part>`s —
  pairs touching on every frame are reported as an assembly in contact, not an
  error. Only layers in progress and x-ray views are `exempt`.
- A mechanism moves like one: a ratchet in clicks, a screw in turns, a latch
  snapping — each a small event on a beat (kadr-music).

## Showing what changed

- A new version comes in as a print LAYER sweeping up: new below the plane,
  old above (`layer: { y, keep: 'below' }` on the new parts, `'above'` on the
  old, a `Layer` disk at y). A removal: a red layer sweeping down. A rollback:
  the reverse sweep.
- The changed part: a yellow outline and a slight glow (not a fill); the part
  going away: a red outline.
- Whatever hides the change (a phone in the holder) leaves the frame.
- One callout per change, with the reason, from the project's notes.

## Matching 3D to real footage

1. `kadr_fragment_media(assetId)` → an upright, SDR, keyframe-dense copy in
   `kadr-lib/media` (phones record HDR and rotated; played raw it looks grey or
   sideways).
2. Put the footage on the track under the fragment, turn on the **onion skin**
   (transport button `onion`; `kadrEditor.setOnion(true)`): its frame lies
   translucently over the preview, «разница» shows where they differ (black =
   aligned). It never reaches a snapshot or an export.
3. Expose the match camera as parameters — `defineParams({ az, el, r, fov,
   shift })` — so the user drags sliders in the Inspector while looking through
   the onion, instead of four rounds of numbers through you. Turn the model on
   its own axis the way it really stands, if needed.
4. The transition: `PortraitReveal` over the aligned model; its glow can
   answer the bar (kadr-music).

## Performance

- Build geometry once (`useMemo`, or the kit), never per frame; heavy maps
  (heat, deformation) in a shader — a per-frame CPU recolour of a big mesh
  makes the preview stutter.
- Nothing heavy at module level: every preview page and the checks evaluate it.
- Decimate on import; 200k triangles for a whole assembly is plenty on screen.
