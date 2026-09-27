Files Kadr writes into the fragment workspace (`~/kadr-fragments/src/_kadr/`)
and keeps up to date there — they run in the fragment pages and in
`remotion render`, not in the editor, so they are excluded from the editor's
typecheck (tsconfig.node.json) and bundled into main as text (`?raw`).

- `runtime.ts` → `@kadr/runtime`: fonts (and, later, declarations for checks).
- `three-preview.tsx` → what `@remotion/three` resolves to in the PREVIEW only.
- `webpack.ts` → Kadr's part of the render's webpack config.
