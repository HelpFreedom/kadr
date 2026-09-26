// «Биты»: listen to a piece of the timeline, find the beats (librosa's
// beat_track, ported — shared/audioAnalysis.ts) and lay them down as pink beat
// markers that clips, the range and markers snap to.
import { useMemo, useState } from 'react'
import { useEditor, findClip, withLinked, projectDuration } from '@/state/store'
import { detectBeats, clearBeats, beatTarget, useBeatsUi, type BeatGrid } from '@/engine/beats'
import { audibleTracksInRange, collectRangeAudio } from '@/engine/subtitles'
import { useT } from '@/i18n'
import { Icon, Spinner } from './icons'
import { Modal } from './Modal'

type Source = 'sel' | 'range' | 'all' | `track:${string}`

const GRIDS: { id: BeatGrid; key: 'beatsAll' | 'beatsHalf' | 'beatsBar' | 'beatsStrong' }[] = [
  { id: 'all', key: 'beatsAll' },
  { id: 'half', key: 'beatsHalf' },
  { id: 'bar', key: 'beatsBar' },
  { id: 'strong', key: 'beatsStrong' }
]

export function BeatsDialog() {
  const t = useT()
  const open = useBeatsUi((s) => s.open)
  const busy = useBeatsUi((s) => s.busy)
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const range = useEditor((s) => s.range)
  const [pick, setPick] = useState<Source | null>(null)
  const [grid, setGrid] = useState<BeatGrid>('all')
  const [result, setResult] = useState('')
  const [error, setError] = useState('')

  // selected clips that actually carry sound (a linked video half brings its twin)
  const selAudible = useMemo(() => {
    if (!selection.length) return false
    const ids = withLinked(project, selection)
    const any = ids.some((id) => findClip(project, id))
    if (!any) return false
    return collectRangeAudio(project, 0, Math.max(0.01, projectDuration(project)), { clipIds: ids }).length > 0
  }, [project, selection])
  const span = range ?? { start: 0, end: projectDuration(project) }
  const tracks = useMemo(() => audibleTracksInRange(project, span.start, span.end), [project, span.start, span.end])
  if (!open) return null

  const fallback: Source = selAudible ? 'sel' : range ? 'range' : 'all'
  let source: Source = pick ?? fallback
  if (source === 'sel' && !selAudible) source = fallback
  if (source === 'range' && !range) source = fallback
  if (source.startsWith('track:') && !tracks.some((tr) => `track:${tr.id}` === source)) source = fallback

  const opts = () => {
    if (source === 'sel') return { clipIds: selection }
    if (source === 'range') return { range: range! }
    if (source === 'all') return { range: { start: 0, end: projectDuration(project) } }
    return { trackId: source.slice(6), range: range ?? undefined }
  }

  const close = () => {
    if (busy) return
    setResult('')
    setError('')
    useBeatsUi.getState().setOpen(false)
  }

  async function run() {
    setError('')
    setResult('')
    try {
      const r = await detectBeats({ ...opts(), grid })
      setResult(r.placed
        ? t('beatsDone').replace('{bpm}', r.tempo.toFixed(1)).replace('{n}', String(r.placed)) +
          (r.attackShiftMs !== undefined ? ' · ' + t('beatsAligned').replace('{ms}', String(Math.round(Math.abs(r.attackShiftMs)))) : '')
        : t('beatsNone'))
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    }
  }

  function clear() {
    const { range: r } = beatTarget(useEditor.getState().project, opts(), useEditor.getState().range)
    const n = source === 'all' ? clearBeats() : clearBeats(r)
    setResult(`${t('beatsClear')}: ${n}`)
  }

  const radio = (value: Source, label: string) => (
    <label key={value}>
      <input type="radio" name="beats-source" checked={source === value} disabled={busy}
             onChange={() => setPick(value)} />{' '}{label}
    </label>
  )

  return (
    <Modal
      title={t('beatsTitle')}
      onClose={close}
      titleIcon={<Icon name="beat" size={17} />}
      closeDisabled={busy}
      actions={
        <>
          <button onClick={clear} disabled={busy} data-act="beats-clear">{t('beatsClear')}</button>
          <button onClick={close} disabled={busy}>{t('close')}</button>
          <button className="primary" onClick={run} disabled={busy} data-act="beats-run">{t('beatsRun')}</button>
        </>
      }
    >
      <div className="insp-field tall">
        <span>{t('beatsListen')}</span>
        <div className="nw-sources">
          {selAudible && radio('sel', t('beatsSelClips'))}
          {range && radio('range', `${t('beatsRangeMix')} · ${range.start.toFixed(1)}–${range.end.toFixed(1)} c`)}
          {radio('all', t('beatsWholeMix'))}
          {tracks.map((tr) => radio(`track:${tr.id}`, `${t('beatsTrack')} · ${tr.name}`))}
        </div>
      </div>
      <div className="insp-field tall">
        <span>{t('beatsGrid')}</span>
        <div className="nw-sources">
          {GRIDS.map((g) => (
            <label key={g.id}>
              <input type="radio" name="beats-grid" checked={grid === g.id} disabled={busy}
                     onChange={() => setGrid(g.id)} />{' '}{t(g.key)}
            </label>
          ))}
        </div>
      </div>
      <div className="dim">{t('beatsGridHint')}</div>
      <div className="dim">{t('beatsHint')}</div>
      {busy && (
        <div className="export-progress">
          <Spinner /> <span className="dim tr-live">{t('beatsWorking')}</span>
        </div>
      )}
      {result && !busy && <div className="tr-live" data-beats-result>{result}</div>}
      {error && (
        <div className="tr-error"><Icon name="alert" size={15} /><span>{error}</span></div>
      )}
    </Modal>
  )
}
