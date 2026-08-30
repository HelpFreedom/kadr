// Regenerating a defective phrase and splicing it back into the voice-over.
//
// Everything confirmed on one voice-over is done in ONE pass: the phrases are
// merged where they touch, synthesised, and spliced in a single ffmpeg command.
// That is not an optimisation — doing them one at a time would mean recomputing
// every later cut point in an already-shifted file, which is a whole family of
// off-by-milliseconds bugs that simply cannot occur this way. It also gives one
// new asset, one undo entry and one re-analysis.
import { useEditor, uid } from '../state/store'
import { activity } from './autosave'
import { useTtsSettings, ttsParams } from './tts'
import { useVoiceUi, checkVoice, setVerdict } from './voiceCheck'
import { flushVerdicts } from './voiceLearn'
import type { AudioDefect, MediaAsset, VoiceRun } from '@shared/types'

/** phrases closer than this are regenerated as one: a seam between two patches
    with almost no original audio between them would be audible */
const MERGE_GAP_S = 0.25
const CONTEXT_CHARS = 400
/** clean seams sit in silence and can afford a longer, gentler crossfade;
    a seam cut through speech smears less with a short one */
const FADE_SILENCE = 0.02
const FADE_ROUGH = 0.012
/** a bigger correction means the take is materially different, not just quieter */
const GAIN_CLAMP_DB = 6
/** headroom the patch must keep after the correction */
const PEAK_CEILING_DB = -1
/** below this, EBU R128 integrated loudness has not settled — use plain mean */
const LUFS_MIN_S = 3

interface Unit {
  ids: string[]
  cut0: number
  cut1: number
  charFrom: number
  charTo: number
  fade: number
  patchPath: string
  patchDur: number
  gainDb: number
}

function mergeUnits(defects: AudioDefect[]): Unit[] {
  const out: Unit[] = []
  for (const d of [...defects].sort((a, b) => a.phrase.t0 - b.phrase.t0)) {
    const clean = d.phrase.cut[0] === 'silence' && d.phrase.cut[1] === 'silence'
    const last = out[out.length - 1]
    if (last && d.phrase.t0 <= last.cut1 + MERGE_GAP_S) {
      last.cut1 = Math.max(last.cut1, d.phrase.t1)
      last.charFrom = Math.min(last.charFrom, d.phrase.charFrom)
      last.charTo = Math.max(last.charTo, d.phrase.charTo)
      last.fade = Math.min(last.fade, clean ? FADE_SILENCE : FADE_ROUGH)
      last.ids.push(d.id)
      continue
    }
    out.push({
      ids: [d.id], cut0: d.phrase.t0, cut1: d.phrase.t1,
      charFrom: d.phrase.charFrom, charTo: d.phrase.charTo,
      fade: clean ? FADE_SILENCE : FADE_ROUGH,
      patchPath: '', patchDur: 0, gainDb: 0
    })
  }
  return out
}

/**
 * Level of a span, measured the SAME way on both sides of a comparison.
 * Mixing LUFS with dBFS would produce a confident, wrong correction.
 */
async function level(path: string, start: number, duration: number): Promise<number> {
  if (duration >= LUFS_MIN_S) {
    const r = await window.kadr.measureLoudness(path, start, duration)
    return r.i
  }
  const r = await window.kadr.meanVolume(path, start, duration)
  return r.mean
}

export interface RegenOpts {
  /** defects to fix; default = every confirmed one of the target run */
  ids?: string[]
  runId?: string
  assetId?: string
  /** shift everything after the splice (default true — otherwise the picture
      after it goes out of sync with the words) */
  ripple?: boolean
  /** across all unlocked tracks (default) or only the voice-over's own */
  rippleAllTracks?: boolean
  /** run the detector again over the patched file afterwards */
  reverify?: boolean
}

export interface RegenResult {
  units: number
  newAssetId: string
  delta: number
  duration: number
  warnings: string[]
  seams: Array<{ at: number; jumpDb: number }>
}

/** base.fix1.flac, base.fix2.flac… — a take is never overwritten.
 *  Новый файл всегда FLAC, даже если исходник был .wav: сжатие без потерь,
 *  склейка остаётся посемпловой, а версий на диске копится втрое меньше. */
async function freeFixPath(base: string): Promise<string> {
  const stem = base.replace(/\.[a-z0-9]{1,5}$/i, '')
  for (let i = 1; i < 100; i++) {
    const p = `${stem}.fix${i}.flac`
    if ((await window.kadr.statFile(p)) === null) return p
  }
  return `${stem}.fix${Date.now()}.flac`
}

