import { useEffect, useState } from 'react'
import type { Anim, Clip, Effect, FxPreset, TextStyle } from '@shared/types'
import { useEditor, useFxPresets, findClip, uid } from '@/state/store'
import { GLOW_DEFAULTS } from '@/gl/glow'
import { useT } from '@/i18n'
import { CtxMenu } from './CtxMenu'

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
  const project = useEditor((s) => s.project)
  const found = clipId ? findClip(project, clipId) : null

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
      <EffectsSection clip={clip} />
    </>
  )
}

function Slider({
  label, value, min, max, step, onChange
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (v: number) => void
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
    </label>
  )
}

function EffectsSection({ clip }: { clip: Clip }) {
  const t = useT()
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const [name, setName] = useState('')
  const fxPresets = useFxPresets((s) => s.presets)
  const update = (effects: Effect[]) => useEditor.getState().updateClip(clip.id, { effects })
  const effects = clip.effects ?? []
  const addGlow = () => {
    useEditor.getState().pushHistory('hEffect')
    update([...effects, { id: uid(), type: 'glow', enabled: true, params: { ...GLOW_DEFAULTS } }])
  }
  useEffect(() => {
    if (!menu) return
    const close = () => setMenu(null)
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [menu])
  // selection moved to another clip — the open menu refers to stale effects
  useEffect(() => setMenu(null), [clip.id])
  const saveFx = () => {
    const nm = name.trim()
    if (!nm || !effects.length) return
    useFxPresets.getState().savePreset({
      name: nm,
      effects: effects.map((e) => ({ ...e, params: { ...e.params } }))
    })
    setName('')
  }
  const applyFx = (p: FxPreset) => {
    useEditor.getState().pushHistory('hPreset')
    update(p.effects.map((e) => ({ ...e, id: uid(), params: { ...e.params } })))
    setMenu(null)
  }
  return (
    <>
      <div className="insp-section fx-section-head">
        <span>{t('effects')}</span>
        <button
          className={`fx-preset-btn${menu ? ' active' : ''}`}
          title={t('fxPresetsHint')}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect()
            setMenu(menu ? null : { x: r.left, y: r.bottom + 4 })
          }}
        >
          ⭐ {t('presets')}
        </button>
      </div>
      {effects.map((fx) =>
        fx.type === 'glow' ? (
          <GlowControls key={fx.id} clip={clip} fx={fx} />
        ) : null
      )}
      {!effects.some((e) => e.type === 'glow') && (
        <button className="fx-add" onClick={addGlow}>✨ {t('fxGlow')}</button>
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
                onClick={() => useFxPresets.getState().deletePreset(p.id)}
              >
                ✕
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

function GlowControls({ clip, fx }: { clip: Clip; fx: Effect }) {
  const t = useT()
  const st = () => useEditor.getState()
  const patchFx = (patch: Partial<Effect>) =>
    st().updateClip(clip.id, {
      effects: (clip.effects ?? []).map((e) => (e.id === fx.id ? { ...e, ...patch } : e))
    })
  const setP = (key: string, v: number | string) =>
    patchFx({ params: { ...fx.params, [key]: v } })
  const num = (key: keyof typeof GLOW_DEFAULTS) => {
    const v = fx.params[key]
    return typeof v === 'number' ? v : (GLOW_DEFAULTS[key] as number)
  }
  return (
    <div className="fx-block">
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
          <span>✨ {t('fxGlow')}</span>
        </label>
        <button
          className="fx-del"
          title={t('fxDelete')}
          onClick={() => {
            st().pushHistory('hEffect')
            st().updateClip(clip.id, {
              effects: (clip.effects ?? []).filter((e) => e.id !== fx.id)
            })
          }}
        >✕</button>
      </div>
      <label className="insp-field">
        <span>{t('color')}</span>
        <input
          type="color"
          value={typeof fx.params.color === 'string' ? fx.params.color : GLOW_DEFAULTS.color}
          onFocus={() => st().pushHistory('hEffect')}
          onChange={(e) => setP('color', e.target.value)}
        />
      </label>
      <Slider label={t('fxSize')} value={num('size')} min={4} max={400} step={1}
        onChange={(v) => setP('size', v)} />
      <Slider label={t('fxIntensity')} value={num('intensity')} min={0} max={3} step={0.05}
        onChange={(v) => setP('intensity', v)} />
      <Slider label={t('fxSaturation')} value={num('saturation')} min={0} max={2} step={0.05}
        onChange={(v) => setP('saturation', v)} />
      <Slider label={t('fxSmoke')} value={num('smoke')} min={0} max={1} step={0.05}
        onChange={(v) => setP('smoke', v)} />
      <Slider label={t('fxSpeed')} value={num('speed')} min={0} max={3} step={0.05}
        onChange={(v) => setP('speed', v)} />
      <Slider label={t('fxParticles')} value={num('particles')} min={0} max={1} step={0.05}
        onChange={(v) => setP('particles', v)} />
    </div>
  )
}
