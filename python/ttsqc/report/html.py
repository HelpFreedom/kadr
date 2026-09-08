"""Один самодостаточный HTML рядом с аудио.

Спектрограмма фрагмента — не украшение: запинки на ней видно (разрыв энергии,
повторяющийся формантный рисунок), и глазами это ловится быстрее, чем ушами.

Решения пользователя пишутся в localStorage и выгружаются кнопкой. Это
обязательно с первой версии: каждое нажатие «дефект / не дефект» — обучающий
пример, и без захвата решений с самого начала обучающего набора не будет
никогда.
"""
from __future__ import annotations

import base64
import hashlib
import json
import html
import io
import shutil
from pathlib import Path

import numpy as np

from ..schema import AnalysisResult

RU = {"insert": "вставка", "corrupt": "запинка", "missing": "пропуск",
      "truncation": "обрыв", "stress": "ударение", "misread": "прочтено не так",
      "script_typo": "опечатка в тексте", "region_fail": "не разобрано"}
COLOR = {"insert": "#d9534f", "corrupt": "#e0952a", "missing": "#4a7fd4",
         "truncation": "#8e44ad", "stress": "#16a085", "misread": "#c2410c",
         "script_typo": "#6b7280", "region_fail": "#777"}


def _spectrogram(audio: np.ndarray, t0: float, t1: float, sr: int = 16000,
                 pad: float = 0.35) -> str:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    a = audio[max(int((t0 - pad) * sr), 0):min(int((t1 + pad) * sr), len(audio))]
    if a.size < 512:
        return ""
    fig, ax = plt.subplots(figsize=(3.6, 1.0), dpi=96)
    ax.specgram(a + 1e-9, NFFT=512, Fs=sr, noverlap=384, cmap="magma")
    ax.set_ylim(0, 5000)
    ax.axvspan(0, pad, color="#000", alpha=0.35)
    ax.axvspan(a.size / sr - pad, a.size / sr, color="#000", alpha=0.35)
    ax.set_xticks([])
    ax.set_yticks([])
    for sp in ax.spines.values():
        sp.set_visible(False)
    fig.subplots_adjust(0, 0, 1, 1)
    buf = io.BytesIO()
    fig.savefig(buf, format="png", bbox_inches="tight", pad_inches=0)
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode()


def _mmss(t: float) -> str:
    return f"{int(t // 60):d}:{t % 60:05.2f}"


