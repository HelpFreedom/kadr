// Machine-readable editor contract for AI/MCP clients. Keep capability values
// close to the runtime registries they describe: transition ids, effect
// defaults, caption defaults and export presets are imported from the same
// modules the UI and renderer use, so the agent never relies on a stale list.
import { TRANSITIONS, DEFAULT_TRANSITION } from '@/gl/transitions'
import { EDGE_TRANSITIONS, DEFAULT_EDGE_DURATION } from '@/gl/edges'
import { GLOW_DEFAULTS } from '@/gl/glow'
import { CAPTION_DEFAULTS } from './captions'
import { PRESETS } from '@/presets'
import { DEFAULT_VOICEOVER_SETTINGS, VOICEOVER_VOICES } from '@shared/voiceover'

export const CAPABILITY_SECTION_NAMES = [
  'model',
  'projectFiles',
  'timeline',
  'animation',
  'transforms',
  'masks',
  'effects',
  'transitions',
  'audioSpeech',
  'captions',
  'fragments',
  'voice',
  'export',
  'store'
] as const

export type CapabilitySection = (typeof CAPABILITY_SECTION_NAMES)[number]

const param = (
  unit: string,
  defaultValue: number,
  min: number | null = null,
  max: number | null = null,
  step: number | null = null
) => ({ unit, default: defaultValue, min, max, step, animatable: true })

