import { useEffect, useState } from 'react'
import { create } from 'zustand'
import { useEditor } from '@/state/store'
import { checkVoice, cancelCheck, useVoiceUi, selfTestDetector } from '@/engine/voiceCheck'
import { regenerateDefects } from '@/engine/voiceRegen'
import { learnStatus, retrain, flushAllVerdicts } from '@/engine/voiceLearn'
import { scanVoiceVersions, pruneVoiceVersions } from '@/engine/voiceVersions'
import type { VoiceRun, VoiceSelfTest, VoiceLearnResult, VoiceVersionsResult } from '@shared/types'
import { useT, type TKey } from '@/i18n'
import { Icon } from './icons'
import { Modal } from './Modal'

export const useDefectsUi = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

const STAGE: Record<string, TKey> = {
  start: 'dfStageStart', asr: 'dfStageAsr', anchors: 'dfStageAnchors',
  align: 'dfStageAlign', phrases: 'dfStagePhrases', done: 'dfStageDone'
}

/** The voice-over the user means: the selected clip's, else the only one. */
export function targetRun(): VoiceRun | null {
  const s = useEditor.getState()
  const runs = s.project.voiceRuns ?? []
  if (!runs.length) return null
  for (const id of s.selection) {
    for (const tr of s.project.tracks) {
      const c = tr.clips.find((x) => x.id === id)
      const run = c && runs.find((r) => r.assetId === c.assetId)
      if (run) return run
    }
  }
  return runs.length === 1 ? runs[0] : null
}

