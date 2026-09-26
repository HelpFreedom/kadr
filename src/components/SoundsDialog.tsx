// «Звуки»: the bundled library (resources/, credits in resources/CREDITS.md) —
// 260 sound effects with /brag's per-sound analysis and five music beds. A row
// can be listened to and put on the timeline at the playhead; music can get its
// beat markers straight away.
import { useEffect, useMemo, useRef, useState } from 'react'
import { create } from 'zustand'
import type { SoundLibrary, SfxEntry } from '@shared/types'
import { useSettings } from '@/state/store'
import { loadSoundLibrary, findSfx, addSound, sfxFamilies, SFX_USES } from '@/engine/sounds'
import { useT, type TKey } from '@/i18n'
import { Icon, Spinner } from './icons'
import { Modal } from './Modal'

export const useSoundsUi = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open })
}))

const FAMILY_KEY: Record<string, TKey> = {
  impact: 'famImpact', interface: 'famInterface', ui: 'famUi', casino: 'famCasino', keyboard: 'famKeyboard',
  mine: 'famMine'
}

/** 'simulated user action' → 'useSimulatedUserAction' */
const useKey = (use: string) =>
  ('use' + use.split(/\s+/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('')) as TKey

const fmt = (sec: number) => (sec >= 60
  ? `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`
  : `${sec < 1 ? sec.toFixed(2) : sec.toFixed(1)} с`)

export function SoundsDialog() {
  const t = useT()
  const lang = useSettings((s) => s.lang)
  const open = useSoundsUi((s) => s.open)
  const [lib, setLib] = useState<SoundLibrary | null>(null)
  const [error, setError] = useState('')
  const [tab, setTab] = useState<'sfx' | 'music'>('sfx')
  const [family, setFamily] = useState('')
  const [use, setUse] = useState('')
  const [soft, setSoft] = useState(false)
  const [text, setText] = useState('')
  const [withBeats, setWithBeats] = useState(true)
  const [playing, setPlaying] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [added, setAdded] = useState<string | null>(null)
  const [rescanning, setRescanning] = useState(false)
  const audio = useRef<HTMLAudioElement | null>(null)

  // re-read on every opening: the library is cached in the engine (instant),
  // but sounds added since — a rescan, or ones the embedded Claude placed in the
  // user folder — must show up without restarting the editor
  useEffect(() => {
    if (!open) return
    loadSoundLibrary().then(setLib, (err) => setError(String(err?.message ?? err)))
  }, [open])

  const stop = () => {
    audio.current?.pause()
    audio.current = null
    setPlaying(null)
  }
  // closing the dialog (or unmounting) must never leave a sound playing
  useEffect(() => { if (!open) stop() }, [open])
  useEffect(() => () => stop(), [])

  const list = useMemo(
    () => (lib ? findSfx(lib.sfx, { family: family || undefined, use: use || undefined, soft, text }) : []),
    [lib, family, use, soft, text]
  )
  if (!open) return null

  const rescan = async () => {
    setRescanning(true)
    setError('')
    try {
      setLib(await loadSoundLibrary(true))
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setRescanning(false)
    }
  }
  const famName = (f: string) => (FAMILY_KEY[f] ? t(FAMILY_KEY[f]) : f)

  const play = (id: string, path: string) => {
    if (playing === id) {
      stop()
      return
    }
    stop()
    const el = new Audio()
    el.crossOrigin = 'anonymous' // kadr:// media is cross-origin since Chromium ~136
    el.src = window.kadr.fileUrl(path)
    el.onended = () => { if (audio.current === el) stop() }
    el.onerror = () => { if (audio.current === el) stop() }
    audio.current = el
    setPlaying(id)
    void el.play().catch(() => stop())
  }

  const add = async (id: string) => {
    setBusy(id)
    setError('')
    try {
      await addSound(id, { beats: withBeats })
      setAdded(id)
      setTimeout(() => setAdded((a) => (a === id ? null : a)), 1800)
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(null)
    }
  }

  const brightKey: Record<string, TKey> = { warm: 'soundsWarm', balanced: 'soundsBalanced', bright: 'soundsBright' }
  const riskKey: Record<string, TKey> = { low: 'soundsRiskLow', medium: 'soundsRiskMedium', high: 'soundsRiskHigh' }

  const rowButtons = (id: string, path: string) => (
    <>
      <button className="icon-only" data-act="sound-play" title={playing === id ? t('soundsStop') : t('soundsPlay')}
              aria-label={playing === id ? t('soundsStop') : t('soundsPlay')} aria-pressed={playing === id}
              onClick={() => play(id, path)}>
        <Icon name={playing === id ? 'pause' : 'play'} />
      </button>
      <button className="icon-only" data-act="sound-add" title={t('soundsAdd')} aria-label={t('soundsAdd')}
              disabled={busy !== null} onClick={() => add(id)}>
        {busy === id ? <Spinner /> : <Icon name={added === id ? 'check' : 'plus'} />}
      </button>
    </>
  )

  const sfxRow = (s: SfxEntry) => (
    <div key={s.id} className={s.origin === 'user' ? 'snd-row user' : 'snd-row'} data-sound={s.id}>
      {rowButtons(s.id, s.path)}
      <span className="snd-name" title={s.note ? `${s.id}\n${s.note}` : s.id}>
        {s.id.split('/').pop()!.replace(/\.[a-z0-9]+$/i, '')}
        {s.note && <span className="dim snd-desc">{s.note}</span>}
      </span>
      <span className="snd-dur dim">{fmt(s.duration)}</span>
      <span className="snd-tags">
        {s.hit >= 0.05 && (
          <span className="snd-tag hit" title={t('soundsHitTip').replace('{s}', s.hit.toFixed(2))}>
            {t('soundsHitTag').replace('{s}', s.hit.toFixed(2))}
          </span>
        )}
        {s.brightness && <span className={`snd-tag b-${s.brightness}`}>{t(brightKey[s.brightness])}</span>}
        {s.hfRisk && <span className={`snd-tag r-${s.hfRisk}`}>{t(riskKey[s.hfRisk])}</span>}
        {s.uses.slice(0, 2).map((u) => <span key={u} className="snd-tag">{t(useKey(u))}</span>)}
      </span>
    </div>
  )

  return (
    <Modal
      title={t('soundsTitle')}
      onClose={() => useSoundsUi.getState().setOpen(false)}
      titleIcon={<Icon name="sfx" size={17} />}
      className="sounds-dialog"
      actions={<button onClick={() => useSoundsUi.getState().setOpen(false)}>{t('close')}</button>}
    >
      <div className="side-tabs snd-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'sfx'} className={tab === 'sfx' ? 'active' : ''}
                data-act="sounds-tab-sfx" onClick={() => setTab('sfx')}>
          {t('soundsTabSfx')}
        </button>
        <button role="tab" aria-selected={tab === 'music'} className={tab === 'music' ? 'active' : ''}
                data-act="sounds-tab-music" onClick={() => setTab('music')}>
          {t('soundsTabMusic')}
        </button>
      </div>
      {!lib && !error && <div className="export-progress"><Spinner /></div>}
      {lib && tab === 'sfx' && (
        <>
          <div className="snd-filters">
            <div className="snd-chips" role="group">
              <button className={!family ? 'chip on' : 'chip'} aria-pressed={!family} onClick={() => setFamily('')}>
                {t('soundsAll')}
              </button>
              {sfxFamilies(lib.sfx).map((f) => (
                <button key={f} className={family === f ? 'chip on' : 'chip'} aria-pressed={family === f}
                        data-family={f} onClick={() => setFamily(family === f ? '' : f)}>
                  {famName(f)}
                </button>
              ))}
            </div>
            <div className="snd-filter-row">
              <label>
                <span className="dim">{t('soundsUse')}</span>{' '}
                <select value={use} onChange={(e) => setUse(e.target.value)} data-act="sounds-use">
                  <option value="">{t('soundsAnyUse')}</option>
                  {SFX_USES.map((u) => <option key={u} value={u}>{t(useKey(u))}</option>)}
                </select>
              </label>
              <label title={t('soundsSoftHint')}>
                <input type="checkbox" checked={soft} onChange={(e) => setSoft(e.target.checked)} />{' '}
                {t('soundsSoft')}
              </label>
              <input type="search" placeholder={t('soundsSearch')} value={text} aria-label={t('soundsSearch')}
                     onChange={(e) => setText(e.target.value)} />
              <span className="dim">{t('soundsCount').replace('{n}', String(list.length))}</span>
            </div>
          </div>
          <div className="snd-list" data-sounds-list>
            {list.map(sfxRow)}
          </div>
          <div className="dim">{t('soundsHint')}</div>
          <div className="snd-filter-row">
            <button data-act="sounds-rescan" onClick={rescan} disabled={rescanning}>
              {rescanning ? <Spinner /> : <Icon name="reload" />} {t('soundsRescan')}
            </button>
            <span className="dim snd-credits">{t('soundsUserHint').replace('{dir}', lib.userRoot)}</span>
          </div>
        </>
      )}
      {lib && tab === 'music' && (
        <>
          <div className="snd-list">
            {lib.music.map((m) => (
              <div key={m.id} className="snd-row music" data-sound={m.id}>
                {rowButtons(m.id, m.path)}
                <span className="snd-name">
                  {m.name}
                  <span className="dim snd-desc">{lang === 'ru' ? m.descRu : m.descEn}</span>
                </span>
                <span className="snd-dur dim">{fmt(m.duration)}</span>
                <span className="snd-tags"><span className="snd-tag">{Math.round(m.tempo)} BPM</span></span>
              </div>
            ))}
          </div>
          <label className="snd-filter-row">
            <input type="checkbox" checked={withBeats} onChange={(e) => setWithBeats(e.target.checked)}
                   data-act="sounds-with-beats" />{' '}
            <Icon name="beat" size={14} /> {t('soundsAddBeats')}
          </label>
          <div className="dim">{t('soundsMusicHint')}</div>
        </>
      )}
      <div className="dim snd-credits">{t('soundsCredits')}</div>
      {error && <div className="tr-error"><Icon name="alert" size={15} /><span>{error}</span></div>}
    </Modal>
  )
}
