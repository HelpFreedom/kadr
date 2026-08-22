# Annotation task tracks

## Understanding

- Annotation tasks live on non-rendering `annotation` tracks in the saved project.
- `A+` creates a four-second task at the playhead on the active annotation track; the first
  annotation track is created automatically and more tracks can be added manually.
- Every task has a stable random id, text, fixed timeline start/duration, status, timestamps,
  and an optional agent result.
- Statuses are `new`, `in_progress`, and `done`; both the user and the agent may change them.
- Completed tasks stay visible on the timeline and in the Annotations side-panel tab.
- Tasks on one annotation track may not overlap. They can be moved and resized, but never
  follow media clips and never affect preview or export.
- Deleting a track deletes its tasks. Project mutations remain undoable.

## Assumptions and constraints

- Projects remain local and single-user, with normal save/autosave persistence.
- The UI should remain responsive with roughly 1,000 tasks.
- Task operations merge by id and field: MCP status/result updates never send or overwrite
  timing, so a simultaneous user drag wins without a conflict.
- If the user deletes a task while the agent works, completion returns task-not-found and does
  not recreate it.
- Agent completion records a concise result. We retain created/updated/completed timestamps,
  not a full audit log.

## Chosen design

Extend `TrackKind` with `annotation` and add an optional `annotations` array to `Track`. Media
tracks continue to use `clips`; annotation tracks keep `clips` empty. This keeps old project
files compatible and prevents annotation data from entering render pipelines.

The editor store owns task creation, timing validation, partial updates, deletion, active-track
selection, and the open task card. Timeline blocks call those actions and enforce non-overlap at
the store boundary. The side panel flattens tasks for filtering and navigation.

MCP exposes dedicated list/start/complete/update operations keyed by task id. Mutating tools
patch only status/result fields and resolve the current live task immediately before applying a
change. `kadr_state` also includes annotation tracks as part of the project snapshot.

## Decision log

1. Tasks use three statuses and agents may close them without user review.
2. Completed tasks stay permanently visible with status colors.
3. Tasks use fixed project time rather than clip/content anchors.
4. One annotation track cannot contain overlapping tasks.
5. The first annotation track is automatic; additional tracks are manual.
6. Track deletion hard-deletes its tasks, recoverable only through undo.
7. Stable random ids, rather than time ranges, are the MCP identity.
8. Agent patches never contain timing fields, preserving concurrent user moves.
