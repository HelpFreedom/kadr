<!-- managed by Kadr: rewritten when Kadr updates (electron/skills/) -->

# Remotion fragments: the details

For a SAVED project the fragment folder
lives next to the .kadr file in `<projectDir>/kadr-fragments/<id>/` (the
returned entry path points there; the shared workspace only holds a
symlink). Unsaved projects keep fragments in the workspace until the first
save moves them over. After opening a project through kadr_eval, call
`await kadrEditor.syncProjectFragments(project, path)` so project-owned
fragments get their workspace links back (`kadrEditor.openProject(path)` does
all of it).

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
  Use `<OffthreadVideo>`, not `<Video>`: in the render Remotion draws with
  several tabs, and `<Video>` repeats and drops frames there (invisible in the
  preview, where `<OffthreadVideo>` plays as an ordinary `<Video>`).
  `<OffthreadVideo>` takes the exact frame through Remotion's native
  compositor, which needs glibc ≥ 2.35; on an older system it fails with
  «GLIBC_2.3x not found», and `<Video>` is then the fallback.
- **Parameters the user tunes**: `defineParams({ az: { value: 30, min, max,
  step, label } })` + `useParams(P)` from `'@kadr/runtime'` — sliders appear in
  the Inspector of the selected clip, the preview follows live, values land in
  the fragment's `params.json` (which the render reads). To set a value
  yourself, write params.json; it hot-updates with no reload. Offer this for
  anything that is tuned by eye (an angle, a delay, a colour).
- If a dedicated remotion skill is installed, follow it for composition
  authoring; this skill only defines how fragments plug into Kadr.

`kadr_neon_wave` is a ready-made audio-reactive fragment: a glowing sine line
whose wiggles follow the loudness of the range. Use it when the user asks for a
sound wave / audio visualizer; restyle by editing `S` in the returned TSX, and
call it again after the audio under it changes.
