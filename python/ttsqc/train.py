"""Обучение оценки уверенности на ручной разметке.

Почему это заменяет ручную настройку. Формулы уверенности в `fusion` были
выставлены руками: коэффициенты вида «0.35 + 0.25 × длительность» подобраны на
глаз по нескольким примерам. Порогов таких около тридцати, и согласовать их
между собой перебором невозможно — каждая правка одного сдвигает остальные, а
проверить можно только прогоном целиком.

Разметка при этом накапливалась и не использовалась. Здесь она используется:
каждый показанный флаг с вердиктом «дефект / не дефект» становится строкой
обучения, признаки берутся из его же улик, и веса подбираются логистической
регрессией, а не глазом.

Модель намеренно простая. Ста с небольшим примеров хватает на линейную модель с
десятком признаков и не хватает на что-либо сложнее: градиентный бустинг здесь
запомнит выборку. Пригодность проверяется перекрёстной проверкой по прогонам,
а не по строкам — иначе один и тот же дефект, показанный в двух прогонах,
попадёт и в обучение, и в проверку.
"""
from __future__ import annotations

import glob
import json
import os
from pathlib import Path

import numpy as np

FEATURES = [
    "is_insert", "is_corrupt", "is_missing", "is_trunc",
    "dur", "log_dur", "has_text", "n_chars", "char_yield", "unclear",
    "similarity", "repeat_len", "voiced", "star_s", "s1", "s2_long",
    "n_channels", "rule_conf", "late_onset", "local_sim",
]


def featurize(f: dict) -> np.ndarray:
    """Улики флага → числовой вектор. Порядок совпадает с FEATURES."""
    e = f.get("evidence", {})
    a = f["audio"]
    dur = max(a[1] - a[0], 1e-3)
    heard = str(e.get("звучит", "") or "")
    unclear = 1.0 if "неразборчив" in heard else 0.0
    n_chars = 0.0 if unclear else float(len(heard))
    cls = f.get("class", "")
    return np.array([
        1.0 if cls == "insert" else 0.0,
        1.0 if cls in ("corrupt", "misread", "script_typo") else 0.0,
        1.0 if cls == "missing" else 0.0,
        1.0 if cls == "truncation" else 0.0,
        dur, np.log(dur),
        1.0 if (heard and not unclear) else 0.0,
        n_chars, n_chars / dur, unclear,
        float(e.get("сходство", 0.0) or 0.0),
        float(len(str(e.get("повтор", "") or ""))),
        float(e.get("voiced", 0.0) or 0.0),
        float(e.get("star_s", 0.0) or 0.0),
        float(e.get("s1", 0.0) or 0.0),
        float(e.get("s2_long", 0.0) or 0.0),
        float(e.get("каналов", 1) or 1),
        float(f.get("confidence", 0.0)),
        float(e.get("опоздание", 0.0) or 0.0),
        float(e.get("похоже_на_текст", 0.0) or 0.0),
    ], dtype=np.float64)


def load_audio_features(keep: list[dict], runs_dir: str, cfg, device: str = "cuda"
                        ) -> np.ndarray:
    """Представление звука для каждого размеченного кандидата.

    Аудио и модель загружаются по одному разу на файл: перезагружать
    выравниватель на каждый отрезок — минуты впустую.
    """
    from . import ctc, io_audio
    from .audiofeat import embed_spans

    by_audio: dict[str, list[int]] = {}
    for i, f in enumerate(keep):
        by_audio.setdefault(f["_audio"], []).append(i)

    E = np.zeros((len(keep), 2048), dtype=np.float32)
    backend = ctc.load_aligner(device, cfg["ctc"]["model"], "wav2vec2")
    try:
        for path, idxs in by_audio.items():
            audio = io_audio.decode(path, cfg["audio"]["sr"])
            spans = [tuple(keep[i]["audio"]) for i in idxs]
            E[idxs] = embed_spans(audio, spans, backend, cfg["audio"]["sr"])
    finally:
        backend.release()
    return E


