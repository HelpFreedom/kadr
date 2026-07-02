#!/usr/bin/env node
// MCP stdio server bridging Claude Code to the running Kadr editor.
// Spawned by claude itself (see kadr-mcp.json); forwards tool calls to the
// editor's local HTTP bridge (port = argv[2]), which evaluates JS in the
// renderer where window.kadrEditor lives.
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js')
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js')
const { z } = require('zod')
const http = require('http')

const PORT = Number(process.argv[2])
if (!PORT) {
  console.error('usage: mcp-bridge.cjs <editor-bridge-port>')
  process.exit(1)
}

// Never outlive our claude (stdin closes when it dies) or the editor
// (bridge port stops answering) — an orphaned bridge inherits Chromium's
// listening sockets and would block the next editor launch.
process.stdin.on('end', () => process.exit(0))
process.stdin.on('close', () => process.exit(0))
let bridgeMisses = 0
setInterval(() => {
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/', method: 'GET', timeout: 3000 },
    (res) => { res.resume(); bridgeMisses = 0 } // any response = editor alive
  )
  req.on('error', () => { if (++bridgeMisses >= 3) process.exit(0) })
  req.on('timeout', () => { req.destroy(); if (++bridgeMisses >= 3) process.exit(0) })
  req.end()
}, 10000).unref()

/** POST the code (async function body) to the editor, return parsed result. */
function editorEval(code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ code })
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: '/eval', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          try {
            const r = JSON.parse(data)
            if (r.error) reject(new Error(r.error))
            else resolve(r.ok)
          } catch (e) { reject(e) }
        })
      }
    )
    req.on('error', (e) => reject(new Error(
      `editor bridge unreachable (${e.message}) — is the Kadr terminal panel still open?`)))
    req.end(body)
  })
}

const asText = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 1) }] })
const asError = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true })

const server = new McpServer({ name: 'kadr', version: '1.0.0' })

