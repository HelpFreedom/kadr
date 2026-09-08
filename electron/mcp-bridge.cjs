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
// Per-session secret for /eval. The editor generates it and passes it here
// through the generated --mcp-config, so it never touches disk in a
// world-readable place beyond that file; without it the bridge answers 403.
const TOKEN = process.argv[3] || ''
if (!PORT) {
  console.error('usage: mcp-bridge.cjs <editor-bridge-port> <token>')
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
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-kadr-token': TOKEN
        } },
      (res) => {
        let data = ''
        res.on('data', (c) => { data += c })
        res.on('end', () => {
          if (res.statusCode === 403) {
            reject(new Error('editor bridge rejected this session (stale token) — ' +
              'reopen the Kadr terminal panel'))
            return
          }
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

// claude kills the stdio transport when a single JSON-RPC message exceeds
// 16 MB ("stdout overflow → Connection closed") — cap every tool result far
// below that. Whole-project dumps with asset waveforms/thumbnails were the
// culprit; kadr_state strips those, this guard covers kadr_eval and the rest.
const MAX_TEXT = 4_000_000
const asText = (v) => {
  let text = JSON.stringify(v, null, 1)
  if (text.length > MAX_TEXT) {
    text = text.slice(0, MAX_TEXT) +
      '\n…[result truncated at 4 MB — return selected fields instead of whole ' +
      'objects; asset waveform/thumbnail blobs are the usual culprits]'
  }
  return { content: [{ type: 'text', text }] }
}
const asError = (e) => ({ content: [{ type: 'text', text: `Error: ${e.message || e}` }], isError: true })

const server = new McpServer({ name: 'kadr', version: '1.0.0' })

server.registerTool('kadr_state', {
  description:
    'Read the LIVE state of the Kadr project currently open in the editor: full project ' +
    '(tracks→clips, assets with absolute media file paths, fps, size), projectPath, selection, ' +
    'playhead, and available export presets. All times are in seconds. tracks[0] is the topmost ' +
    'video track (drawn last). Clip: {id, kind: media|text, assetId, start, duration, inPoint, ' +
    'speed, gain, muted, transform, mask?, maskShapes?, effects[], transitionIn/Out?, fadeIn/Out?}. ' +
    'project.markers are the user\'s free-floating timeline markers ({id, time, label}) — use ' +
    'them as anchors the user set for you (\u00abfrom marker 2 to marker 3\u00bb). ' +
    'project.texts lists transcript/subtitle documents (TextDoc {id, name, path, format: srt|txt, ' +
    'assetId?, offset?}) — path is a real file you can Read/Edit; see kadr_transcribe to create them. ' +
    'project.voiceRuns are ElevenLabs voice-overs ({id, assetId, scriptPath, scriptHash, tempo, runDir?}) ' +
    'and project.defects their suspected defects. THESE ARE NOT MARKERS AND NOT THE RANGE: a defect ' +
    'belongs to one audio clip, its src/phrase times are SOURCE seconds of that clip\'s asset, and ' +
    'only the USER turns proposed into confirmed/rejected. voiceDefects[] in this result is the same ' +
    'list with timeline seconds already worked out — seek with those, never compute them yourself ' +
    '(clip speed and inPoint are in it). ' +
    'Asset waveform/thumbnail blobs are omitted (hasWaveform/hasThumbnail flags remain).',
  inputSchema: {}
}, async () => {
  try {
    return asText(await editorEval(`
      const s = window.kadrEditor.useEditor.getState()
      // strip multi-MB base64 blobs: a >16 MB tool result makes claude drop
      // the whole MCP connection ("stdout overflow")
      const assets = s.project.assets.map(a => {
        const { waveform, thumbnail, thumbnailEnd, ...rest } = a
        return { ...rest, hasWaveform: !!waveform, hasThumbnail: !!thumbnail }
      })
      return {
        project: { ...s.project, assets },
        projectPath: s.projectPath,
        selection: s.selection,
        playhead: s.playhead,
        exportPresets: window.kadrEditor.PRESETS.map(p => ({
          id: p.id, name: p.name, container: p.container, audioOnly: !!p.audioOnly
        })),
        // source seconds mapped to the timeline here, once: doing it in the
        // model means getting speed/inPoint wrong sooner or later
        voiceDefects: window.kadrEditor.placeDefects(s.project).map(pl => ({
          id: pl.defect.id, runId: pl.defect.runId, clipId: pl.clipId,
          origin: pl.defect.origin, class: pl.defect.cls, tier: pl.defect.tier,
          confidence: pl.defect.confidence, state: pl.defect.state,
          words: pl.defect.words, src: pl.defect.src,
          phrase: [pl.defect.phrase.t0, pl.defect.phrase.t1],
          timeline: [pl.src.start, pl.src.end],
          phraseTimeline: pl.phrase ? [pl.phrase.start, pl.phrase.end] : null,
          text: (pl.defect.phrase.text || '').slice(0, 160)
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
    'insertClipFromAsset(assetId, trackId, startSec), insertClipsFromAssets([ids], trackId, at) ' +
    '(back-to-back, audio → audio track), removeAssets([assetIds]) (drops the bin entries AND every ' +
    'clip using them, one undo), setClipDuration(clipId, sec), setClipSpeed(clipId, speed, duration) ' +
    '(speed 0.02–100), addAsset(asset), ' +
    'addTrack(kind), select([ids]), setPlayhead(sec), setProject(project), splitAtPlayhead(), ' +
    'addMarker(sec) (auto-numbered, returns id), moveMarker(id, sec), removeMarker(id), ' +
    'deleteSelection(), setTransition(clipId, type|null), setEdgeTransitions(...).\n' +
    '- window.kadrEditor.uid() → new id; .PRESETS → export presets; .projectDuration(project); ' +
    '.evalAnim(anim, t); await .reverseClip(clipId) — reverse a video/audio clip in place ' +
    '(renders a backwards copy, swaps the clip to it; calling again un-reverses); ' +
    'await .normalizeClip(clipId, {targetLufs?, peakDb?}) — measure the clip audio (EBU R128) ' +
    'and set its gain for −14 LUFS with a −1 dBTP ceiling (defaults); works on either half of a ' +
    'linked A/V pair, one undo entry, returns {gain, gainDb, measuredLufs, peakLimited}; ' +
    'await .snapshotFrame({t?, importToBin?}) — see kadr_snapshot; ' +
    'await .importFiles([paths], {trackId, at}|null) — probe files into the bin (deduped by path) ' +
    'and, with a placement, lay them out back-to-back on the timeline from `at`.\n' +
    '- await window.kadr.probeMedia(path) → { asset } (probe a media file to import: then ' +
    'addAsset({ id: uid(), ...asset })); window.kadr.writeProject(path, project); ' +
    'window.kadr.readProject(path).\n' +
    'Times are seconds. Animatable scalars (clip gain, transform.x/y/scale/rotation/opacity) are ' +
    'Anim objects — write { value: 0.5 }, NEVER a bare number. ' +
    'Mutations: always pushHistory first; the store is zustand — re-read ' +
    'getState() after each action. NEVER return whole project/asset objects — asset ' +
    'waveform/thumbnail blobs are megabytes of base64 (results are truncated at 4 MB); ' +
    'return the specific fields you need. Example — add a media file to track V1 at 2s:\n' +
    'const ed = window.kadrEditor; const st = () => ed.useEditor.getState();\n' +
    'const { asset } = await window.kadr.probeMedia("/path/v.mp4");\n' +
    'const id = ed.uid(); st().pushHistory("hInsert"); st().addAsset({ id, ...asset });\n' +
    'const tr = st().project.tracks.find(t => t.name === "V1");\n' +
    'st().insertClipFromAsset(id, tr.id, 2); return st().project.tracks.length;',
  inputSchema: { code: z.string().describe('async function body to run in the editor page') }
}, async ({ code }) => {
  try { return asText(await editorEval(code)) } catch (e) { return asError(e) }
})

server.registerTool('kadr_snapshot', {
  description:
    'YOUR EYES on the timeline: render the WYSIWYG frame at time t (default: current playhead) ' +
    'to a PNG at project resolution and return its absolute path — then Read that file to SEE ' +
    'the frame (composition, text placement, colors, effects). Media decodes at SOURCE quality ' +
    '(originals, not the preview proxies); Remotion fragments are included (forced through ' +
    'pixel capture). The PNG lands next to the project file (Downloads if the project was ' +
    'never saved) and is imported into the media bin unless importToBin=false — pass false ' +
    'when you only need to look. Takes ~2 s, up to ~5 s with fragments or many clips.',
  inputSchema: {
    t: z.number().optional().describe('project time in seconds; default = current playhead'),
    importToBin: z.boolean().optional().describe('default true: register the PNG as a media asset')
  }
}, async ({ t, importToBin }) => {
  try {
    return asText(await editorEval(`
      const r = await window.kadrEditor.snapshotFrame(${JSON.stringify({ t, importToBin })})
      return r`))
  } catch (e) { return asError(e) }
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
    'live (no rendering during iteration; the real render happens once at export). For a saved ' +
    'project the fragment folder lives next to the .kadr file (<projectDir>/kadr-fragments/<id>); ' +
    'unsaved projects keep it in the shared workspace until the first save moves it over. Rules:\n' +
    '- the composition is sized to the project and runs at >=60 fps; meta.json in the fragment ' +
    'folder holds width/height/fps/durationInFrames — keep durationInFrames in sync if you ' +
    'change timing\n' +
    '- transparent: true (default) = overlay with alpha over the clips below; false = opaque ' +
    'self-contained scene\n' +
    '- to use media/images, copy or write files INTO the fragment folder and import them ' +
    '(import bg from "./bg.jpg") — absolute paths will not survive the final render bundling\n' +
    '- embed video with <Video>, NOT <OffthreadVideo>: the latter needs Remotion\'s native ' +
    'compositor (glibc >= 2.32) and dies on older systems with "GLIBC_2.3x not found"\n' +
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

server.registerTool('kadr_neon_wave', {
  description:
    'Generate a «neon wave» clip: an audio-reactive glowing sine line (the user\'s Blender ' +
    'preset rebuilt as a Remotion fragment) over [start, end) project seconds. The loudness of ' +
    'the timeline mix in that range — or of ONE audio track when trackId is given — drives the ' +
    'wiggle frequency and height (Blender "Bake Sound" follower: 5 ms attack / 200 ms release). ' +
    'Opaque black background, project size, >=60 fps; lands on the topmost free video track and ' +
    'is selected. Returns the fragment id and its entry TSX: `S` at the top holds every style ' +
    'knob (colour ramp, glow, streaks, amplitude, speed), `ENV` the loudness per frame — edit ' +
    'the file to restyle, the preview hot-reloads. Regenerate (call again) after the audio changes.',
  inputSchema: {
    start: z.number().describe('clip start, project seconds'),
    end: z.number().describe('clip end, project seconds'),
    trackId: z.string().optional().describe('restrict the sound to this audio track (from kadr_state); default = whole mix'),
    name: z.string().optional().describe('fragment name, default "wave"')
  }
}, async ({ start, end, trackId, name }) => {
  try {
    const opts = { range: { start, end }, source: trackId ? { trackId } : 'mix', name }
    return asText(await editorEval(`
      const r = await window.kadrEditor.neonWave(${JSON.stringify(opts)})
      return { fragmentId: r.fragmentId, clipId: r.clipId, entryFile: r.entry, frames: r.frames, peak: r.peak }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_speak', {
  description:
    'Voice a text through ElevenLabs and put the audio on the timeline. Needs an API key set in ' +
    'the editor\'s voice-over settings (it lives in the main process; nothing here can read it). ' +
    'Give exactly one source: `text` verbatim, `textDocId` from project.texts, or `path` to a ' +
    'txt/srt on disk. Lands on a free audio track at `at` (default: the playhead), CREATING an ' +
    'audio track if the project has none. Writes <name>.script.txt next to the audio — the exact ' +
    'text that was synthesised — and registers it in project.texts; kadr_voice_check aligns ' +
    'against THAT file, so never retype it. COSTS ElevenLabs credits: say so before calling.',
  inputSchema: {
    text: z.string().optional().describe('the text itself'),
    textDocId: z.string().optional().describe('id of a document from project.texts'),
    path: z.string().optional().describe('absolute path to a .txt/.srt'),
    at: z.number().optional().describe('timeline second to place it at; default = playhead'),
    name: z.string().optional().describe('base name for the produced files')
  }
}, async ({ text, textDocId, path, at, name }) => {
  try {
    const given = [text, textDocId, path].filter((x) => x !== undefined)
    if (given.length !== 1) throw new Error('pass exactly one of text / textDocId / path')
    const opts = { text, textDocId, path, at, name }
    return asText(await editorEval(`
      const r = await window.kadrEditor.speakText(${JSON.stringify(opts)})
      return { runId: r.runId, assetId: r.assetId, clipId: r.clipId, path: r.path,
               scriptPath: r.scriptPath, duration: r.duration, tempo: r.tempo, chunks: r.chunks }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_check', {
  description:
    'Run the local defect detector (python/ttsqc) over ONE voice-over and fill project.defects. ' +
    'Takes MINUTES and holds the GPU — warn the user, then call and wait, do not retry mid-flight; ' +
    'an export must not be running. Analyses the asset file itself against the script that was ' +
    'synthesised; refuses if that script has been edited since (word indices would be lies). ' +
    'Everything it finds arrives as state "proposed": deciding is the USER\'s job, done by ' +
    'clicking the violet flags. Returns counts and the analysis trust (below 0.9 the list is ' +
    'probably incomplete).',
  inputSchema: {
    runId: z.string().optional().describe('voice run from project.voiceRuns; default = the selected clip\'s'),
    assetId: z.string().optional().describe('or pick the run by its audio asset'),
    minConfidence: z.number().optional().describe('0 = show every candidate (default), 0.4-0.8 = working thresholds'),
    device: z.string().optional().describe('"cuda" (default) or "cpu"')
  }
}, async ({ runId, assetId, minConfidence, device }) => {
  try {
    const opts = { runId, assetId, minConfidence, device }
    return asText(await editorEval(`
      const r = await window.kadrEditor.checkVoice(${JSON.stringify(opts)})
      const p = window.kadrEditor.useEditor.getState().project
      const mine = (p.defects || []).filter(d => d.runId === r.runId)
      const byClass = {}
      for (const d of mine) byClass[d.cls || '?'] = (byClass[d.cls || '?'] || 0) + 1
      return { runId: r.runId, defects: r.defects, trust: r.trust, runDir: r.runDir, byClass }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_verdict', {
  description:
    'Record the verdict on defects: defect=true means "yes, regenerate this phrase", false means ' +
    '"not a defect". ONLY use this when the user has told you their decision in words — the ' +
    'verdicts also become training data for the detector, so guessing on their behalf poisons it. ' +
    'Every verdict is one undo entry.',
  inputSchema: {
    ids: z.array(z.string()).describe('defect ids from kadr_state.voiceDefects'),
    defect: z.boolean().describe('true = confirmed defect, false = not a defect')
  }
}, async ({ ids, defect }) => {
  try {
    return asText(await editorEval(`
      window.kadrEditor.setVerdict(${JSON.stringify(ids)}, ${defect ? 'true' : 'false'})
      const p = window.kadrEditor.useEditor.getState().project
      const st = {}
      for (const d of (p.defects || [])) st[d.state] = (st[d.state] || 0) + 1
      return { updated: ${ids.length}, states: st }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_mark', {
  description:
    'Record a defect the detector missed, at a place the USER pointed out. Times are TIMELINE ' +
    'seconds; the editor maps them into the audio and works out which phrase they fall in, using ' +
    'the finished analysis (no models are loaded). Requires kadr_voice_check to have run once. ' +
    'This is the only channel that can teach the detector to find a kind of defect it never ' +
    'proposes — so place them where the user says, never on a hunch.',
  inputSchema: {
    start: z.number().describe('timeline seconds'),
    end: z.number().describe('timeline seconds'),
    assetId: z.string().optional().describe('voice-over asset; default = the only one')
  }
}, async ({ start, end, assetId }) => {
  try {
    return asText(await editorEval(`
      const E = window.kadrEditor, s = E.useEditor.getState()
      const runs = s.project.voiceRuns || []
      const run = ${JSON.stringify(assetId ?? null)}
        ? runs.find(r => r.assetId === ${JSON.stringify(assetId ?? null)}) : runs[0]
      if (!run) throw new Error('no voice-over in this project')
      const clip = s.project.tracks.flatMap(t => t.clips)
        .find(c => c.assetId === run.assetId && ${start} < c.start + c.duration && ${end} > c.start)
      if (!clip) throw new Error('no clip of that voice-over covers this time')
      const a = E.projectToSrc(clip, ${start}), b = E.projectToSrc(clip, ${end})
      const id = await E.addUserDefect(run.assetId, a, b)
      const d = E.useEditor.getState().project.defects.find(x => x.id === id)
      return { id, src: d.src, phrase: [d.phrase.t0, d.phrase.t1], text: d.phrase.text }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_regenerate', {
  description:
    'Re-synthesise the CONFIRMED defective phrases of one voice-over and splice them back into ' +
    'the audio. Acts ONLY on defects whose state is "confirmed" — it will not touch "proposed" ' +
    'ones, because confirming is the user\'s judgement, not yours. Phrases that touch are merged ' +
    'and everything is spliced in one pass: one new audio file, one undo entry. ' +
    'The patch is sped up by the SAME factor the file was (VoiceRun.tempo), levelled to the ' +
    'stretch it replaces and joined with equal-power crossfades in the silence between sentences. ' +
    'The result is almost never the same length, so by default everything after the splice is ' +
    'SHIFTED (ripple) across all unlocked tracks — otherwise the picture would drift out of sync. ' +
    'COSTS ElevenLabs credits, one request per phrase: tell the user how many before calling. ' +
    'Refuses when a clip boundary falls inside a phrase being replaced.',
  inputSchema: {
    runId: z.string().optional().describe('voice run; default = the one with confirmed defects'),
    ids: z.array(z.string()).optional().describe('specific defect ids; default = all confirmed'),
    ripple: z.boolean().optional().describe('shift what follows (default true)'),
    rippleAllTracks: z.boolean().optional().describe('shift on every unlocked track (default true)'),
    reverify: z.boolean().optional().describe('run the detector again afterwards (minutes)')
  }
}, async ({ runId, ids, ripple, rippleAllTracks, reverify }) => {
  try {
    const opts = { runId, ids, ripple, rippleAllTracks, reverify }
    return asText(await editorEval(`
      const r = await window.kadrEditor.regenerateDefects(${JSON.stringify(opts)})
      return { phrases: r.units, newAssetId: r.newAssetId, deltaSeconds: r.delta,
               duration: r.duration, seams: r.seams, warnings: r.warnings }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_learn', {
  description:
    'Look at, and optionally retrain, the defect detector\'s confidence model from the verdicts ' +
    'collected so far. WITHOUT retrain (the default) it only reports what the corpus holds — ' +
    'examples, files, how many of the user\'s own marks are usable — and touches nothing. ' +
    'With retrain:true AND confirm:true it rebuilds the model FROM SCRATCH and overwrites the ' +
    'file, which is shared with the user\'s own console ttsqc; the previous model is backed up ' +
    'first. Only ever do this when the user asks for it in so many words — never as tidying up. ' +
    'Be honest about what it buys: confirming and rejecting raises PRECISION; recall only moves ' +
    'for marks the generator already had a candidate for, and marks it never proposes at all ' +
    'cannot be learned by this model — they are counted separately (userUnmatched).',
  inputSchema: {
    retrain: z.boolean().optional().describe('rebuild the model (default: only report)'),
    confirm: z.boolean().optional().describe('required together with retrain:true')
  }
}, async ({ retrain, confirm }) => {
  try {
    if (retrain && !confirm) {
      throw new Error('retraining overwrites the machine-wide model — pass confirm:true once the user has agreed')
    }
    return asText(await editorEval(`
      await window.kadrEditor.flushAllVerdicts()
      const r = await window.kadrEditor.${retrain ? 'retrain()' : 'learnStatus()'}
      return r`))
  } catch (e) { return asError(e) }
})

server.connect(new StdioServerTransport()).catch((e) => {
  console.error('mcp-bridge failed:', e)
  process.exit(1)
})