def load_dataset(verdict_glob: str, runs_dir: str
                 ) -> tuple[np.ndarray, np.ndarray, np.ndarray, list[dict]]:
    """Собрать (X, y, группы прогонов, сами флаги) из всех кругов разметки.

    Вердикт привязывается к флагу по идентификатору и совпадению границ, а не
    по перекрытию областей проигрывания. Это важно: область проигрывания —
    целое предложение, в неё попадает несколько флагов сразу, и сопоставление
    по ней склеивает разные находки в одну. Из-за этого 114 суждений выглядели
    как 30 участков, а ложный флаг рядом с настоящим засчитывался попаданием.
    """
    runs = {}
    for p in glob.glob(os.path.join(runs_dir, "*", "defects.json")):
        d = json.load(open(p, encoding="utf-8"))
        runs[os.path.basename(os.path.dirname(p))] = {
            "audio": d.get("audio", ""),
            "flags": d["defects"] + d.get("text_mismatches", []),
        }

    X, y, g, keep = [], [], [], []
    for vf in sorted(glob.glob(verdict_glob)):
        rows = [r for r in json.load(open(vf, encoding="utf-8")) if r.get("verdict")]
        if not rows:
            continue
        # Если разметка знает своё аудио, прогон определяется однозначно.
        stated = next((r.get("audio") for r in rows if r.get("audio")), None)
        best, bestn = None, -1
        for name, run in runs.items():
            if stated and run["audio"] and os.path.realpath(run["audio"]) != \
                    os.path.realpath(stated):
                continue
            n = _match(run["flags"], rows, id_only=True)
            if n > bestn:
                best, bestn = name, n
        # Прогон, породивший разметку, мог быть перезаписан. Тогда флаги
        # сопоставляются по точным границам дефекта: с тех пор как выгрузка
        # пишет их, а не область проигрывания, этого достаточно.
        if bestn < len(rows) * 0.8:
            for name, run in runs.items():
                n = _match(run["flags"], rows, id_only=False)
                if n > bestn:
                    best, bestn = name, n
        if not best or bestn < len(rows) * 0.5:
            continue
        run = runs[best]
        # Группа — АУДИОФАЙЛ, а не круг разметки. Проверка «обучили на одном
        # файле, проверили на другом» — единственная, которая отвечает на
        # вопрос о переносимости; разбиение по кругам этого не показывает,
        # потому что круги делались по одному и тому же аудио.
        gid = run["audio"] or best
        pairs = _pairs(run["flags"], rows)
        for f, r in pairs:
            f = dict(f, _audio=run["audio"])
            X.append(featurize(f))
            y.append(1 if r["verdict"] == "yes" else 0)
            g.append(gid)
            keep.append(f)
    gg = np.array(g)
    uniq = {v: i for i, v in enumerate(sorted(set(g)))}
    return np.array(X), np.array(y), np.array([uniq[v] for v in gg]), keep


def _span(r: dict) -> tuple[float, float]:
    return (r["a0"], r["a1"]) if "a0" in r else (r["t0"], r["t1"])


def _pairs(flags: list[dict], rows: list[dict]) -> list[tuple[dict, dict]]:
    """Сопоставить флаги прогона с вердиктами: сперва по идентификатору."""
    by_id = {f["id"]: f for f in flags}
    out, used = [], set()
    for r in rows:
        f = by_id.get(r["id"])
        if f is not None and _same(f, r):
            out.append((f, r))
            used.add(id(f))
    if len(out) >= len(rows) * 0.8:
        return out
    out, used = [], set()
    for r in rows:
        a0, a1 = _span(r)
        best, bov = None, 0.0
        for f in flags:
            if id(f) in used:
                continue
            ov = min(a1, f["audio"][1]) - max(a0, f["audio"][0])
            if ov > bov:
                best, bov = f, ov
        if best is not None and bov > 0.05:
            out.append((best, r))
            used.add(id(best))
    return out


def _match(flags: list[dict], rows: list[dict], id_only: bool) -> int:
    if id_only:
        by_id = {f["id"]: f for f in flags}
        return sum(1 for r in rows
                   if r["id"] in by_id and _same(by_id[r["id"]], r))
    return len(_pairs(flags, rows))


def _same(f: dict, r: dict, tol: float = 0.06) -> bool:
    for key in ("play", "audio"):
        sp = f.get(key)
        if sp and abs(sp[0] - r["t0"]) < tol and abs(sp[1] - r["t1"]) < tol:
            return True
    return False


def fit(X: np.ndarray, y: np.ndarray, groups: np.ndarray):
    from sklearn.linear_model import LogisticRegression
    from sklearn.pipeline import make_pipeline
    from sklearn.preprocessing import StandardScaler

    model = make_pipeline(
        StandardScaler(),
        LogisticRegression(C=0.3, max_iter=2000, class_weight="balanced"))
    model.fit(X, y)
    return model


