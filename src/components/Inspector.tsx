import { useEffect, useMemo, useState } from 'react'
import type { Anim, Clip, Effect, FragmentInspect, FragmentParamDecl, FxPreset, TextStyle } from '@shared/types'
import { useEditor, useFxPresets, useSettings, findClip, uid } from '@/state/store'
import { useEffects, defaultParams, labelText, paramAnim, type EffectDef } from '@/gl/effects'
import { evalAnim } from '@/engine/anim'
import { applyValue, upsertKf, KF_EPS } from './animUtils'
import { useT, type TKey } from '@/i18n'
import { bakeAudio, bakeState, bakePlan } from '@/engine/audioReact'
import { audibleTracksInRange } from '@/engine/subtitles'
import { useFragmentParams, paramValues, setParam, resetParams, rememberParamValues } from '@/engine/fragmentParams'
import { CtxMenu } from './CtxMenu'
import { Icon, Spinner } from './icons'

function Num({
  label, value, step = 1, min, max, onChange
}: {
  label: string
  value: number
  step?: number
  min?: number
  max?: number
  onChange: (v: number) => void
}) {
  return (
    <label className="insp-field">
      <span>{label}</span>
      <input
        type="number"
        value={Number(value.toFixed(3))}
        step={step}
        min={min}
        max={max}
        onFocus={() => useEditor.getState().pushHistory('hEdit')}
        onChange={(e) => {
          const v = Number(e.target.value)
          if (!Number.isNaN(v)) onChange(v)
        }}
      />
    </label>
  )
}

export function Inspector() {
  const t = useT()
  const clipId = useEditor((s) => s.selection[0])
  const found = useEditor((s) => (clipId ? findClip(s.project, clipId) : null))

  return (
    <div className="inspector">
      <div className="panel-head">
        <span>{t('inspector')}</span>
      </div>
      <div className="insp-body">
        {found ? <ClipProps clip={found.clip} /> : <ProjectProps />}
      </div>
    </div>
  )
}

function ProjectProps() {
  const t = useT()
  const project = useEditor((s) => s.project)
  const patch = (p: Partial<typeof project>) =>
    useEditor.setState((s) => ({ project: { ...s.project, ...p } }))

  return (
    <>
      <div className="insp-section">{t('projectSettings')}</div>
      <label className="insp-field">
        <span>{t('label')}</span>
        <input value={project.name} onChange={(e) => patch({ name: e.target.value })} />
      </label>
      <Num label={`${t('resolution')} W`} value={project.width} step={2} min={16}
        onChange={(v) => patch({ width: Math.round(v / 2) * 2 })} />
      <Num label={`${t('resolution')} H`} value={project.height} step={2} min={16}
        onChange={(v) => patch({ height: Math.round(v / 2) * 2 })} />
      <Num label={t('framerate')} value={project.fps} step={1} min={1} max={120}
        onChange={(v) => patch({ fps: v })} />
    </>
  )
}