def write(res: AnalysisResult, out_dir: str) -> str:
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    src = Path(res.audio_path)
    # Имя файла — плохой ключ: у разных проектов дорожки называются одинаково
    # («sped_up_output.mp3»), и копия от прошлого прогона переиспользовалась.
    # Отчёт при этом проигрывал чужой звук, а флаги показывал от нового файла —
    # то есть молча предлагал разметить не то. Ключ по содержимому это
    # исключает, а заодно позволяет держать в одном каталоге разные дорожки.
    digest = hashlib.sha1(
        f"{src.resolve()}|{src.stat().st_size}|{src.stat().st_mtime_ns}".encode()
    ).hexdigest()[:10]
    media = out / f"{src.stem}.{digest}{src.suffix}"
    if not media.exists() or media.stat().st_size != src.stat().st_size:
        shutil.copy2(src, media)
    for stale in out.glob(f"{src.stem}*{src.suffix}"):
        if stale != media:
            stale.unlink()          # чужая дорожка от прошлого прогона

    audio = res.aligned.audio if res.aligned is not None else None

    def render(items: list, offset: int = 0) -> list[str]:
        out_rows = []
        for i, d in enumerate(items):
            spec = _spectrogram(audio, *d.audio) if audio is not None else ""
            heard = d.evidence.get("звучит")
            heard_html = (f'<div class="heard">звучит: <b>{html.escape(str(heard))}</b></div>'
                          if heard else "")
            body = html.escape(d.text) or "<i>звук без соответствия в тексте</i>"
            img = (f'<img class="spec" src="data:image/png;base64,{spec}" alt="">'
                   if spec else "")
            n_of = f"{offset + i + 1}/{offset + len(items)}"
            out_rows.append(f"""
<div class="flag" data-id="{d.id}" data-t0="{d.play[0]:.3f}" data-t1="{d.play[1]:.3f}"
     data-h0="{d.audio[0]:.3f}" data-h1="{d.audio[1]:.3f}">
  <div class="head">
    <span class="n">{n_of}</span>
    <span class="cls" style="background:{COLOR.get(d.cls, '#777')}">{RU.get(d.cls, d.cls)}</span>
    <span class="tier {d.tier}">{'проверить' if d.tier == 'must-review' else 'взглянуть'}</span>
    <span class="t">{_mmss(d.audio[0])}</span>
    <span class="dur">фраза {d.play[1] - d.play[0]:.1f} с</span>
    <span class="conf">{d.confidence:.2f}</span>
    <button class="play">▶ фраза</button>
    <button class="playx">▶ место</button>
    <button class="yes">дефект</button>
    <button class="no">не дефект</button>
  </div>
  <div class="txt"><span class="ctx">{html.escape(d.context_before)}</span>
    <b>{body}</b>
    <span class="ctx">{html.escape(d.context_after)}</span></div>
  {heard_html}
  {img}
  <div class="ev">{html.escape(str(d.evidence))}</div>
</div>""")
        return out_rows

    rows = render(res.defects)
    mismatch_rows = render(res.text_mismatches, len(res.defects))

    warn = ""
    if res.trust < 0.90:
        warn = (f'<div class="warn">Доверие к разбору {res.trust:.0%} — ниже 90%. '
                f'Часть файла выровнять не удалось, и список может быть неполным.</div>')

    st = res.stats
    audio_json = json.dumps(str(src.resolve()), ensure_ascii=False)
    doc = f"""<!doctype html><html lang="ru"><head><meta charset="utf-8">
<title>ttsqc — {html.escape(src.name)}</title><style>
:root{{color-scheme:light dark}}
body{{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;max-width:900px;
background:#fbfbfc;color:#1a1a1a}}
@media(prefers-color-scheme:dark){{body{{background:#16171a;color:#e8e8ea}}
.flag{{background:#1e1f23!important;border-color:#2e3037!important}}
.ctx{{color:#8b8d95!important}} .ev{{color:#6e7079!important}}}}
h1{{font-size:19px;margin:0 0 4px}}
.meta{{color:#6b6d76;font-size:13px;margin-bottom:18px}}
.warn{{background:#fff3cd;border:1px solid #e6c96b;color:#664d03;
padding:10px 14px;border-radius:8px;margin-bottom:16px}}
.flag{{background:#fff;border:1px solid #e3e4e8;border-radius:10px;
padding:12px 14px;margin-bottom:12px}}
.flag.on{{outline:2px solid #4a7fd4}}
.flag.done-yes{{opacity:.5}} .flag.done-no{{opacity:.35}}
.head{{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:8px}}
.n{{color:#8b8d95;font-size:12px;min-width:44px}}
.cls{{color:#fff;padding:1px 9px;border-radius:20px;font-size:12px}}
.tier{{font-size:12px;padding:1px 8px;border-radius:20px;border:1px solid #c9cbd2}}
.tier.must-review{{border-color:#d9534f;color:#d9534f}}
.t{{font-variant-numeric:tabular-nums;color:#6b6d76;font-size:13px}}
.conf{{font-variant-numeric:tabular-nums;color:#6b6d76;font-size:13px}}
button{{font:inherit;font-size:13px;padding:3px 11px;border-radius:7px;
border:1px solid #c9cbd2;background:transparent;color:inherit;cursor:pointer}}
button:hover{{background:#0001}}
.txt{{margin:6px 0}} .txt b{{background:#ffe08a4d;padding:1px 3px;border-radius:3px}}
.ctx{{color:#8b8d95}}
.sec{{font-size:16px;margin:28px 0 4px;padding-top:18px;border-top:1px solid #0002}}
.secnote{{color:#8b8d95;font-size:13px;margin:0 0 12px}}
.dur{{color:#8b8d95;font-size:12px}}
.heard{{margin:4px 0;font-size:14px}}
.heard b{{background:#fca5a54d;padding:1px 4px;border-radius:3px}}
.spec{{display:block;margin:8px 0 4px;border-radius:6px;max-width:100%}}
.ev{{font-size:12px;color:#9a9ca4;font-family:ui-monospace,monospace}}
.bar{{position:sticky;top:0;background:inherit;padding:8px 0;margin-bottom:8px;
border-bottom:1px solid #0001;display:flex;gap:10px;align-items:center}}
kbd{{font:12px ui-monospace,monospace;border:1px solid #c9cbd2;border-radius:4px;
padding:0 5px}}
</style></head><body>
<h1>{html.escape(src.name)}</h1>
<div class="meta">{res.duration:.0f} с · {len(res.script_words)} слов сценария ·
доверие {res.trust:.0%} · якоря {st.get('anchor_coverage', 0):.0%} ·
{len(res.defects)} дефектов звука · {len(res.text_mismatches)} расхождений с текстом ({len(res.defects) / max(res.duration, 1) * 600:.1f} на 10 мин) ·
подавлено {len(res.suppressed)}</div>
{warn}
<div class="bar"><audio id="au" src="{html.escape(media.name)}" preload="metadata"></audio>
<button onclick="dl()">выгрузить решения</button>
<span style="color:#8b8d95;font-size:12.5px">
<kbd>↓</kbd><kbd>↑</kbd> переход · <kbd>пробел</kbd> фраза · <kbd>x</kbd> место ·
<kbd>1</kbd> дефект · <kbd>0</kbd> не дефект</span></div>
{''.join(rows) or '<p>Дефектов звука не найдено.</p>'}
{('<h2 class="sec">Опечатки в сценарии</h2>'
  '<p class="secnote">Здесь диктор прочёл нормально, а написано другое. '
  'Чинится правкой сценария, а не перегенерацией звука.</p>'
  + ''.join(mismatch_rows)) if mismatch_rows else ''}
<script>
const au=document.getElementById('au'),F=[...document.querySelectorAll('.flag')];
let cur=0,stop=null;
const KEY='ttsqc:'+location.pathname;
const marks=JSON.parse(localStorage.getItem(KEY)||'{{}}');
F.forEach((f,i)=>{{
  const id=f.dataset.id;
  if(marks[id])f.classList.add('done-'+marks[id]);
  f.querySelector('.play').onclick=()=>{{sel(i);play();}};
  f.querySelector('.playx').onclick=()=>{{sel(i);play(true);}};
  f.querySelector('.yes').onclick=()=>mark(i,'yes');
  f.querySelector('.no').onclick=()=>mark(i,'no');
}});
function sel(i){{F[cur]?.classList.remove('on');cur=Math.max(0,Math.min(i,F.length-1));
  F[cur].classList.add('on');F[cur].scrollIntoView({{block:'center',behavior:'smooth'}});}}
function play(tight){{const f=F[cur];if(!f)return;
  // По умолчанию играем предложение целиком: полсекунды звука прослушать
  // невозможно, ухо находит дефект только внутри фразы.
  const a=+f.dataset[tight?'h0':'t0'], b=+f.dataset[tight?'h1':'t1'];
  au.currentTime=a;au.play();
  clearTimeout(stop);stop=setTimeout(()=>au.pause(),(b-a)*1000+150);}}
function mark(i,v){{const f=F[i];f.classList.remove('done-yes','done-no');
  f.classList.add('done-'+v);marks[f.dataset.id]=v;
  localStorage.setItem(KEY,JSON.stringify(marks));if(i===cur&&cur<F.length-1)sel(cur+1);}}
function dl(){{
  // Выгружаем И область проигрывания, И точные границы дефекта. Раньше
  // писалась только первая, а она равна целому предложению: несколько флагов
  // в одной фразе становились неразличимы, и разметку нельзя было
  // использовать для обучения.
  // Пишем и путь к аудио: тогда разметка сама говорит, к какому разбору
  // относится, и сопоставлять её руками не нужно.
  const rows=F.map(f=>({{id:f.dataset.id,t0:+f.dataset.t0,t1:+f.dataset.t1,
  a0:+f.dataset.h0,a1:+f.dataset.h1,verdict:marks[f.dataset.id]||null,
  audio:{audio_json}}}));
  const b=new Blob([JSON.stringify(rows,null,2)],{{type:'application/json'}});
  const a=document.createElement('a');a.href=URL.createObjectURL(b);
  a.download='verdicts.json';a.click();}}
addEventListener('keydown',e=>{{
  if(e.key==='ArrowDown'){{sel(cur+1);e.preventDefault();}}
  else if(e.key==='ArrowUp'){{sel(cur-1);e.preventDefault();}}
  else if(e.key===' '){{play();e.preventDefault();}}
  else if(e.key==='x'||e.key==='ч'){{play(true);e.preventDefault();}}
  else if(e.key==='1')mark(cur,'yes'); else if(e.key==='0')mark(cur,'no');}});
if(F.length)sel(0);
</script></body></html>"""
    path = out / "report.html"
    path.write_text(doc, encoding="utf-8")
    return str(path)
