// «Неоновая волна»: an audio-reactive glowing sine line generated from the
// selected timeline range (the user's Blender preset, rebuilt as a Remotion
// fragment). Sound source = the range's mix, or the mix of one audio track.
import { useMemo, useState } from 'react'
import { create } from 'zustand'
import { useEditor } from '@/state/store'
import { neonWave, NEON_WAVE_DEFAULTS, type NeonWaveStyle } from '@/engine/neonWave'
import { audibleTracksInRange } from '@/engine/subtitles'
import { useT } from '@/i18n'

export const useNeonWaveUi = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

export function NeonWaveDialog() {
  const t = useT()
  const open = useNeonWaveUi((s) => s.open)
  const range = useEditor((s) => s.range)
  const project = useEditor((s) => s.project)
  const [source, setSource] = useState<string>('mix') // 'mix' | trackId
  const [amp, setAmp] = useState(1)
  const [glow, setGlow] = useState(1)
  const [speed, setSpeed] = useState(1)
  const [running, setRunning] = useState(false)
  const [error, setError] = useState('')

  const tracks = useMemo(
    () => (range ? audibleTracksInRange(project, range.start, range.end) : []),
    [project, range]
  )
  if (!open) return null
  const trackSource = source !== 'mix' && tracks.some((tr) => tr.id === source) ? source : 'mix'

  const close = () => {
    if (running) return
    setError('')
    useNeonWaveUi.getState().setOpen(false)
  }

  async function run() {
    if (!range) return
    setRunning(true)
    setError('')
    try {
      const d = NEON_WAVE_DEFAULTS
      const style: Partial<NeonWaveStyle> = {
        amp: d.amp * amp,
        phase: d.phase * speed,
        streak: { ...d.streak, strength: d.streak.strength * glow },
        halo: d.halo.map(([b, a, w]) => [b, a * glow, w] as [number, number, number])
      }
      await neonWave({
        range,
        source: trackSource === 'mix' ? 'mix' : { trackId: trackSource },
        style
      })
      setRunning(false)
      useNeonWaveUi.getState().setOpen(false)
    } catch (err) {
      setRunning(false)
      setError(String((err as Error)?.message ?? err))
    }
  }

  return (
    <div className="modal-back" onClick={close}>
      <div className="modal captions-modal" onClick={(e) => e.stopPropagation()}>
        <h2>{t('nwTitle')}</h2>
        {!range ? (
          <div className="tr-error">{t('nwNeedRange')}</div>
        ) : (
          <>
            <div className="insp-field">
              <span>{t('capTarget')}</span>
              <span>
                {t('trSourceRange')}: {range.start.toFixed(1)}–{range.end.toFixed(1)} c
              </span>
            </div>
            <div className="insp-field">
              <span>{t('nwSource')}</span>
              <div className="nw-sources">
                <label>
                  <input
                    type="radio"
                    name="nw-source"
                    checked={trackSource === 'mix'}
                    disabled={running}
                    onChange={() => setSource('mix')}
                  />{' '}
                  {t('nwMix')}
                </label>
                {tracks.map((tr) => (
                  <label key={tr.id}>
                    <input
                      type="radio"
                      name="nw-source"
                      checked={trackSource === tr.id}
                      disabled={running}
                      onChange={() => setSource(tr.id)}
                    />{' '}
                    {t('nwTrack')} · {tr.name}
                  </label>
                ))}
                {!tracks.length && <div className="dim">{t('nwNoAudio')}</div>}
              </div>
            </div>
            <label className="insp-field">
              <span>{t('nwAmp')}</span>
              <input type="range" min={0.25} max={3} step={0.05} value={amp} disabled={running}
                onChange={(e) => setAmp(Number(e.target.value))} />
              <span className="fx-val">{amp.toFixed(2)}×</span>
            </label>
            <label className="insp-field">
              <span>{t('nwGlow')}</span>
              <input type="range" min={0} max={2} step={0.05} value={glow} disabled={running}
                onChange={(e) => setGlow(Number(e.target.value))} />
              <span className="fx-val">{glow.toFixed(2)}×</span>
            </label>
            <label className="insp-field">
              <span>{t('nwSpeed')}</span>
              <input type="range" min={0.1} max={3} step={0.05} value={speed} disabled={running}
                onChange={(e) => setSpeed(Number(e.target.value))} />
              <span className="fx-val">{speed.toFixed(2)}×</span>
            </label>
            <div className="dim">{t('nwHint')}</div>
          </>
        )}
        {running && (
          <div className="export-progress">
            <progress />
            <div className="dim tr-live">{t('nwWorking')}</div>
          </div>
        )}
        {error && <div className="tr-error">{error}</div>}
        <div className="modal-actions">
          <button onClick={close} disabled={running}>{t('cancel')}</button>
          {range && (
            <button className="primary" onClick={run} disabled={running}>{t('nwRun')}</button>
          )}
        </div>
      </div>
    </div>
  )
}
