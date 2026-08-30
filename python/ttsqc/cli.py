"""ttsqc — детектор дефектов в синтезированной русской озвучке."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import analyze as A
from . import config
from . import paths
from .report import audacity, html as html_report

RU = {"insert": "вставка", "corrupt": "запинка", "missing": "пропуск",
      "truncation": "обрыв", "stress": "ударение",
      "misread": "прочтено не так", "script_typo": "опечатка в тексте"}


def _mmss(t: float) -> str:
    return f"{int(t // 60):d}:{t % 60:05.2f}"


def cmd_check(args) -> int:
    cfg = config.load(args.config)
    res = A.analyze(args.audio, args.script, cfg, device=args.device,
                    max_flags=args.max_flags,
                    min_confidence=0.0 if args.all else args.min_confidence)

    # Каталог по имени аудио, а не общий «out»: прогоны разных файлов больше
    # не наступают друг на друга, и разметку не приходится сопоставлять
    # вручную — каждая лежит рядом со своим разбором.
    out = Path(args.out) if args.out else (
        paths.RUNS / Path(args.audio).stem)
    out.mkdir(parents=True, exist_ok=True)
    _protect(out, args.audio)
    payload = {
        "audio": str(Path(args.audio).resolve()),
        "script": str(Path(args.script).resolve()),
        "duration": round(res.duration, 3),
        "trust": round(res.trust, 4),
        "stats": res.stats,
        "defects": [d.to_json() for d in res.defects],
        "suppressed": [d.to_json() for d in res.suppressed],
        "text_mismatches": [d.to_json() for d in res.text_mismatches],
    }
    (out / "defects.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    audacity.write(res, str(out / "labels.txt"))
    report = html_report.write(res, str(out))

    print(f"\n{Path(args.audio).name} — {res.duration:.0f} с, "
          f"{len(res.script_words)} слов сценария")
    print(f"доверие к разбору {res.trust:.0%}, якоря {res.stats['anchor_coverage']:.0%}")
    if res.trust < 0.90:
        print("  ВНИМАНИЕ: доверие ниже 90%, список может быть неполным")
    print(f"\nнайдено {len(res.defects)} "
          f"({len(res.defects) / max(res.duration, 1) * 600:.1f} на 10 минут), "
          f"подавлено {len(res.suppressed)}\n")
    if len(res.defects) > 25:
        hi = sum(1 for d in res.defects if d.confidence >= 0.7)
        mid = sum(1 for d in res.defects if 0.4 <= d.confidence < 0.7)
        print(f"  уверенных (>=0.70): {hi} | средних: {mid} | "
              f"слабых: {len(res.defects) - hi - mid}")
        print("  ниже — первые 25; остальные в отчёте\n")
    for i, d in enumerate(res.defects[:25], 1):
        mark = "!" if d.tier == "must-review" else " "
        heard = d.evidence.get("звучит")
        if heard:
            where = f"«{d.text[:26]}» → звучит «{str(heard)[:26]}»"
        elif d.text:
            where = f"«{d.text[:50]}»"
        else:
            # У вставки текста нет по определению — показываем, между какими
            # словами сценария она звучит, иначе флаг некуда приложить.
            where = (f"после «…{d.context_before[-32:]}» "
                     f"перед «{d.context_after[:32]}…»")
        print(f" {mark}{i:3}. {_mmss(d.audio[0])}–{_mmss(d.audio[1])}  "
              f"{RU.get(d.cls, d.cls):17} {d.confidence:.2f}  {where}")
    if res.text_mismatches:
        print(f"\nотдельно — опечатки в сценарии ({len(res.text_mismatches)}), "
              f"чинятся правкой текста:")
        for d in res.text_mismatches:
            heard = d.evidence.get("звучит", "")
            print(f"     {_mmss(d.audio[0])}  {RU.get(d.cls, d.cls):17} "
                  f"«{d.text[:24]}» → звучит «{str(heard)[:24]}»")
    print(f"\nотчёт: {report}")
    return 0


def _protect(out: Path, audio: str) -> None:
    """Не затирать каталог, где лежит разбор другого файла.

    Прогон пишет туда и defects.json, и копию аудио, и отчёт. Если запустить в
    тот же каталог другой файл, разметка предыдущего теряется, а при
    одновременном запуске двух прогонов каталог вообще остаётся
    рассогласованным: звук от одного файла, флаги от другого. Такое уже
    случилось и чуть не привело к разметке не того аудио.
    """
    prev = out / "defects.json"
    if not prev.exists():
        return
    try:
        old = json.loads(prev.read_text(encoding="utf-8")).get("audio", "")
    except Exception:                      # noqa: BLE001
        return
    if not old or Path(old).resolve() == Path(audio).resolve():
        return
    stamp = f"{Path(old).parent.name}-{Path(old).stem}"
    keep = out.parent / f"{out.name}.{stamp}"
    n = 1
    while keep.exists():
        n += 1
        keep = out.parent / f"{out.name}.{stamp}.{n}"
    out.rename(keep)
    out.mkdir(parents=True, exist_ok=True)
    print(f"в каталоге был разбор другого файла — сохранён как {keep}")


def cmd_learn(args) -> int:
    """Переобучить оценку на всей накопленной разметке.

    Рабочий цикл: прогнать файл -> разметить отчёт -> выгрузить решения ->
    эта команда -> прогнать следующий. Каждый круг разметки становится частью
    обучения, и оценка перестраивается целиком, а не подкручивается руками.
    """
    from . import train
    import numpy as np

    from . import config
    cfg = config.load()
    runs = args.runs or str(paths.RUNS)
    X, y, g, _keep = train.load_dataset(args.verdicts, runs)
    if len(y) < 30:
        print(f"примеров {len(y)} — мало для обучения, нужно хотя бы 30")
        return 1
    cv = train.cross_val(X, y, g)
    print(f"примеров {len(y)}: дефект {int(y.sum())}, не дефект {int((1 - y).sum())}, "
          f"кругов разметки {len(set(g.tolist()))}")
    print(f"перекрёстная проверка по кругам: доля верных решений "
          f"{cv['доля верных решений']:.0%}, "
          f"средняя точность-полнота {cv['средняя точность-полнота']:.3f}")
    comp = None
    if args.audio:
        from .audiofeat import Compressor
        E = train.load_audio_features(_keep, runs, cfg)
        print("признаки + звук:      ",
              {k: round(v, 3) if isinstance(v, float) else v
               for k, v in train.cross_val_audio(X, y, g, E).items()})
        comp = Compressor(24).fit(E)
        X = np.hstack([X, comp.transform(E)])
    train.save(train.fit(X, y, g), args.out, comp)
    print(f"оценка сохранена: {args.out}")
    return 0


def cmd_lexicon(args) -> int:
    """Измерить произношение латиницы по аудио и пополнить словарь."""
    from . import lexicon, pipeline
    cfg = config.load(args.config)
    obs: dict[str, list[str]] = {}
    for audio, script in zip(args.audio, args.script):
        al = pipeline.align_file(audio, script, cfg, args.device)
        from .normalize import normalize_script
        for k, v in lexicon.observe(al, normalize_script(
                open(script, encoding="utf-8").read())).items():
            obs.setdefault(k, []).extend(v)
    learned = lexicon.load()
    fresh = lexicon.consolidate(obs)
    added = {k: v for k, v in fresh.items() if learned.get(k) != v}
    learned.update(fresh)
    lexicon.save(learned)
    print(f"наблюдений по {len(obs)} словам, устойчивых {len(fresh)}, "
          f"новых или изменённых {len(added)}")
    for k, v in sorted(added.items()):
        print(f"   {k:16} -> «{v}»   (наблюдений {len(obs[k])})")
    print(f"\nсловарь: {lexicon.LEARNED}")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="ttsqc", description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("check", help="разобрать файл и выдать список дефектов")
    c.add_argument("audio")
    c.add_argument("--script", required=True, help="текст, отправленный в TTS")
    c.add_argument("-o", "--out", default=None,
                   help="каталог для выдачи (по умолчанию runs/<имя аудио>)")
    c.add_argument("--device", default="cuda")
    c.add_argument("--config", default=None)
    c.add_argument("--all", action="store_true",
                   help="показать всех кандидатов (то же, что --min-confidence 0)")
    c.add_argument("--max-flags", type=int, default=40,
                   metavar="N", help="сколько флагов на 10 минут (по умолчанию 40)")
    c.add_argument("--min-confidence", type=float, default=0.4, metavar="P",
                   help="порог обученной оценки. По умолчанию 0.4 — рабочий режим: "
                        "около 19 флагов на файл, 55%% из них настоящие, находится "
                        "86%% дефектов. Для разметки ставьте 0 — тогда показываются "
                        "все кандидаты по убыванию уверенности")
    c.set_defaults(func=cmd_check)

    l = sub.add_parser("learn", help="переобучить оценку на накопленной разметке")
    l.add_argument("--verdicts",
                   default=str(Path.home() / "Downloads" / "verdicts*.json"),
                   help="маска файлов с вашими решениями из отчётов")
    l.add_argument("--runs", default=None,
                   help="каталог с прогонами (по умолчанию runs/ в проекте)")
    l.add_argument("--out", default="scorer.pkl")
    l.add_argument("--audio", action="store_true",
                   help="добавить представление звука (по замеру на трёх файлах "
                        "оно ухудшает переносимость, поэтому выключено)")
    l.set_defaults(func=cmd_learn)

    x = sub.add_parser("lexicon",
                       help="измерить произношение латиницы по вашему аудио")
    x.add_argument("audio", nargs="+")
    x.add_argument("--script", required=True, nargs="+")
    x.add_argument("--device", default="cuda")
    x.add_argument("--config", default=None)
    x.set_defaults(func=cmd_lexicon)

    args = ap.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
