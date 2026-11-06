<!-- managed by Kadr: rewritten when Kadr updates (electron/skills/) -->

# The interface: how it is built and how to talk about it

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