function sections(storeActions: string[]) {
  return {
    model: {
      times: 'seconds',
      project: {
        fields: ['version', 'id', 'name', 'width', 'height', 'fps', 'background', 'tracks', 'assets', 'texts', 'chapters'],
        trackOrder: 'tracks[0] is the topmost video layer and is drawn last'
      },
      chapter: {
        fields: ['id', 'title', 'start', 'end'],
        timing: '[start,end) in project seconds; structural metadata only, never rendered',
        identity: 'stable random id; preserve ids when revising an existing chapter map'
      },
      track: {
        kinds: ['video', 'audio', 'annotation'],
        fields: ['id', 'kind', 'name', 'muted', 'locked', 'gain', 'motion', 'clips', 'annotations'],
        gain: 'audio track volume 0..2; video track opacity 0..1; ignored for annotation tracks'
      },
      annotationTask: {
        fields: [
          'id', 'text', 'status', 'start', 'duration', 'result',
          'createdAt', 'updatedAt', 'completedAt'
        ],
        statuses: ['new', 'in_progress', 'done'],
        identity: 'stable random id; never derive identity from timing',
        timing: 'fixed project seconds, user-owned, never follows media clips and never renders'
      },
      clip: {
        kinds: ['media', 'text', 'remotion'],
        fields: [
          'id', 'assetId', 'kind', 'fragmentId', 'fragmentMeta', 'text', 'textStyle',
          'voiceover', 'start', 'duration', 'inPoint', 'speed', 'fadeIn', 'fadeOut',
          'gain', 'muted', 'transform', 'mask', 'maskShapes', 'effects', 'linkId',
          'transitionIn', 'transitionOut', 'label'
        ],
        looping: 'duration beyond the remaining source span loops media',
        linkedPairs: 'video and audio clips imported together share linkId and normally move/edit together'
      },
      mediaAsset: {
        kinds: ['video', 'audio', 'image'],
        fields: [
          'id', 'path', 'name', 'kind', 'duration', 'width', 'height', 'fps',
          'hasAudio', 'codec', 'proxyPath', 'reverseOf', 'voice'
        ],
        importPipeline: 'ffprobe metadata + thumbnails + waveform; >=720p video may receive a 540p proxy; export uses path/original'
      }
    },

    projectFiles: {
      format: '.kadr JSON project file',
      read: 'await window.kadr.readProject(absolutePath)',
      write: 'await window.kadr.writeProject(absolutePath, project)',
      portablePackage: {
        action: 'await window.kadr.packageProject(parentDir, sourceProjectPath|null, project, options)',
        options: {
          includeDependencies: 'copy media, transcript files, voice sources/versions and Remotion fragments into the project folder',
          zip: 'also create a zip archive beside the packaged folder'
        },
        result: '{projectPath,folderPath,zipPath?}',
        pathRules: 'packaged projects use relative dependency paths; readProject resolves them and restores packaged fragments'
      },
      autosave: {
        action: 'await window.kadrEditor.autosaveNow()',
        behavior: 'writes <project-name>.autosave.kadr beside a saved project when dirty; pauses during export or an active Claude session'
      },
      recovery: 'read/write are non-interactive; use absolute paths and never overwrite a user file without explicit intent'
    },

    timeline: {
      conventions: [
        'clip.start/duration/inPoint and fades are timeline seconds',
        'mutating low-level fields requires pushHistory(label) once before the batch',
        'high-level actions document whether they push their own history entry',
        're-read useEditor.getState() after every action: zustand state objects are immutable snapshots'
      ],
      speed: {
        uiRange: { min: 0.02, max: 100 },
        action: 'setClipSpeed(clipId, speed, duration, start?)',
        behavior: 'rescales clip-local keyframes and fades; linked partners follow; optional start anchors a left-edge speed edit'
      },
      actions: {
        import: 'await importFiles([absolutePaths], {trackId, at}|null)',
        insert: 'insertClipFromAsset(assetId, trackId|null, at)',
        insertBatch: 'insertClipsFromAssets(assetIds, trackId|null, at)',
        text: 'insertTextClip(at)',
        move: 'moveClip(clipId, trackId, start) or setClipStarts(entries)',
        trim: "trimClip(clipId, 'in'|'out', time)",
        split: 'setPlayhead(t); select([clipId]); splitAtPlayhead()',
        keepRanges: 'splitClipIntoRanges(clipId, [{start,end}, ...]) where ranges are clip-local seconds',
        delete: 'select(ids); deleteSelection()',
        durationOrLoop: 'setClipDuration(clipId, duration)',
        link: 'select two clips; toggleLinkSelection()',
        reverse: 'await window.kadrEditor.reverseClip(clipId)',
        normalize: 'await window.kadrEditor.normalizeClip(clipId, {targetLufs?, peakDb?})',
        chapters: 'prefer the kadr_chapters MCP tool; replaceChapters(chapters) is the store action',
        annotationTasks: 'prefer kadr_tasks / kadr_task_start / kadr_task_complete MCP tools; they patch by id without timing fields'
      }
    },

    animation: {
      animSchema: {
        value: 'number: fallback/static value',
        keyframes: "optional sorted [{time:number,value:number,easing:'linear'|'easeIn'|'easeOut'|'easeInOut'|'hold'}]",
        smooth: 'optional boolean; continuous asymmetric smoothing and Catmull-Rom through 3+ keys'
      },
      easing: ['linear', 'easeIn', 'easeOut', 'easeInOut', 'hold'],
      timeBases: {
        clipProperties: 'keyframe.time is relative to clip.start',
        trackMotion: 'keyframe.time is absolute project time'
      },
      safeEdit: [
        'Never replace an existing Anim with {value} when it has keyframes unless the user asked to remove animation.',
        'To set a keyed value, clone the current Anim, upsert a key at the correct time base, preserve smooth, sort keys by time.',
        'The easing stored on a key controls the segment from that key to the next key.'
      ],
      example: {
        existing: { value: 1, smooth: false, keyframes: [{ time: 0, value: 1, easing: 'easeInOut' }] },
        addAtClipLocalSecond2: { value: 1, smooth: false, keyframes: [
          { time: 0, value: 1, easing: 'easeInOut' },
          { time: 2, value: 1.5, easing: 'easeOut' }
        ] }
      }
    },

    transforms: {
      clip: {
        x: param('project px from center', 0, null, null, 1),
        y: param('project px from center', 0, null, null, 1),
        scale: param('1 = fitted source size', 1, 0.01, 20, 0.05),
        rotation: param('degrees around Z', 0, null, null, 1),
        opacity: param('ratio', 1, 0, 1, 0.05),
        rotX: param('degrees; presence enables 3D', 0, null, null, 1),
        rotY: param('degrees; presence enables 3D', 0, null, null, 1),
        z: param('project px depth; presence enables 3D', 0, null, null, 10)
      },
      trackMotion: {
        fields: ['x', 'y', 'scale', 'rotation', 'rotX', 'rotY', 'z'],
        timeBase: 'absolute project seconds',
        applicationOrder: 'applied after each clip transform to every clip on the video track'
      },
      perspective: 'perspective-correct GPU projection; rotX/rotY/z work on media, text and captured Remotion fragments'
    },

    masks: {
      crop: {
        fields: ['left', 'top', 'right', 'bottom'],
        each: param('fraction of layer', 0, 0, 0.49, 0.01)
      },
      shapes: {
        maxPerClip: 8,
        types: ['rect', 'ellipse', 'triangle'],
        fields: {
          cx: param('layer UV', 0.5, -0.5, 1.5, 0.01),
          cy: param('layer UV', 0.5, -0.5, 1.5, 0.01),
          w: param('layer UV size', 0.5, 0.01, 2, 0.01),
          h: param('layer UV size', 0.5, 0.01, 2, 0.01),
          featherIn: param('layer-height fraction', 0, 0, 0.5, 0.005),
          featherOut: param('layer-height fraction', 0, 0, 0.5, 0.005),
          invert: { type: 'boolean', default: false, animatable: false }
        },
        composition: 'union of normal shapes minus inverted shapes; crop and shape masks both apply'
      }
    },

    effects: {
      stack: 'clip.effects is ordered; each item is {id,type,enabled,params}',
      types: [
        {
          type: 'blur',
          defaults: { size: 20 },
          params: { size: { unit: 'project px', min: 0, max: 300, step: 1 } }
        },
        {
          type: 'glow',
          defaults: { ...GLOW_DEFAULTS },
          params: {
            color: { type: 'hex color string' },
            size: { unit: 'project px', min: 4, max: 400, step: 1 },
            intensity: { min: 0, max: 3, step: 0.05 },
            saturation: { min: 0, max: 2, step: 0.05 },
            smoke: { min: 0, max: 1, step: 0.05 },
            speed: { min: 0, max: 3, step: 0.05 },
            particles: { min: 0, max: 1, step: 0.05 }
          }
        }
      ],
      presets: {
        store: 'window.kadrEditor.useFxPresets.getState()',
        save: 'savePreset({name,effects})',
        apply: 'clone preset effects with fresh uid() values and cloned params, then updateClip',
        delete: 'deletePreset(id)',
        scope: 'app-wide, persisted across projects'
      }
    },

    transitions: {
      overlap: {
        behavior: 'overlap two visual clips on one track; overlap duration is transition duration',
        action: 'setTransition(incomingClipId, type|null); null means hard cut',
        default: DEFAULT_TRANSITION,
        effects: TRANSITIONS.map(({ id, nameKey }) => ({ id, nameKey })),
        menuChoicesIncludingHardCut: TRANSITIONS.length + 1
      },
      edge: {
        behavior: 'tip effect on an in/out edge; matched out+in effects hide a butt-joint cut at peak intensity',
        action: "setEdgeTransitions([{clipId,edge:'in'|'out',type,duration}, ...])",
        defaultDuration: DEFAULT_EDGE_DURATION,
        effects: EDGE_TRANSITIONS.map(({ id, nameKey }) => ({ id, nameKey }))
      }
    },

    audioSpeech: {
      gain: 'clip.gain is Anim, normally 0..2; track.gain is a scalar 0..2',
      fades: 'fadeIn/fadeOut are timeline seconds; overlapping audible clips on one track crossfade automatically',
      normalize: { action: 'await normalizeClip(clipId, options?)', defaults: { targetLufs: -14, peakDb: -1 } },
      transcription: {
        tool: 'kadr_transcribe',
        models: ['large-v3', 'medium', 'base'],
        targets: ['assetId', 'timeline start+end'],
        languageDefault: 'auto',
        timecodes: ['absolute', 'relative'],
        maxWords: '1..4 for word-timed cues; 0 for phrases; default 3',
        output: 'SRT + TXT registered in project.texts',
        protections: ['VAD', 'no cross-segment conditioning', 'confidence thresholds', 'long-pause rejection', 'repeat filters']
      }
    },

    captions: {
      creation: 'await window.kadrEditor.autoCaptions({range,style,maxWords,model?,language?})',
      defaults: { ...CAPTION_DEFAULTS },
      style: {
        fontFamily: 'string',
        fontSize: 'project px',
        bold: 'boolean',
        color: 'CSS color',
        highlightColor: 'CSS color',
        entrance: ['pop', 'fade', 'rise', 'none'],
        highlight: ['color', 'pop', 'box', 'none'],
        speed: { min: 0.5, max: 2 }
      },
      result: 'transparent Remotion fragment with word-level timing, placed on a free top video track'
    },

    fragments: {
      tool: 'kadr_fragment_create',
      kinds: ['transparent overlay', 'opaque scene'],
      timing: 'clip is [start,end); composition fps is max(60, project.fps)',
      editing: 'edit returned entryFile; Vite hot reload updates preview; final render happens once during export',
      contract: 'keep exporting fragment={component,meta}; keep meta.json durationInFrames synchronized',
      mediaRule: 'copy media into the fragment folder and import it relatively; absolute paths do not bundle',
      clipFeatures: 'fragment clips accept transforms, 3D, masks, effects and transitions like visual clips'
    },

    voice: {
      recording: {
        surface: 'UI microphone studio; browser permission and a real audio input are required',
        effects: ['input gain', 'leveling', 'noise high-pass/suppression', 'compressor', 'delay'],
        autoCut: 'splitClipIntoRanges keeps detected speech islands at their original timeline positions',
        assetMetadata: "asset.voice.source is 'microphone'|'neural-tts'; rawPath preserves the pre-effect recording when present"
      },
      localTts: {
        engine: 'F5-TTS',
        status: 'await window.kadr.voiceoverStatus(settings)',
        generate: 'await window.kadr.voiceoverGenerate({clipId,projectPath,version,text,settings})',
        clone: {
          list: 'await window.kadr.voiceCloneList()',
          prepare: 'await window.kadr.voiceClonePrepare(sourcePath)',
          process: 'await window.kadr.voiceCloneProcess(previewPath, options)',
          save: 'await window.kadr.voiceCloneSave({processedPath,name,description,referenceText,source,sourceLabel})',
          portability: 'project.voiceClones and settings.customVoice references are copied beside every saved or packaged project'
        },
        defaults: { ...DEFAULT_VOICEOVER_SETTINGS },
        voices: VOICEOVER_VOICES.map(({ id, number, name, nameEn, description, descriptionEn }) => ({
          id, number, name, nameEn, description, descriptionEn
        })),
        selection: 'bundled: set settings.voiceId; custom: set both settings.voiceId and settings.customVoice',
        result: 'probe result.path, add an audio asset, then update clip.voiceover history and selected assetId'
      }
    },

    export: {
      tool: 'kadr_export',
      presets: PRESETS.map((p) => ({
        id: p.id,
        name: p.name,
        container: p.container,
        width: p.width,
        height: p.height,
        fps: p.fps,
        audioOnly: !!p.audioOnly
      })),
      range: 'optional [start,end) project seconds',
      options: {
        motionBlur: 'default true; 180-degree shutter averaging 8 subframes',
        frameBlending: 'default true; blends adjacent source frames when source cadence is below project fps'
      },
      wysiwyg: 'same GPU compositor as preview; original media paths are used instead of proxies'
    },

    store: {
      access: 'window.kadrEditor.useEditor.getState()',
      availableActions: storeActions,
      importantSignatures: {
        updateClip: 'updateClip(clipId, Partial<Clip>)',
        updateTrack: 'updateTrack(trackId, Partial<Track>)',
        setTransition: 'setTransition(clipId, type|null)',
        setEdgeTransitions: "setEdgeTransitions([{clipId,edge:'in'|'out',type:string|null,duration?:number}])",
        setClipStarts: 'setClipStarts([{id,start,trackId?}])',
        splitClipIntoRanges: 'splitClipIntoRanges(clipId, [{start,end}])',
        replaceChapters: 'replaceChapters([{id,title,start,end}]) — replaces the full map as one undo entry',
        updateChapter: 'updateChapter(id, {title?,start?,end?}); pushHistory once before a low-level batch',
        pushHistory: 'pushHistory(label) once before a low-level edit batch'
      },
      presetStores: ['usePosePresets', 'useFxPresets']
    }
  }
}

export function getEditorCapabilities(
  section: string = 'all',
  storeActions: string[] = []
) {
  const data = sections(storeActions)
  const base = {
    apiVersion: 2,
    editor: 'Kadr',
    availableSections: [...CAPABILITY_SECTION_NAMES],
    generatedFromRuntimeRegistries: ['TRANSITIONS', 'EDGE_TRANSITIONS', 'GLOW_DEFAULTS', 'CAPTION_DEFAULTS', 'PRESETS']
  }
  if (section === 'all') return { ...base, sections: data }
  if (!CAPABILITY_SECTION_NAMES.includes(section as CapabilitySection)) {
    throw new Error(`unknown capability section: ${section}; use one of ${CAPABILITY_SECTION_NAMES.join(', ')}, all`)
  }
  return { ...base, section, capabilities: data[section as CapabilitySection] }
}