def cross_val(X: np.ndarray, y: np.ndarray, groups: np.ndarray) -> dict:
    """Проверка с разбиением по кругам разметки.

    Разбивать по строкам нельзя: один и тот же дефект показан в нескольких
    прогонах, и тогда он попадёт и в обучение, и в проверку — оценка выйдет
    завышенной.
    """
    from sklearn.metrics import average_precision_score

    aps, accs = [], []
    for gi in np.unique(groups):
        tr, te = groups != gi, groups == gi
        if len(np.unique(y[tr])) < 2 or te.sum() < 4:
            continue
        m = fit(X[tr], y[tr], groups[tr])
        p = m.predict_proba(X[te])[:, 1]
        if len(np.unique(y[te])) > 1:
            aps.append(average_precision_score(y[te], p))
        accs.append(float(((p >= 0.5).astype(int) == y[te]).mean()))
    return {"средняя точность-полнота": float(np.mean(aps)) if aps else float("nan"),
            "доля верных решений": float(np.mean(accs)) if accs else float("nan"),
            "фолдов": len(accs)}


def _noop_marker():
    pass


def cross_val_audio(X: np.ndarray, y: np.ndarray, groups: np.ndarray,
                    E: np.ndarray, n_comp: int = 24) -> dict:
    """То же, но со звуком. Сжатие обучается только на обучающей части фолда —
    иначе проверочный файл подсмотрит собственное распределение."""
    from sklearn.metrics import average_precision_score

    from .audiofeat import Compressor

    aps, accs = [], []
    for gi in np.unique(groups):
        tr, te = groups != gi, groups == gi
        if len(np.unique(y[tr])) < 2 or len(np.unique(y[te])) < 2:
            continue
        c = Compressor(n_comp).fit(E[tr])
        Xtr = np.hstack([X[tr], c.transform(E[tr])])
        Xte = np.hstack([X[te], c.transform(E[te])])
        m = fit(Xtr, y[tr], groups[tr])
        p = m.predict_proba(Xte)[:, 1]
        aps.append(average_precision_score(y[te], p))
        accs.append(float(((p >= 0.5).astype(int) == y[te]).mean()))
    return {"средняя точность-полнота": float(np.mean(aps)) if aps else float("nan"),
            "доля верных решений": float(np.mean(accs)) if accs else float("nan"),
            "фолдов": len(accs)}


def save(model, path: str, compressor=None) -> None:
    import pickle
    with open(path, "wb") as fh:
        pickle.dump({"model": model, "features": FEATURES,
                     "compressor": compressor}, fh)


def load(path: str):
    """Вернуть (модель, сжатие звука). Сжатие может отсутствовать."""
    import pickle
    with open(path, "rb") as fh:
        d = pickle.load(fh)
    return d["model"], d.get("compressor")


if __name__ == "__main__":
    import sys
    args = [a for a in sys.argv[1:] if a != "--audio"]
    use_audio = "--audio" in sys.argv
    vg = args[0] if len(args) > 0 else str(Path.home() / "Downloads" / "verdicts*.json")
    rd = args[1] if len(args) > 1 else "."
    out = args[2] if len(args) > 2 else "scorer.pkl"
    X, y, g, flags = load_dataset(vg, rd)
    print(f"примеров {len(y)}: дефект {int(y.sum())}, не дефект {int((1-y).sum())}, "
          f"кругов разметки {len(np.unique(g))}")
    if len(y) < 30:
        print("мало данных для обучения"); raise SystemExit(1)
    print("только признаки:      ",
          {k: round(v, 3) if isinstance(v, float) else v
           for k, v in cross_val(X, y, g).items()})

    # Представление звука по умолчанию ВЫКЛЮЧЕНО.
    #
    # На двух файлах оно поднимало среднюю точность-полноту с 0.533 до 0.619, и
    # я его подключил. На трёх файлах проверка перевернулась: 0.744 без него
    # против 0.685 с ним. Значит на двух фолдах оно подхватывало особенности
    # конкретных записей, а не признаки дефектов, и двух фолдов просто не
    # хватало, чтобы это увидеть.
    #
    # Возможно, вернётся при большем числе файлов: 24 измерения на 185
    # примеров — почти предел, при котором линейная модель ещё не запоминает.
    # Включается флагом --audio.
    comp, E = None, None
    try:
        if not use_audio:
            raise RuntimeError("выключено")
        from . import config
        from .audiofeat import Compressor
        E = load_audio_features(flags, rd, config.load())
    except Exception as e:                 # noqa: BLE001
        print(f"без представления звука: {e}")

    if E is not None:
        print("признаки + звук:      ",
              {k: round(v, 3) if isinstance(v, float) else v
               for k, v in cross_val_audio(X, y, g, E).items()})
        comp = Compressor(24).fit(E)
        X = np.hstack([X, comp.transform(E)])

    m = fit(X, y, g)
    coef = m[-1].coef_[0][:len(FEATURES)]
    print("\nвес признака (важность в решении):")
    for name, c in sorted(zip(FEATURES, coef), key=lambda t: -abs(t[1]))[:10]:
        print(f"   {name:14} {c:+.3f}")
    save(m, out, comp)
    print(f"\nсохранено: {out}")