function ClipProps({ clip }: { clip: Clip }) {
  const t = useT()
  const update = (patch: Partial<Clip>) => useEditor.getState().updateClip(clip.id, patch)
  const setAnim = (key: keyof Clip['transform'], v: number) =>
    update({ transform: { ...clip.transform, [key]: { ...clip.transform[key], value: v } } })
  const setGain = (v: number) => update({ gain: { ...clip.gain, value: v } as Anim })
  const setStyle = (patch: Partial<TextStyle>) =>
    update({ textStyle: { ...clip.textStyle!, ...patch } })

  return (
    <>
      <div className="insp-section">{clip.label ?? t('clipName')}</div>
      {clip.kind === 'text' && clip.textStyle && (
        <>
          <label className="insp-field tall">
            <span>{t('text')}</span>
            <textarea
              rows={3}
              value={clip.text ?? ''}
              onFocus={() => useEditor.getState().pushHistory('hEdit')}
              onChange={(e) => update({ text: e.target.value })}
            />
          </label>
          <Num label={t('fontSize')} value={clip.textStyle.fontSize} min={8} max={500}
            onChange={(v) => setStyle({ fontSize: v })} />
          <label className="insp-field">
            <span>{t('color')}</span>
            <input type="color" value={clip.textStyle.color}
              onChange={(e) => setStyle({ color: e.target.value })} />
          </label>
          <label className="insp-field">
            <span>{t('outline')}</span>
            <input type="color" value={clip.textStyle.outlineColor}
              onChange={(e) => setStyle({ outlineColor: e.target.value })} />
          </label>
          <Num label={`${t('outline')} px`} value={clip.textStyle.outlineWidth} min={0} max={40}
            onChange={(v) => setStyle({ outlineWidth: v })} />
          <label className="insp-field">
            <span>{t('bold')}</span>
            <input type="checkbox" checked={clip.textStyle.bold}
              onChange={(e) => setStyle({ bold: e.target.checked })} />
          </label>
        </>
      )}
      <div className="insp-section">{t('position')}</div>
      <Num label="X" value={clip.transform.x.value} onChange={(v) => setAnim('x', v)} />
      <Num label="Y" value={clip.transform.y.value} onChange={(v) => setAnim('y', v)} />
      <Num label={t('scale')} value={clip.transform.scale.value} step={0.05} min={0.01} max={20}
        onChange={(v) => setAnim('scale', v)} />
      <Num label={t('rotation')} value={clip.transform.rotation.value} step={1}
        onChange={(v) => setAnim('rotation', v)} />
      <Num label={t('opacity')} value={clip.transform.opacity.value} step={0.05} min={0} max={1}
        onChange={(v) => setAnim('opacity', v)} />
      <div className="insp-section">{t('volume')}</div>
      <Num label={t('volume')} value={clip.gain.value} step={0.05} min={0} max={2} onChange={setGain} />
      <label className="insp-field">
        <span>{t('muted')}</span>
        <input type="checkbox" checked={clip.muted}
          onChange={(e) => update({ muted: e.target.checked })} />
      </label>
      {clip.kind === 'remotion' && <FragmentParamsSection clip={clip} />}
      {clip.kind === 'remotion' && <AudioReactSection clip={clip} />}
      <EffectsSection clip={clip} />
    </>
  )
}

/**
 * «Реакция на звук»: bake the sound under a fragment into its folder
 * (audio.json + audio.ts, see src/engine/audioReact.ts) so the composition can
 * move with the music. Shows whether the bake still matches what is under the
 * clip — a moved clip or an edited track makes it stale.
 */