server.registerTool('kadr_state', {
  description:
    'Read the LIVE state of the Kadr project currently open in the editor: full project ' +
    '(tracks→clips, assets with absolute media file paths, fps, size), projectPath, selection, ' +
    'playhead, and available export presets. All times are in seconds. tracks[0] is the topmost ' +
    'video track (drawn last). Clip: {id, kind: media|text, assetId, start, duration, inPoint, ' +
    'speed, gain, muted, transform, mask?, maskShapes?, effects[], transitionIn/Out?, fadeIn/Out?}. ' +
    'project.texts lists transcript/subtitle documents (TextDoc {id, name, path, format: srt|txt, ' +
    'assetId?, offset?}) — path is a real file you can Read/Edit; see kadr_transcribe to create them.',
  inputSchema: {}
}, async () => {
  try {
    return asText(await editorEval(`
      const s = window.kadrEditor.useEditor.getState()
      return {
        project: s.project,
        projectPath: s.projectPath,
        selection: s.selection,
        playhead: s.playhead,
        exportPresets: window.kadrEditor.PRESETS.map(p => ({
          id: p.id, name: p.name, container: p.container, audioOnly: !!p.audioOnly
        }))
      }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_eval', {
  description:
    'Run JavaScript inside the Kadr editor page and return its result (must be JSON-serializable). ' +
    'The code is the body of an async function — use `return`. API surface:\n' +
    '- window.kadrEditor.useEditor.getState() → store: project, selection, playhead, and actions: ' +
    'pushHistory(label) (call ONCE before a discrete low-level edit like updateClip — enables undo; ' +
    'high-level actions such as addTrack/insertClipFromAsset/splitAtPlayhead push their own), ' +
    'updateClip(clipId, patch), ' +
    'insertClipFromAsset(assetId, trackId, startSec), setClipDuration(clipId, sec), addAsset(asset), ' +
    'addTrack(kind), select([ids]), setPlayhead(sec), setProject(project), splitAtPlayhead(), ' +
    'deleteSelection(), setTransition(clipId, type|null), setEdgeTransitions(...).\n' +
    '- window.kadrEditor.uid() → new id; .PRESETS → export presets; .projectDuration(project); ' +
    '.evalAnim(anim, t); await .reverseClip(clipId) — reverse a video/audio clip in place ' +
    '(renders a backwards copy, swaps the clip to it; calling again un-reverses).\n' +
    '- await window.kadr.probeMedia(path) → { asset } (probe a media file to import: then ' +
    'addAsset({ id: uid(), ...asset })); window.kadr.writeProject(path, project); ' +
    'window.kadr.readProject(path).\n' +
    'Times are seconds. Animatable scalars (clip gain, transform.x/y/scale/rotation/opacity) are ' +
    'Anim objects — write { value: 0.5 }, NEVER a bare number. ' +
    'Mutations: always pushHistory first; the store is zustand — re-read ' +
    'getState() after each action. Example — add a media file to track V1 at 2s:\n' +
    'const ed = window.kadrEditor; const st = () => ed.useEditor.getState();\n' +
    'const { asset } = await window.kadr.probeMedia("/path/v.mp4");\n' +
    'const id = ed.uid(); st().pushHistory("hInsert"); st().addAsset({ id, ...asset });\n' +
    'const tr = st().project.tracks.find(t => t.name === "V1");\n' +
    'st().insertClipFromAsset(id, tr.id, 2); return st().project.tracks.length;',
  inputSchema: { code: z.string().describe('async function body to run in the editor page') }
}, async ({ code }) => {
  try { return asText(await editorEval(code)) } catch (e) { return asError(e) }
})

server.registerTool('kadr_export', {
  description:
    'Render the current Kadr project (or a time range of it) to a file and wait for completion. ' +
    'Uses the same WYSIWYG pipeline as the editor (GPU composite, effects, transitions, audio mix). ' +
    'presetId comes from kadr_state.exportPresets (default: first mp4). For audio-only output pick ' +
    'an audioOnly preset (mp3). Returns when the file is fully written.',
  inputSchema: {
    outputPath: z.string().describe('absolute output file path; extension should match the preset container'),
    presetId: z.string().optional(),
    start: z.number().optional().describe('range start, seconds'),
    end: z.number().optional().describe('range end, seconds'),
    motionBlur: z.boolean().optional().describe('default true'),
    frameBlending: z.boolean().optional().describe('default true')
  }
}, async ({ outputPath, presetId, start, end, motionBlur, frameBlending }) => {
  try {
    return asText(await editorEval(`
      const ed = window.kadrEditor
      const preset = ${JSON.stringify(presetId ?? null)}
        ? ed.PRESETS.find(p => p.id === ${JSON.stringify(presetId ?? '')})
        : ed.PRESETS.find(p => p.container === 'mp4')
      if (!preset) throw new Error('preset not found')
      const range = ${start != null && end != null ? `{ start: ${start}, end: ${end} }` : 'null'}
      const h = ed.startExport(ed.useEditor.getState().project, preset,
        ${JSON.stringify(outputPath)}, () => {}, range,
        { motionBlur: ${motionBlur !== false}, frameBlending: ${frameBlending !== false} })
      await h.done
      return { written: ${JSON.stringify(outputPath)}, preset: preset.id }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_transcribe', {
  description:
    'Speech-to-text over the project audio (local faster-whisper, anti-hallucination guards). ' +
    'Target is either a whole imported media file (assetId from kadr_state) or a timeline range ' +
    '[start, end) in project seconds (everything audible there, mixed like an export). Writes ' +
    '<name>.srt and <name>.txt next to the source media and registers them in project.texts ' +
    '(each entry has the absolute file path — you can Read/Edit those files directly; the ' +
    'editor subtitle panel picks up external edits). For ranges, timecodes "absolute" = ' +
    'project-timeline seconds, "relative" = from the range start; for whole files cue times are ' +
    'source-media seconds. Runs at roughly realtime speed for model large-v3 — expect a long call.',
  inputSchema: {
    assetId: z.string().optional().describe('transcribe this whole media file'),
    start: z.number().optional().describe('range start, project seconds'),
    end: z.number().optional().describe('range end, project seconds'),
    model: z.enum(['large-v3', 'medium', 'base']).optional().describe('default large-v3'),
    language: z.string().optional().describe("'auto' (default), 'ru', 'en', …"),
    timecodes: z.enum(['absolute', 'relative']).optional().describe('range targets only; default absolute'),
    maxWords: z.number().optional().describe(
      'words per cue: 1-4 = short precise cues from word-level timestamps (default 3), 0 = whole phrases')
  }
}, async ({ assetId, start, end, model, language, timecodes, maxWords }) => {
  try {
    const target = assetId
      ? { kind: 'asset', assetId }
      : { kind: 'range', start, end }
    if (!assetId && (typeof start !== 'number' || typeof end !== 'number')) {
      throw new Error('pass either assetId or start+end')
    }
    return asText(await editorEval(`
      const r = await window.kadrEditor.transcribe(${JSON.stringify({ target, model, language, timecodes, maxWords })})
      return { srtPath: r.srtPath, txtPath: r.txtPath, language: r.language,
               cues: r.segments.length,
               preview: r.segments.slice(0, 12).map(s => s.start.toFixed(1) + '-' + s.end.toFixed(1) + ' ' + s.text) }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_fragment_create', {
  description:
    'Create a Remotion fragment: an animated composition (React/TSX) living as a clip on the ' +
    'Kadr timeline at [start, end) project seconds. Use it for animations, dynamic subtitles, ' +
    'motion graphics, self-contained scenes. Returns the fragment id and the entry TSX file — ' +
    'EDIT THAT FILE with your normal file tools; the editor preview hot-reloads your changes ' +
    'live (no rendering during iteration; the real render happens once at export). Rules:\n' +
    '- the composition is sized to the project and runs at >=60 fps; meta.json in the fragment ' +
    'folder holds width/height/fps/durationInFrames — keep durationInFrames in sync if you ' +
    'change timing\n' +
    '- transparent: true (default) = overlay with alpha over the clips below; false = opaque ' +
    'self-contained scene\n' +
    '- to use media/images, copy or write files INTO the fragment folder and import them ' +
    '(import bg from "./bg.jpg") — absolute paths will not survive the final render bundling\n' +
    '- the module must keep exporting `fragment = { component, meta }`\n' +
    '- subtitle data: read SRT files from kadr_state project.texts and bake the cues into the ' +
    'composition (e.g. as a const array) for word-precise animated captions',
  inputSchema: {
    name: z.string().describe('short human name, e.g. "intro-title"'),
    start: z.number().describe('clip start, project seconds'),
    end: z.number().describe('clip end, project seconds'),
    transparent: z.boolean().optional().describe('default true (alpha overlay)')
  }
}, async ({ name, start, end, transparent }) => {
  try {
    return asText(await editorEval(`
      const r = await window.kadrEditor.createFragment(${JSON.stringify({ name, start, end, transparent })})
      let playerUrl = null
      try { playerUrl = (await window.kadrEditor.ensureFragmentServer()) + '/?comp=' + r.id } catch {}
      return { fragmentId: r.id, clipId: r.clipId, dir: r.dir, entryFile: r.entry,
               meta: r.meta, playerUrl }`))
  } catch (e) { return asError(e) }
})

server.connect(new StdioServerTransport()).catch((e) => {
  console.error('mcp-bridge failed:', e)
  process.exit(1)
})