export function DefectsDialog() {
  const t = useT()
  const open = useDefectsUi((s) => s.open)
  const phase = useVoiceUi((s) => s.phase)
  const progress = useVoiceUi((s) => s.progress)
  const stage = useVoiceUi((s) => s.stage)
  const storeError = useVoiceUi((s) => s.error)
  const defects = useEditor((s) => s.project.defects ?? [])
  const [env, setEnv] = useState<VoiceSelfTest | null>(null)
  const [minConf, setMinConf] = useState(0)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ defects: number; trust: number } | null>(null)
  const [ripple, setRipple] = useState(true)
  const [allTracks, setAllTracks] = useState(true)
  const [reverify, setReverify] = useState(false)
  const [regen, setRegen] = useState<{ units: number; delta: number; warnings: string[] } | null>(null)
  const [corpus, setCorpus] = useState<VoiceLearnResult | null>(null)
  const [training, setTraining] = useState(false)
  const [versions, setVersions] = useState<VoiceVersionsResult | null>(null)
  const [pruning, setPruning] = useState<'idle' | 'ask' | 'busy'>('idle')
  const [freed, setFreed] = useState<{ removed: number; bytes: number } | null>(null)

  useEffect(() => {
    if (!open) return
    setEnv(null)
    selfTestDetector().then(setEnv).catch((e) =>
      setEnv({ ok: false, python: '', problems: [String((e as Error)?.message ?? e)] }))
  }, [open])

  // Сколько накоплено — считается по корпусу, модель при этом не трогается.
  // Зависимость ТОЛЬКО от open: подсчёт поднимает python, а перерисовок при
  // открытом диалоге много. Судить дефекты с открытым окном всё равно нельзя —
  // оно закрывает таймлайн, — так что цифры устареть не успевают.
  useEffect(() => {
    if (!open) return
    setCorpus(null)
    flushAllVerdicts()
      .then(() => learnStatus())
      .then(setCorpus)
      .catch(() => setCorpus(null))
  }, [open])

  // Промежуточные версии на диске: readdir + stat, ни python, ни ffmpeg.
  useEffect(() => {
    if (!open) return
    setPruning('idle')
    setFreed(null)
    setVersions(null)
    scanVoiceVersions().then(setVersions).catch(() => setVersions(null))
  }, [open, phase])

  if (!open) return null
  /** байты → «12.3 МБ»: число тут только для человека, единица — из i18n */
  const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} ${t('vvMb')}`
  const run = targetRun()
  const running = phase === 'check'
  const regenerating = phase === 'regen'
  const mine = run ? defects.filter((d) => d.runId === run.id) : []
  const confirmed = mine.filter((d) => d.state === 'confirmed')
  // Что из этого попадёт в корпус, а что нет — вопрос, на который окно обязано
  // отвечать до нажатия кнопки. Правило то же, что в flushVerdicts: решения по
  // находкам детектора и собственные отметки ДЕФЕКТА учат, «заново» — нет.
  const isRedo = (d: { cls?: string }) => d.cls === 'redo'
  const judged = mine.filter((d) => d.origin === 'detector' &&
    (d.state === 'confirmed' || d.state === 'rejected' || d.state === 'done')).length
  const marksOwn = mine.filter((d) => d.origin === 'user' && !isRedo(d)).length
  const marksRedo = mine.filter(isRedo).length
  const confirmedRedo = confirmed.filter(isRedo).length
  const confirmedDefects = confirmed.length - confirmedRedo

  const close = () => {
    if (running || regenerating) return
    setError('')
    setResult(null)
    useVoiceUi.setState({ error: '' })
    useDefectsUi.getState().setOpen(false)
  }

  async function go() {
    setError('')
    setResult(null)
    useVoiceUi.setState({ error: '' })
    try {
      const r = await checkVoice({ runId: run?.id, minConfidence: minConf })
      setResult({ defects: r.defects, trust: r.trust })
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }

  async function fix() {
    setError('')
    setRegen(null)
    useVoiceUi.setState({ error: '' })
    try {
      const r = await regenerateDefects({
        runId: run?.id, ripple, rippleAllTracks: allTracks, reverify
      })
      setRegen({ units: r.units, delta: r.delta, warnings: r.warnings })
    } catch (e) {
      setError(String((e as Error)?.message ?? e))
    }
  }

  return (
    <Modal
      title={t('dfTitle')}
      onClose={close}
      titleIcon={<Icon name="target" size={17} />}
      wide
      closeDisabled={running || regenerating}
      actions={<button onClick={close} disabled={running || regenerating}>{t('close')}</button>}
    >

      {!run && (
        <div className="tr-error"><Icon name="alert" size={15} /><span>{t('dfNoRun')}</span></div>
      )}
      {run && (
        <div className="insp-field">
          <span>{t('ttsSource')}</span>
          <span className="tr-target">{run.scriptPath.split(/[/\\]/).pop()}</span>
        </div>
      )}

      {/* ---- 1. найти -------------------------------------------------- */}
      <div className="df-step">{t('dfStep1')}</div>
      {env && !env.ok && (
        <div className="tr-error">
          <Icon name="alert" size={15} /><span>{t('dfEnvBad')} {env.problems.join('; ')}</span>
        </div>
      )}
      {env && env.ok && (
        <div className="dim hint-inline">
          <Icon name="check" size={13} /> {t('dfEnvOk')}
          {env.cuda?.available ? ` · CUDA ${env.cuda.name ?? ''} ${env.cuda.freeMb ?? '?'} МБ` : ' · CPU'}
        </div>
      )}
      <label className="insp-field">
        <span>{t('dfMinConf')}</span>
        <input type="range" min={0} max={0.9} step={0.05} value={minConf}
               disabled={running}
               onChange={(e) => setMinConf(parseFloat(e.target.value))} />
        <span className="dim" style={{ width: 92, textAlign: 'right', whiteSpace: 'nowrap' }}>
          {minConf === 0 ? t('dfMinConfAll') : minConf.toFixed(2)}
        </span>
      </label>
      <div className="dim hint-inline">{t('dfMinConfHint')}</div>
      <div className="dim hint-inline">{t('dfLong')}</div>
      <div className="modal-actions df-actions">
        {running
          ? <button onClick={() => cancelCheck()}>{t('dfCancel')}</button>
          : <button className="primary"
                    disabled={regenerating || !run || (env ? !env.ok : false)}
                    onClick={go}><Icon name="target" /> {t('dfRun')}</button>}
      </div>
      {result && (
        <div className="dim hint-inline">
          {t('dfFound')} {result.defects} · {t('dfTrust')} {(result.trust * 100).toFixed(0)}%
          {result.trust < 0.9 && <span className="tr-error"> {t('dfTrustLow')}</span>}
        </div>
      )}
      {!result && mine.length > 0 && (
        <div className="dim hint-inline">{t('dfFound')} {mine.length}</div>
      )}

      {/* ---- 2. разметить ---------------------------------------------- */}
      <div className="df-step">{t('dfStep2')}</div>
      <div className="dim hint-inline">{t('dfLegendMarks')}</div>
      <div className="dim hint-inline">{t('dfLegendKeys')}</div>
      <div className="dim hint-inline">{t('dfUserHint')}</div>
      <div className="dim hint-inline">
        {t('dfJudged')} {judged} · {t('dfMarksOwn')} {marksOwn} · {t('dfMarksRedo')} {marksRedo}
      </div>

      {/* ---- 3. перегенерировать --------------------------------------- */}
      <div className="df-step">{t('dfStep3')}</div>
      <label className="insp-field">
        <span>{t('rgRipple')}</span>
        <input type="checkbox" checked={ripple} disabled={regenerating}
               onChange={(e) => setRipple(e.target.checked)} />
        <span className="dim">{t('rgAllTracks')}</span>
        <input type="checkbox" checked={allTracks} disabled={!ripple || regenerating}
               onChange={(e) => setAllTracks(e.target.checked)} />
      </label>
      <div className="dim hint-inline">{t('rgRippleHint')}</div>
      <label className="insp-field">
        <span>{t('rgReverify')}</span>
        <input type="checkbox" checked={reverify} disabled={regenerating}
               onChange={(e) => setReverify(e.target.checked)} />
      </label>
      <div className="dim hint-inline">{t('rgReverifyHint')}</div>
      <div className="dim hint-inline">
        {t('rgConfirmed')} {confirmed.length}
        {confirmed.length > 0 && (
          <> · {t('rgAsDefects')} {confirmedDefects} · {t('rgAsRedo')} {confirmedRedo}</>
        )}
      </div>
      <div className="dim hint-inline">{t('rgCost')}</div>
      <div className="modal-actions df-actions">
        <button disabled={running || regenerating || !confirmed.length}
                title={confirmed.length ? '' : t('rgNone')}
                onClick={fix}>
          {t('rgButton')} {confirmed.length || ''}
        </button>
      </div>

      {(running || regenerating) && (
        <div className="export-progress">
          <progress value={progress} max={1} />
          <span>
            {regenerating
              ? (stage === 'splice' ? t('rgSplice') : t('rgSynth'))
              : `${t('dfChecking')} ${t(STAGE[stage] ?? 'dfStageStart')}`}
            {' '}{Math.round(progress * 100)}%
          </span>
        </div>
      )}
      {regen && (
        <div className="dim hint-inline">
          {t('rgDone')} {regen.units} · {t('rgDelta')} {regen.delta >= 0 ? '+' : ''}
          {regen.delta.toFixed(2)} с
          {regen.warnings.map((w, i) => (
            <div key={i} className="tr-error"><Icon name="alert" size={15} /><span>{w}</span></div>
          ))}
        </div>
      )}
      {(error || storeError) && (
        <div className="tr-error">
          <Icon name="alert" size={15} /><span>{error || storeError}</span>
        </div>
      )}

      {/* ---- 4. обучение ----------------------------------------------- */}
      <div className="df-step">{t('lnStep')}</div>
      {env?.paths?.SCORER && (
        <div className="dim hint-inline" title={env.paths.SCORER}>
          {t('lnModel')} <span className="tr-target">{env.paths.SCORER}</span>
          {/* время файла — то, по чему переобучение вообще видно: число
              примеров при нём не меняется, корпус ведь тот же */}
          {env.scorerMtime
            ? <> · {t('lnModelAt')} {new Date(env.scorerMtime).toLocaleString()}</>
            : <> · {t('lnModelNone')}</>}
        </div>
      )}
      <div className="dim hint-inline">
        {corpus === null
          ? '…'
          : (<>
              {t('lnStatus')} {corpus.examples} {t('lnExamples')} {t('lnFiles')} {corpus.files}
              {corpus.userMatched + corpus.userUnmatched > 0 && (
                <> · {t('lnUserMatched')} {corpus.userMatched} · {t('lnUserUnmatched')} {corpus.userUnmatched}</>
              )}
              {corpus.crossVal && (
                <> · {t('lnQuality')} {Object.entries(corpus.crossVal)
                  .map(([k, v]) => `${k} ${typeof v === 'number' ? v.toFixed(2) : v}`).join(', ')}</>
              )}
              {corpus.problem && <> · {t('lnNotYet')} {corpus.problem}</>}
            </>)}
      </div>
      {/* Доказательство, а не обещание: время и размер записанного файла.
          Число примеров от переобучения не меняется — по нему пользователь
          и не мог понять, случилось ли что-нибудь. */}
      {corpus?.savedAt && (
        <div className="hint-inline ln-done">
          <Icon name="check" size={14} /> {t('lnDone')} {new Date(corpus.savedAt).toLocaleTimeString()}
          {corpus.savedSize ? ` · ${corpus.savedSize} ${t('lnBytes')}` : ''}
          {corpus.backup && <> · {t('lnPrev')} {corpus.backup.split(/[/\\]/).pop()}</>}
        </div>
      )}
      <div className="dim hint-inline">{t('lnUnchanged')}</div>
      <div className="dim hint-inline">{t('lnHonest')}</div>
      <div className="modal-actions df-actions">
        <button disabled={running || regenerating || training || !(corpus?.ok)}
                title={corpus?.problem ?? t('lnRetrainHint')}
                onClick={async () => {
                  setTraining(true)
                  setError('')
                  try {
                    setCorpus(await retrain())
                    // перечитываем самопроверку: там лежит время файла модели,
                    // и оно обязано стать новым — иначе «переобучил» опять
                    // ничем не подтверждается
                    selfTestDetector().then(setEnv).catch(() => { /* было и есть */ })
                  } catch (e) { setError(String((e as Error)?.message ?? e)) }
                  finally { setTraining(false) }
                }}>
          {training ? t('lnTraining') : t('lnRetrain')}
        </button>
      </div>

      {/* ---- 5. версии на диске ---------------------------------------- */}
      <div className="df-step">{t('vvStep')}</div>
      <div className="dim hint-inline">
        {freed && <>{t('vvFreed')} {freed.removed} · {mb(freed.bytes)} · </>}
        {versions === null
          ? '…'
          : versions.files.length === 0
            ? t('vvNone')
            : `${t('vvFound')} ${versions.files.length} · ${mb(versions.bytes)} ${t('vvKeeps')}`}
      </div>
      {pruning === 'ask' && versions && (
        <div className="dim hint-inline vv-list">
          {versions.files.slice(0, 8).map((f) => (
            <div key={f.path}>{f.name} · {mb(f.size)}</div>
          ))}
          {versions.files.length > 8 && <div>… {t('vvMore')} {versions.files.length - 8}</div>}
          <div className="tr-error"><Icon name="alert" size={15} /><span>{t('vvWarn')}</span></div>
        </div>
      )}
      <div className="modal-actions df-actions">
        {pruning === 'ask'
          ? (<>
              <button onClick={() => setPruning('idle')}>{t('cancel')}</button>
              <button className="danger" disabled={regenerating || running}
                      onClick={async () => {
                        setPruning('busy')
                        setError('')
                        try {
                          const done = await pruneVoiceVersions()
                          setFreed({ removed: done.removed ?? 0, bytes: done.bytes })
                          // пересчитываем заново, а не показываем удалённое:
                          // строка «версий: 8» после удаления восьми — враньё
                          setVersions(await scanVoiceVersions())
                        } catch (e) { setError(String((e as Error)?.message ?? e)) }
                        finally { setPruning('idle') }
                      }}>
                {t('vvDelete')}
              </button>
            </>)
          : (<button disabled={running || regenerating || pruning === 'busy' ||
                               !versions || versions.files.length === 0}
                     title={t('vvHint')}
                     onClick={() => setPruning('ask')}>
              {t('vvButton')}
            </button>)}
      </div>
    </Modal>
  )
}
