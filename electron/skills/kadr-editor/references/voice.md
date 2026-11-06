<!-- managed by Kadr: rewritten when Kadr updates (electron/skills/) -->

# Voice-over and its defects (ElevenLabs + the local detector)

`kadr_voice_speak` synthesises a text and lands it on an audio track, creating
one if the project has none. It also writes the EXACT text it sent to a
`.script.txt` beside the audio and registers it in `project.texts`. The detector
aligns against THAT file — never retype it, never "tidy" it.

`kadr_voice_check` runs the local detector over one voice-over and fills
`project.defects`. It takes minutes, holds the GPU, and refuses while an export
runs.

**Different things that all look like "a marked spot". Do not mix them up:**

| | what it is | where it lives |
|---|---|---|
| `project.markers` | the user's own anchors, green flags over ALL tracks | `{id, time, label}`, timeline seconds |
| `project.markers` with `kind:"beat"/"section"/"pause"` | the music map (kadr_beats) | timeline seconds |
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
  back, one ElevenLabs request per phrase. Everything after the splice is
  shifted so the picture stays in sync, and the whole thing is one undo entry.
  It refuses when a clip edge falls inside a phrase being replaced.
- `kadr_voice_learn` reports what the training corpus holds; with
  `retrain:true, confirm:true` it rebuilds the model from scratch. That model is
  shared with the user's own console ttsqc, so only ever on an explicit request.
  Be accurate about what it buys: confirming and rejecting raises PRECISION.
  Recall moves only for marks the generator already had a candidate for; marks
  it never proposes at all are counted (`userUnmatched`) and cannot be learned
  by this model.