export async function regenerateDefects(opts: RegenOpts = {}): Promise<RegenResult> {
  const st = () => useEditor.getState()
  if (activity.exporting) throw new Error('идёт экспорт — дождитесь его конца')
  if (useVoiceUi.getState().phase !== 'idle') throw new Error('модуль озвучки занят')

  const runs = st().project.voiceRuns ?? []
  const run: VoiceRun | undefined = opts.runId ? runs.find((r) => r.id === opts.runId)
    : opts.assetId ? runs.find((r) => r.assetId === opts.assetId)
    // предпочитаем прогон, где что-то подтверждено; иначе — единственный, чтобы
    // пользователь увидел «нет подтверждённых», а не «озвучка не найдена»
    : runs.find((r) => (st().project.defects ?? []).some(
        (d) => d.runId === r.id && d.state === 'confirmed')) ??
      (runs.length === 1 ? runs[0] : undefined)
  if (!run) throw new Error('не найдена озвучка для перегенерации')

  const all = (st().project.defects ?? []).filter((d) => d.runId === run.id)
  const picked = opts.ids?.length ? all.filter((d) => opts.ids!.includes(d.id))
    : all.filter((d) => d.state === 'confirmed')
  if (!picked.length) throw new Error('нет подтверждённых дефектов: отметьте их ЛКМ по маркеру')

  const lost = picked.find((d) => d.phrase.charFrom < 0 || d.phrase.charTo <= d.phrase.charFrom)
  if (lost) throw new Error('у одного из дефектов потеряны границы фразы — пересчитайте разбор')

  const asset = st().project.assets.find((a) => a.id === run.assetId)
  if (!asset) throw new Error('аудио озвучки пропало из проекта')
  const script = await window.kadr.readTextFile(run.scriptPath)
  if (script === null) throw new Error(`не найден сценарий озвучки: ${run.scriptPath}`)

  // склейка сдвинет все времена правее реза, а обучение сопоставляет вердикт
  // с находкой по времени — выгружаем корпус, пока координаты ещё совпадают
  await flushVerdicts(run.id).catch(() => { /* корпус — не повод срывать починку */ })

  const units = mergeUnits(picked)
  const warnings: string[] = []
  const params = ttsParams()
  useVoiceUi.setState({ phase: 'regen', progress: 0, stage: 'synth', error: '' })
  activity.voiceCheck = true
  const busy: Record<string, number> = {}
  for (const u of units) for (const id of u.ids) busy[id] = 0
  useVoiceUi.setState({ busy: { ...busy } })

  try {
    for (let i = 0; i < units.length; i++) {
      const u = units[i]
      const text = script.slice(u.charFrom, u.charTo).trim()
      if (!text) throw new Error('пустой текст фразы — сценарий не совпадает с разбором')
      useVoiceUi.setState({ progress: i / units.length, stage: 'synth' })

      // сколько тишины было в ИСХОДНИКЕ по обе стороны реза — столько же должно
      // остаться и у заплатки, иначе пауза на стыке изменится
      const [silA, silB] = await Promise.all([
        window.kadr.voiceSilenceAt(asset.path, u.cut0),
        window.kadr.voiceSilenceAt(asset.path, u.cut1)
      ])
      const keepLead = Math.min(0.5, Math.max(0.03, silA.to - u.cut0))
      const keepTail = Math.min(0.5, Math.max(0.03, u.cut1 - silB.from))

      // the run's OWN tempo, never the current setting: a patch at a different
      // speed makes the tempo jump in the middle of a sentence
      const patch = await window.kadr.ttsSpeakPhrase({
        text,
        outPath: `${run.runDir ? run.runDir + '/patch' : asset.path + '.patch'}${i}.flac`,
        keepLead,
        keepTail,
        params,
        tempo: run.tempo || 1,
        previousText: script.slice(Math.max(0, u.charFrom - CONTEXT_CHARS), u.charFrom),
        nextText: script.slice(u.charTo, u.charTo + CONTEXT_CHARS),
        previousRequestIds: run.chunkRequestIds?.filter(Boolean).slice(0, 3),
        seed: Math.floor(Math.random() * 2 ** 31),
        proxy: useTtsSettings.getState().settings.proxy
      })
      warnings.push(...patch.warnings.map((w) => `фраза ${i + 1}: ${w}`))
      u.patchPath = patch.path
      u.patchDur = patch.duration

      const span = u.cut1 - u.cut0
      const before = await level(asset.path, u.cut0, span)
      const after = await level(patch.path, 0, patch.duration)
      let gain = before - after
      if (!Number.isFinite(gain)) gain = 0
      if (Math.abs(gain) > GAIN_CLAMP_DB) {
        warnings.push(`фраза ${i + 1}: уровень отличается на ${gain.toFixed(1)} дБ — ` +
          `поправлено только на ${GAIN_CLAMP_DB}`)
        gain = Math.sign(gain) * GAIN_CLAMP_DB
      }
      // и потолок: подъём уровня не должен загнать заплатку в клиппинг
      const peak = (await window.kadr.meanVolume(patch.path, 0, patch.duration)).max
      if (Number.isFinite(peak) && peak + gain > PEAK_CEILING_DB) {
        gain = PEAK_CEILING_DB - peak
      }
      u.gainDb = gain
      for (const id of u.ids) busy[id] = (i + 1) / units.length
      useVoiceUi.setState({ busy: { ...busy } })
    }

    useVoiceUi.setState({ progress: 0.9, stage: 'splice' })
    const out = await freeFixPath(asset.path)
    const spliced = await window.kadr.voiceSplice({
      src: asset.path, out,
      units: units.map((u) => ({ cut0: u.cut0, cut1: u.cut1, patchPath: u.patchPath,
                                 gainDb: u.gainDb, fade: u.fade }))
    })
    for (const s of spliced.seams) {
      // предупреждаем о РАЗРЫВЕ волны, а не о перепаде уровня: на стыке
      // предложений уровень скачет на 20 дБ и в нетронутой записи
      if (!s.clean) {
        warnings.push(`шов на ${s.at.toFixed(2)} с слышен: разрыв ${s.step} ` +
          `при ${s.stepAround} в секунде вокруг`)
      }
    }

    // Разбор описывает предыдущую версию файла: перенести его на новую нужно
    // ДО того, как пользователь поставит следующую отметку. Иначе фраза для неё
    // считается в старых координатах — подхватывается чужое предложение, и
    // следующая склейка режет не там. Ошибку здесь не глотаем: звук уже
    // записан, отменять его поздно, но молчать нельзя — а сам разбор после
    // этого честно откажется считать фразы (сверка длительности в драйвере).
    if (run.runDir) {
      try {
        await window.kadr.voiceReindex({
          runDir: run.runDir, audio: spliced.path, duration: spliced.duration,
          units: units.map((u) => ({ cut0: u.cut0, cut1: u.cut1, patchDur: u.patchDur }))
        })
      } catch (e) {
        warnings.push('разбор не удалось перенести на новый файл ' +
          `(${String((e as Error)?.message ?? e)}) — перед новыми отметками ` +
          'запустите поиск дефектов заново')
      }
    }

    const probe = await window.kadr.probeMedia(spliced.path)
    const newAsset: MediaAsset = { id: uid(), ...probe.asset }
    // the synthesis took a while — the clip may be gone by now (reverseClip's
    // discipline: do the slow work, re-check, only then touch the project)
    if (!(st().project.voiceRuns ?? []).some((r) => r.id === run.id)) {
      throw new Error('озвучка удалена из проекта, пока шла перегенерация')
    }
    const applied = st().applyVoiceSplice({
      runId: run.id,
      oldAssetId: run.assetId,
      newAsset,
      units: units.map((u) => ({ cut0: u.cut0, cut1: u.cut1, patchDur: u.patchDur, ids: u.ids })),
      newDuration: spliced.duration,
      ripple: opts.ripple ?? true,
      rippleAllTracks: opts.rippleAllTracks ?? true
    })
    if ('error' in applied) throw new Error(applied.error)
    warnings.push(...applied.warnings)

    const result: RegenResult = {
      units: units.length, newAssetId: newAsset.id, delta: applied.delta,
      duration: spliced.duration, warnings, seams: spliced.seams
    }
    // NB не по settings.defectCheck: та галочка про «проверить ПОСЛЕ ОЗВУЧКИ»,
    // а не после каждой починки. Повторный разбор заменяет находки прогона —
    // включая только что закрытую, — и стоит ещё нескольких минут на видеокарте,
    // поэтому он делается только по явной просьбе.
    if (opts.reverify) {
      useVoiceUi.setState({ phase: 'idle' })
      activity.voiceCheck = false
      await checkVoice({ runId: run.id })
    }
    return result
  } finally {
    activity.voiceCheck = false
    useVoiceUi.setState({ phase: 'idle', progress: 0, stage: '', busy: {} })
  }
}

/**
 * The click that says «yes, this is a defect».
 *
 * Lives here rather than in setVerdict so voiceCheck stays free of a dependency
 * on the regenerator (the import would close a cycle). With «перегенерировать
 * сразу» off, verdicts simply pile up until the batch button is pressed — which
 * is also the cheaper way to spend ElevenLabs credits.
 */
export function confirmDefect(id: string): void {
  setVerdict(id, true)
  if (!useTtsSettings.getState().settings.regenerateOnConfirm) return
  regenerateDefects({ ids: [id] }).catch((e) =>
    useVoiceUi.setState({ error: String((e as Error)?.message ?? e) }))
}