function AudioReactSection({ clip }: { clip: Clip }) {
  const t = useT()
  const project = useEditor((s) => s.project)
  const [source, setSource] = useState(clip.audioBake?.source ?? 'mix')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  useEffect(() => {
    setSource(clip.audioBake?.source ?? 'mix')
    setNote('')
    setError('')
  }, [clip.id])
  const plan = useMemo(() => bakePlan(project, clip, 'mix'), [project, clip])
  const tracks = useMemo(
    // the tracks heard under the composition itself, not in the analysis context around it
    () => (plan ? audibleTracksInRange(project, Math.max(0, plan.t0), plan.t0 + plan.frames * plan.step) : []),
    [project, plan]
  )
  const state = bakeState(project, clip)
  const src = source === 'mix' || tracks.some((tr) => tr.id === source) ? source : 'mix'

  const bake = async () => {
    setBusy(true)
    setError('')
    setNote('')
    try {
      const r = await bakeAudio(clip.id, { source: src })
      setNote(r.audible
        ? t('arDone').replace('{bpm}', r.bpm.toFixed(1)).replace('{n}', String(r.beats))
        : t('arSilent'))
    } catch (err) {
      setError(String((err as Error)?.message ?? err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="insp-section"><Icon name="reactive" size={13} /> {t('arTitle')}</div>
      <div className={`ar-state ${state}`} data-ar-state={state}>
        {state === 'none' ? t('arNone') : state === 'fresh' ? t('arFresh') : t('arStale')}
      </div>
      <label className="insp-field">
        <span>{t('arSource')}</span>
        <select value={src} disabled={busy} onChange={(e) => setSource(e.target.value)} data-act="ar-source">
          <option value="mix">{t('arMix')}</option>
          {tracks.map((tr) => <option key={tr.id} value={tr.id}>{tr.name}</option>)}
        </select>
      </label>
      <button data-act="ar-bake" disabled={busy} onClick={bake}>
        {busy ? <Spinner /> : <Icon name="reactive" />}{' '}
        {busy ? t('arWorking') : state === 'none' ? t('arBake') : t('arRebake')}
      </button>
      {note && <div className="dim">{note}</div>}
      {error && <div className="tr-error"><Icon name="alert" size={15} /><span>{error}</span></div>}
      <div className="dim ar-hint">{t('arHint')}</div>
    </>
  )
}

/**
 * The fragment's own parameters (defineParams in @kadr/runtime): sliders that
 * move the preview live and are saved into the fragment's params.json.
 */
function FragmentParamsSection({ clip }: { clip: Clip }) {
  const t = useT()
  const fid = clip.fragmentId!
  const [ins, setIns] = useState<FragmentInspect | null>(null)
  const [loading, setLoading] = useState(false)
  const [gen, setGen] = useState(0)
  useFragmentParams((s) => s.live[fid]) // re-render while a value is dragged
  useEffect(() => {
    let alive = true
    setLoading(true)
    window.kadr.fragmentInspect(fid)
      .then((r) => {
        if (!alive) return
        if (r.ok) rememberParamValues(fid, r.paramValues)
        setIns(r)
      })
      .catch((e) => { if (alive) setIns({ ok: false, error: String((e as Error)?.message ?? e) }) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [fid, gen])
  const decl: Record<string, FragmentParamDecl> = ins?.ok ? ins.params ?? {} : {}
  const names = Object.keys(decl)
  const values = paramValues(fid, decl, ins?.ok ? ins.paramValues : undefined)
  const set = (k: string, v: number | boolean | string) => setParam(fid, k, v)
  return (
    <>
      <div className="insp-section">
        <Icon name="sliders" size={13} /> {t('fpTitle')}
        <button className="fx-del fp-reload" data-act="fp-reload" aria-label={t('fpReload')} title={t('fpReload')}
          disabled={loading} onClick={() => setGen((g) => g + 1)}>
          {loading ? <Spinner /> : <Icon name="reload" size={13} />}
        </button>
      </div>
      {ins && !ins.ok && <div className="tr-error"><Icon name="alert" size={15} /><span>{ins.error.split('\n')[0]}</span></div>}
      {ins?.ok && !names.length && <div className="dim ar-hint">{t('fpNone')}</div>}
      {names.map((k) => {
        const d = decl[k]
        const v = values[k]
        const label = d.label || k
        if (typeof d.value === 'boolean') {
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <input type="checkbox" checked={v === true} onChange={(e) => set(k, e.target.checked)} />
            </label>
          )
        }
        if (typeof d.value === 'string') {
          const color = /^#[0-9a-f]{6}$/i.test(String(d.value))
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <input type={color ? 'color' : 'text'} value={String(v)} onChange={(e) => set(k, e.target.value)} />
            </label>
          )
        }
        const n = Number(v)
        const step = d.step ?? (d.min != null && d.max != null ? (d.max - d.min) / 200 : 0.01)
        const ranged = d.min != null && d.max != null && d.max > d.min
        const digits = Math.max(0, Math.min(4, Math.ceil(-Math.log10(step) - 1e-9)))
        return (
          <label key={k} className="insp-field fx-slider fp-num" data-param={k}>
            <span>{label}</span>
            {ranged && (
              <input type="range" value={n} min={d.min} max={d.max} step={step}
                onChange={(e) => set(k, Number(e.target.value))} />
            )}
            <input type="number" value={Number(n.toFixed(digits))} step={step} min={d.min} max={d.max}
              onChange={(e) => { const x = Number(e.target.value); if (e.target.value !== '' && Number.isFinite(x)) set(k, x) }} />
          </label>
        )
      })}
      {names.length > 0 && (
        <button data-act="fp-reset" onClick={() => void resetParams(fid)}>{t('fpReset')}</button>
      )}
    </>
  )
}

function Slider({
  label, value, min, max, step, onChange, after
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
  /** a control after the value (an effect param's keyframe button) */
  after?: React.ReactNode
}) {
  return (
    <label className="insp-field fx-slider">
      <span>{label}</span>
      <input
        type="range"
        value={value}
        min={min}
        max={max}
        step={step}
        onPointerDown={() => useEditor.getState().pushHistory('hEffect')}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      <span className="fx-val">{Number(value.toFixed(2))}</span>
      {after}
    </label>
  )
}

const FX_GROUPS: { id: EffectDef['group']; label: TKey }[] = [
  { id: 'color', label: 'fxGroupColor' },
  { id: 'key', label: 'fxGroupKey' },
  { id: 'stylize', label: 'fxGroupStylize' },
  { id: 'light', label: 'fxGroupLight' },
  { id: 'blur', label: 'fxGroupBlur' }
]

function EffectsSection({ clip }: { clip: Clip }) {
  const t = useT()
  const lang = useSettings((s) => s.lang)
  const defs = useEffects((s) => s.defs)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null)
  const [name, setName] = useState('')
  const fxPresets = useFxPresets((s) => s.presets)
  const update = (effects: Effect[]) => useEditor.getState().updateClip(clip.id, { effects })
  const effects = clip.effects ?? []
  const add = (def: EffectDef) => {
    useEditor.getState().pushHistory('hEffect')
    update([...effects, { id: uid(), type: def.id, enabled: true, params: defaultParams(def) }])
    setAddMenu(null)
  }
  useEffect(() => {
    if (!menu && !addMenu) return
    const close = () => { setMenu(null); setAddMenu(null) }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu, addMenu])
  // selection moved to another clip — an open menu refers to stale effects
  useEffect(() => { setMenu(null); setAddMenu(null) }, [clip.id])
  const saveFx = () => {
    const nm = name.trim()
    if (!nm || !effects.length) return
    // a preset is a look, not a timing: animated params keep their value at
    // the playhead (keyframe times would not fit another clip anyway)
    const rel = Math.max(0, Math.min(clip.duration, useEditor.getState().playhead - clip.start))
    useFxPresets.getState().savePreset({
      name: nm,
      effects: effects.map((e) => ({
        ...e,
        params: Object.fromEntries(Object.entries(e.params).map(([k, v]) =>
          [k, typeof v === 'object' ? evalAnim(v, rel) : v]))
      }))
    })
    setName('')
  }
  const applyFx = (p: FxPreset) => {
    useEditor.getState().pushHistory('hPreset')
    update(p.effects.map((e) => ({ ...e, id: uid(), params: { ...e.params } })))
    setMenu(null)
  }
  const byName = (a: EffectDef, b: EffectDef) => labelText(a.name, lang).localeCompare(labelText(b.name, lang))
  return (
    <>
      <div className="insp-section fx-section-head">
        <span>{t('effects')}</span>
        <button
          className={`fx-preset-btn${menu ? ' active' : ''}`}
          data-act="fx-presets"
          title={t('fxPresetsHint')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setAddMenu(null)
            setMenu(menu ? null : { x: r.left, y: r.bottom + 4 })
          }}
        >
          <Icon name="star" size={12} /> {t('presets')}
        </button>
      </div>
      {effects.map((fx, i) => (
        <FxBlock key={fx.id} clip={clip} fx={fx} index={i} count={effects.length} />
      ))}
      <button
        className={`fx-add${addMenu ? ' active' : ''}`}
        data-act="fx-add"
        aria-haspopup="menu"
        aria-expanded={!!addMenu}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect()
          setMenu(null)
          setAddMenu(addMenu ? null : { x: r.left, y: r.bottom + 4 })
        }}
      >
        <Icon name="plus" size={13} /> {t('fxAdd')}
      </button>
      {addMenu && (
        <CtxMenu x={addMenu.x} y={addMenu.y} className="fx-add-menu">
          <div role="menu" aria-label={t('fxAdd')} onPointerDown={(e) => e.stopPropagation()}>
            {FX_GROUPS.map((g) => {
              const list = Object.values(defs).filter((d) => d.group === g.id).sort(byName)
              if (!list.length) return null
              return (
                <div key={g.id} role="group" aria-label={t(g.label)}>
                  <div className="ctx-title dim">{t(g.label)}</div>
                  {list.map((d) => (
                    <button key={d.id} role="menuitem" data-act={`add-${d.id}`} onClick={() => add(d)}>
                      {labelText(d.name, lang)}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        </CtxMenu>
      )}
      {menu && (
        <CtxMenu x={menu.x} y={menu.y} className="preset-menu fx-preset-menu">
          <div className="ctx-title dim">{t('presets')} — {t('effects')}</div>
          {fxPresets.length === 0 && <div className="ctx-empty dim">{t('noPresets')}</div>}
          {fxPresets.map((p) => (
            <div className="preset-item" key={p.id}>
              <button onClick={() => applyFx(p)}>{p.name}</button>
              <button
                className="preset-del"
                title={t('deletePreset')}
                aria-label={t('deletePreset')}
                onClick={() => useFxPresets.getState().deletePreset(p.id)}
              >
                <Icon name="close" size={13} />
              </button>
            </div>
          ))}
          <div className="preset-save-row">
            <input
              value={name}
              placeholder={t('presetName')}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveFx()
              }}
            />
            <button disabled={!name.trim() || !effects.length} onClick={saveFx}>
              {t('presetSave')}
            </button>
          </div>
        </CtxMenu>
      )}
    </>
  )
}

/**
 * One effect of the clip: its header (on/off, order, remove) and controls
 * generated from the effect's declared params — no per-effect UI code.
 */
function FxBlock({ clip, fx, index, count }: { clip: Clip; fx: Effect; index: number; count: number }) {
  const t = useT()
  const lang = useSettings((s) => s.lang)
  const def = useEffects((s) => s.defs[fx.type])
  const error = useEffects((s) => s.errors[fx.type])
  const playhead = useEditor((s) => s.playhead)
  const rel = Math.max(0, Math.min(clip.duration, playhead - clip.start))
  const inside = playhead >= clip.start - 1e-6 && playhead <= clip.start + clip.duration + 1e-6
  const st = () => useEditor.getState()
  const list = () => st().project.tracks.flatMap((tr) => tr.clips).find((c) => c.id === clip.id)?.effects ?? []
  const patchFx = (patch: Partial<Effect>) =>
    st().updateClip(clip.id, { effects: list().map((e) => (e.id === fx.id ? { ...e, ...patch } : e)) })
  const setP = (key: string, v: Effect['params'][string]) => patchFx({ params: { ...fx.params, [key]: v } })
  const move = (to: number) => {
    const arr = [...list()]
    const [it] = arr.splice(index, 1)
    arr.splice(to, 0, it)
    st().pushHistory('hEffect')
    st().updateClip(clip.id, { effects: arr })
  }
  const name = def ? labelText(def.name, lang) : fx.type
  return (
    <div className="fx-block" data-fx={fx.type}>
      <div className="fx-head">
        <label>
          <input
            type="checkbox"
            checked={fx.enabled}
            onChange={(e) => {
              st().pushHistory('hEffect')
              patchFx({ enabled: e.target.checked })
            }}
          />
          <span>{name}</span>
        </label>
        <span className="fx-tools">
          <button className="fx-tool" data-act="fx-up" disabled={index === 0}
            title={t('fxMoveUp')} aria-label={`${t('fxMoveUp')}: ${name}`} onClick={() => move(index - 1)}>
            <Icon name="chevronUp" size={14} />
          </button>
          <button className="fx-tool" data-act="fx-down" disabled={index === count - 1}
            title={t('fxMoveDown')} aria-label={`${t('fxMoveDown')}: ${name}`} onClick={() => move(index + 1)}>
            <Icon name="chevronDown" size={14} />
          </button>
          <button
            className="fx-del"
            data-act="fx-del"
            title={t('fxDelete')}
            aria-label={`${t('fxDelete')}: ${name}`}
            onClick={() => {
              st().pushHistory('hEffect')
              st().updateClip(clip.id, { effects: list().filter((e) => e.id !== fx.id) })
            }}
          ><Icon name="trash" size={14} /></button>
        </span>
      </div>
      {!def && <div className="dim ar-hint">{t('fxUnknown')}</div>}
      {error && <div className="tr-error"><Icon name="alert" size={15} /><span>{error.split('\n')[0]}</span></div>}
      {def && Object.entries(def.params).map(([k, d]) => {
        const label = labelText(d.name, lang)
        const raw = fx.params[k]
        if (d.kind === 'color') {
          const v = typeof raw === 'string' && /^#[0-9a-f]{6}$/i.test(raw) ? raw : String(d.default)
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <input type="color" value={v} onFocus={() => st().pushHistory('hEffect')}
                onChange={(e) => setP(k, e.target.value)} />
            </label>
          )
        }
        const anim = paramAnim(d, raw)
        const n = evalAnim(anim, rel)
        if (d.kind === 'toggle') {
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <input type="checkbox" checked={n !== 0} onChange={(e) => {
                st().pushHistory('hEffect')
                setP(k, e.target.checked ? 1 : 0)
              }} />
            </label>
          )
        }
        if (d.kind === 'select') {
          return (
            <label key={k} className="insp-field" data-param={k}>
              <span>{label}</span>
              <select value={n} onChange={(e) => {
                st().pushHistory('hEffect')
                setP(k, Number(e.target.value))
              }}>
                {(d.options ?? []).map((o) => <option key={o.value} value={o.value}>{labelText(o.name, lang)}</option>)}
              </select>
            </label>
          )
        }
        // numbers animate like the transform: once a param has keyframes, an
        // edit sets the key at the playhead instead of wiping them
        const keys = anim.keyframes ?? []
        const here = keys.find((kf) => Math.abs(kf.time - rel) < KF_EPS)
        const toggleKey = () => {
          st().pushHistory('hKeyframe')
          if (!here) return setP(k, upsertKf(anim, rel, n))
          const left = keys.filter((kf) => kf !== here)
          setP(k, left.length ? { ...anim, keyframes: left } : { value: n })
        }
        return (
          <Slider key={k} label={label} value={n} min={d.min ?? 0} max={d.max ?? 1}
            step={d.step ?? ((d.max ?? 1) - (d.min ?? 0)) / 100}
            onChange={(v) => setP(k, applyValue(anim, rel, v, false))}
            after={
              <button
                className={`fx-kf${here ? ' on' : keys.length ? ' animated' : ''}`}
                data-act="fx-kf"
                disabled={!inside}
                aria-pressed={!!here}
                title={here ? t('fxKfRemove') : t('fxKfAdd')}
                aria-label={`${here ? t('fxKfRemove') : t('fxKfAdd')}: ${label}`}
                onClick={(e) => { e.preventDefault(); toggleKey() }}
              >
                <Icon name="diamond" size={12} />
              </button>
            } />
        )
      })}
    </div>
  )
}
