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

const server = new McpServer({ name: 'kadr', version: '2.1.0' })

const CAPABILITY_SECTIONS = [
  'all', 'model', 'projectFiles', 'timeline', 'animation', 'transforms', 'masks', 'effects',
  'transitions', 'audioSpeech', 'captions', 'fragments', 'voice', 'export', 'store'
]

server.registerTool('kadr_capabilities', {
  description:
    'Read the exact CURRENT machine-readable editing contract of the running Kadr editor. ' +
    'Call this before using an unfamiliar feature or writing raw project fields. It reports ' +
    'the live project/file model, chapter/group ranges, Anim/keyframe rules and time bases, 2D/3D transforms, masks, ' +
    'effect types with parameters/ranges/defaults, every valid overlap and edge transition id, ' +
    'timeline/store action signatures, captions, speech, Remotion, microphone/TTS and export ' +
    'presets/options. Runtime registries supply transition ids, effect/caption defaults and ' +
    'export presets, so this tool is authoritative when prose docs disagree. Request one ' +
    'section to save tokens, or all for a full capability audit.',
  inputSchema: {
    section: z.enum(CAPABILITY_SECTIONS).optional().describe(
      'default all; narrow to model|projectFiles|timeline|animation|transforms|masks|effects|transitions|' +
      'audioSpeech|captions|fragments|voice|export|store'
    )
  }
}, async ({ section }) => {
  try {
    return asText(await editorEval(`
      return window.kadrEditor.getCapabilities(${JSON.stringify(section ?? 'all')})`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voices', {
  description:
    'List every F5-TTS voice currently available to Kadr regeneration. Returns stable voiceId ' +
    'values, original reference numbers, Russian/English names and descriptions, plus global and ' +
    'project-embedded custom clones. For a custom voice copy the returned settings object into ' +
    'voiceoverGenerate; bundled voices only need settings.voiceId. The voice may change per take.',
  inputSchema: {}
}, async () => {
  try {
    return asText(await editorEval(`
      const section = window.kadrEditor.getCapabilities('voice')
      const tts = section.capabilities.localTts
      const global = await window.kadr.voiceCloneList()
      const project = window.kadrEditor.useEditor.getState().project.voiceClones || []
      const custom = [...global, ...project].filter((voice, index, all) =>
        all.findIndex((item) => item.id === voice.id) === index)
      return {
        engine: tts.engine,
        defaultVoiceId: tts.defaults.voiceId,
        voices: [
          ...tts.voices,
          ...custom.map(voice => ({
            id: voice.id,
            name: voice.name,
            description: voice.description || 'Пользовательский голосовой клон',
            custom: true,
            source: voice.source,
            createdAt: voice.createdAt,
            settings: { voiceId: voice.id, customVoice: voice }
          }))
        ]
      }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_voice_clone', {
  description:
    'Create a NEW persistent F5-TTS voice clone from an existing local audio file. The sourcePath ' +
    'must be an absolute path readable by Kadr; microphone capture itself must be done in the UI, ' +
    'but its saved recording can be passed here. The tool converts the source to a mono reference, ' +
    'optionally applies noise reduction, compression and LUFS normalization, saves it in Kadr’s ' +
    'global voice library, and by default adds it to the open project so the reference WAV is ' +
    'embedded on the next save/package. Each call creates a new clone. For best results use 3–15 ' +
    'seconds of clean single-speaker speech and provide the exact referenceText when known. Example: ' +
    '{sourcePath:"/Users/me/voice.wav",name:"Alex",referenceText:"Exact words spoken",' +
    'processing:{noiseReduction:true,normalization:true,targetLufs:-18},addToProject:true}.',
  inputSchema: {
    sourcePath: z.string().min(1).describe(
      'Absolute path to an existing audio/video file containing the reference speech.'),
    name: z.string().min(1).max(80).describe('Human-readable name shown in the Kadr voice selector.'),
    description: z.string().max(240).optional().describe('Optional voice character, e.g. “calm warm baritone”.'),
    referenceText: z.string().max(4000).optional().describe(
      'Exact words spoken in the reference. When omitted, Kadr transcribes and stores it before the voice becomes available.'),
    processing: z.object({
      normalization: z.boolean().optional().describe('Normalize integrated loudness; default true.'),
      targetLufs: z.number().min(-30).max(-10).optional().describe('Normalization target; default -18 LUFS.'),
      noiseReduction: z.boolean().optional().describe('Reduce steady background noise; default false.'),
      noiseStrength: z.number().min(0).max(1).optional().describe('Noise reduction strength 0..1; default 0.5.'),
      compressor: z.boolean().optional().describe('Control level peaks with a compressor; default false.'),
      compressorThresholdDb: z.number().min(-40).max(-3).optional().describe('Compressor threshold; default -18 dB.'),
      compressorRatio: z.number().min(1).max(12).optional().describe('Compressor ratio; default 3.'),
    }).optional().describe('Optional non-destructive preparation applied to the saved clone.'),
    addToProject: z.boolean().optional().describe(
      'Add clone metadata to the currently open project for portable saving; default true.')
  }
}, async ({ sourcePath, name, description, referenceText, processing, addToProject }) => {
  try {
    const absolute = /^(?:\/|[a-zA-Z]:[\\/]|\\\\)/.test(sourcePath)
    if (!absolute) throw new Error('sourcePath must be an absolute filesystem path')
    const options = {
      normalization: {
        enabled: processing?.normalization ?? true,
        targetLufs: processing?.targetLufs ?? -18
      },
      noiseReduction: {
        enabled: processing?.noiseReduction ?? false,
        strength: processing?.noiseStrength ?? 0.5
      },
      compressor: {
        enabled: processing?.compressor ?? false,
        thresholdDb: processing?.compressorThresholdDb ?? -18,
        ratio: processing?.compressorRatio ?? 3
      }
    }
    const result = await editorEval(`
      const sourcePath = ${JSON.stringify(sourcePath)}
      const prepared = await window.kadr.voiceClonePrepare(sourcePath)
      const processed = await window.kadr.voiceCloneProcess(prepared.path, ${JSON.stringify(options)})
      try {
        const suppliedText = ${JSON.stringify(referenceText ?? '')}.trim()
        const confirmedReferenceText = suppliedText || await window.kadr.voiceCloneTranscribe(processed.path)
        const voice = await window.kadr.voiceCloneSave({
          processedPath: processed.path,
          name: ${JSON.stringify(name)},
          description: ${JSON.stringify(description ?? '')},
          referenceText: confirmedReferenceText,
          source: 'file',
          sourceLabel: sourcePath.replace(/\\\\/g, '/').split('/').pop() || 'audio'
        })
        const addToProject = ${JSON.stringify(addToProject ?? true)}
        if (addToProject) {
          const store = window.kadrEditor.useEditor
          const state = store.getState()
          state.pushHistory('hVoiceClone')
          store.setState(current => ({
            project: {
              ...current.project,
              voiceClones: [
                ...(current.project.voiceClones || []).filter(item => item.id !== voice.id),
                voice
              ]
            }
          }))
        }
        const state = window.kadrEditor.useEditor.getState()
        return {
          voice,
          sourceDuration: prepared.duration,
          processedDuration: processed.duration,
          addedToProject: addToProject,
          projectPath: state.projectPath,
          portableOnNextSave: addToProject,
          referenceTextSource: suppliedText ? 'provided' : 'transcribed',
          generationSettings: { voiceId: voice.id, customVoice: voice }
        }
      } finally {
        await window.kadr.voiceCloneDiscard([prepared.path, processed.path])
      }
      `)
    return asText(result)
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_state', {
  description:
    'Read the LIVE state of the Kadr project currently open in the editor: full project ' +
    '(tracks→clips and annotation tasks, named chapters, assets with absolute media file paths, fps, size), projectPath, selection, ' +
    'playhead, and available export presets. All times are in seconds. tracks[0] is the topmost ' +
    'video track (drawn last). Clip: {id, kind: media|text|remotion, assetId, start, duration, inPoint, ' +
    'speed, gain, muted, transform, mask?, maskShapes?, effects[], transitionIn/Out?, fadeIn/Out?}. ' +
    'project.markers are the user\'s free-floating timeline markers ({id, time, label}) — use ' +
    'them as anchors the user set for you (\u00abfrom marker 2 to marker 3\u00bb). ' +
    'project.texts lists transcript/subtitle documents (TextDoc {id, name, path, format: srt|txt, ' +
    'assetId?, offset?}) — path is a real file you can Read/Edit; see kadr_transcribe to create them. ' +
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
        }))
      }`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_chapters', {
  description:
    'Read or replace the LIVE amber chapter/group map shown below the timeline seconds. ' +
    'Call with no chapters to list it. Pass the complete desired chapters array to replace it ' +
    'as ONE undoable edit; preserve returned ids when revising existing entries and omit id only ' +
    'for new chapters. Use this after organizing a timeline with distinct narrative or functional ' +
    'sections so the user can navigate the edit by meaningful groups. Prefer concise human titles, ' +
    'cover the intended structural ranges, keep ordinary chapters non-overlapping and ordered, and ' +
    'do not invent a meaningless one-chapter map for a short undivided edit. Chapters are metadata ' +
    'only and never change the rendered video. All times are project seconds and ranges are [start,end).',
  inputSchema: {
    chapters: z.array(z.object({
      id: z.string().min(1).optional().describe('Existing stable id; omit only for a new chapter.'),
      title: z.string().min(1).max(160),
      start: z.number().min(0),
      end: z.number().positive()
    })).optional().describe('Omit to list; pass the COMPLETE desired chapter map to replace.')
  }
}, async ({ chapters }) => {
  try {
    return asText(await editorEval(`
      const ed = window.kadrEditor
      const st = () => ed.useEditor.getState()
      const input = ${JSON.stringify(chapters ?? null)}
      if (input === null) return { chapters: st().project.chapters || [] }
      for (const chapter of input) {
        if (!(chapter.end > chapter.start)) {
          throw new Error('each chapter must have end > start')
        }
      }
      st().replaceChapters(input.map(chapter => ({
        id: chapter.id || ed.uid(),
        title: chapter.title,
        start: chapter.start,
        end: chapter.end
      })))
      return { chapters: st().project.chapters || [], undoable: true }
    `))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_tasks', {
  description:
    'List LIVE annotation tasks in timeline order. Each task has a stable random id, trackId/name, ' +
    'fixed start/end/duration in project seconds, text, status (new|in_progress|done), timestamps, ' +
    'and optional agent result. Always use the id for later calls. Timing is user-owned and may ' +
    'change while you work; re-list when you need the current range.',
  inputSchema: {
    status: z.enum(['new', 'in_progress', 'done']).optional(),
    trackId: z.string().optional()
  }
}, async ({ status, trackId }) => {
  try {
    return asText(await editorEval(`
      return window.kadrEditor.getAnnotationTasks(${JSON.stringify({ status, trackId })})`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_task_start', {
  description:
    'Mark one annotation task in progress by stable id. This never writes start or duration. ' +
    'If the user deleted the task, returns task-not-found and never recreates it.',
  inputSchema: { id: z.string() }
}, async ({ id }) => {
  try {
    return asText(await editorEval(`
      return window.kadrEditor.startAnnotationTask(${JSON.stringify(id)})`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_task_update', {
  description:
    'Patch only status and/or agent result of a task by stable id. Timing fields are intentionally ' +
    'not accepted, so a concurrent user drag cannot be overwritten.',
  inputSchema: {
    id: z.string(),
    status: z.enum(['new', 'in_progress', 'done']).optional(),
    result: z.string().optional()
  }
}, async ({ id, status, result }) => {
  try {
    return asText(await editorEval(`
      return window.kadrEditor.updateAnnotationTask(
        ${JSON.stringify(id)}, ${JSON.stringify({ status, result })})`))
  } catch (e) { return asError(e) }
})

server.registerTool('kadr_task_complete', {
  description:
    'Complete a task by stable id, save a concise result, and optionally apply the final editor ' +
    'mutation batch as ONE undo entry. `code` is an async-function body with the same page API as ' +
    'kadr_eval; prefer a short synchronous batch of store actions. The tool resolves the current ' +
    'live task immediately before applying changes and NEVER overwrites its start/duration. If the ' +
    'user deleted the task while you worked, it fails without recreating it.',
  inputSchema: {
    id: z.string(),
    result: z.string().min(1).describe('concise summary of what was changed'),
    code: z.string().optional().describe('optional final editor mutation batch; async-function body')
  }
}, async ({ id, result, code }) => {
  try {
    return asText(await editorEval(`
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor
      const mutate = ${JSON.stringify(code ?? '')}
        ? () => new AsyncFunction(${JSON.stringify(code ?? '')}).call(window)
        : undefined
      return window.kadrEditor.applyAnnotationTask(
        ${JSON.stringify(id)}, ${JSON.stringify(result)}, mutate)`))
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
    'addTrack(kind), replaceChapters([{id,title,start,end}]) (one undo), select([ids]), ' +
    'setPlayhead(sec), setProject(project), splitAtPlayhead(), ' +
    'addMarker(sec) (auto-numbered, returns id), moveMarker(id, sec), removeMarker(id), ' +
    'deleteSelection(), setTransition(clipId, type|null), setEdgeTransitions(...).\n' +
    '- window.kadrEditor.uid() → new id; .PRESETS → export presets; .projectDuration(project); ' +
    '.evalAnim(anim, t); await .reverseClip(clipId) — reverse a video/audio clip in place ' +
    '(renders a backwards copy, swaps the clip to it; calling again un-reverses); ' +
    'await .normalizeClip(clipId, {targetLufs?, peakDb?}) — measure the clip audio (EBU R128) ' +
    'and set its gain for −14 LUFS with a −1 dBTP ceiling (defaults); works on either half of a ' +
    'linked A/V pair, one undo entry, returns {gain, gainDb, measuredLufs, peakLimited}; ' +
    'await .snapshotFrame({t?, importToBin?}) — see kadr_snapshot; ' +
    'await .storyboardFrames({start,end,step?,maxFrames?,refresh?}) — see kadr_storyboard; ' +
    'await .importFiles([paths], {trackId, at}|null) — probe files into the bin (deduped by path) ' +
    'and, with a placement, lay them out back-to-back on the timeline from `at`.\n' +
    '- await window.kadr.probeMedia(path) → { asset } (probe a media file to import: then ' +
    'addAsset({ id: uid(), ...asset })); window.kadr.writeProject(path, project); ' +
    'window.kadr.readProject(path).\n' +
    'Times are seconds. Animatable scalars (gain, transforms, masks and track motion) are Anim ' +
    'objects. Call kadr_capabilities for their exact schema, time bases and safe keyframe updates; ' +
    'NEVER overwrite a keyed Anim with {value} unless removing its animation is intentional. ' +
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

server.registerTool('kadr_storyboard', {
  description:
    'YOUR EYES across a timeline range: render a source-quality WYSIWYG contact sheet with ' +
    'timestamp labels plus the individual full-resolution PNG frames. Read contactSheetPath ' +
    'first; inspect an individual frame path only when more detail is needed. Originals, not ' +
    'preview proxies, are decoded and Remotion fragments are included. The editor pauses only ' +
    'for capture and restores its playhead/playback afterward. Nothing is imported into the ' +
    'media bin. With refresh="auto" (default), a session cache is reused only when the exact ' +
    'request AND current visual fingerprint match; media file changes, fragment source edits, ' +
    'and visual timeline edits invalidate it. refresh="force" always regenerates. Generated ' +
    'PNGs live in the app-managed visual cache (bounded to 24 recent storyboard sets / 30 days). ' +
    'maxFrames is capped at 24.',
  inputSchema: {
    start: z.number().nonnegative().describe('range start in project seconds'),
    end: z.number().positive().describe('range end in project seconds; must be greater than start'),
    step: z.number().positive().optional().describe(
      'preferred spacing in seconds; when it would exceed maxFrames, samples are spread across the range'),
    maxFrames: z.number().int().min(1).max(24).optional().describe(
      'maximum captured frames; default 9'),
    refresh: z.enum(['auto', 'force']).optional().describe(
      'auto (default) reuses an exact current fingerprint; force always captures new PNGs')
  }
}, async ({ start, end, step, maxFrames, refresh }) => {
  try {
    if (!(end > start)) throw new Error('end must be greater than start')
    return asText(await editorEval(`
      return window.kadrEditor.storyboardFrames(${JSON.stringify({
        start, end, step, maxFrames, refresh: refresh ?? 'auto'
      })})`))
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

server.connect(new StdioServerTransport()).catch((e) => {
  console.error('mcp-bridge failed:', e)
  process.exit(1)
})
