"""Сбор корпусных статистик по чистой речи того же голоса и той же модели.

Зачем это обязательно, а не улучшение по вкусу. Пока статистики берутся из
самого разбираемого файла, оценка сигнала — это процентиль внутри него, и она
по построению не умеет сказать «этот файл хуже обычного»: порог «худшие 0.3%»
пропустит ровно 0.3% слов и в чистом файле, и в разваленном. Абсолютная
плохость появляется только при сравнении с внешней нормой.

Норма собирается по нескольким дублям одного голоса одной модели. Дефекты в
корпусе есть, но их меньшинство, а оценки берутся по накопленному
распределению целиком, поэтому хвост в 1–2% его не сдвигает.
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

import numpy as np

from . import config, pipeline, signals_ctc as S12


def harvest_file(audio: str, script: str, cfg, device: str = "cuda") -> list[tuple]:
    al = pipeline.align_file(audio, script, cfg, device)
    # Берём только надёжные зоны: норма должна описывать, как выглядит
    # правильно произнесённое слово, а не как выглядит спорный участок.
    ok = {w for w, rel in al.word_reliable.items() if rel}
    chars = [c for c in al.chars if c.script_word in ok]
    return S12.harvest(chars)


def build(pairs: list[tuple[str, str]], out_path: str, cfg,
          device: str = "cuda") -> S12.Calibration:
    samples: list[tuple] = []
    for i, (audio, script) in enumerate(pairs, 1):
        print(f"[{i}/{len(pairs)}] {Path(audio).parent.name}/{Path(audio).name}",
              flush=True)
        try:
            got = harvest_file(audio, script, cfg, device)
        except Exception as e:                      # noqa: BLE001
            print(f"    пропущен: {e}", flush=True)
            continue
        print(f"    символов: {len(got)}", flush=True)
        samples.extend(got)

    cal = S12.Calibration.from_samples(samples)
    save(cal, out_path)
    print(f"\nвсего символов {len(samples)}, ячеек длительности {len(cal.dur)}, "
          f"ячеек уверенности {len(cal.peak)}\nсохранено: {out_path}")
    return cal


def save(cal: S12.Calibration, path: str) -> None:
    blob: dict[str, np.ndarray] = {}
    for name, table in (("dur", cal.dur), ("peak", cal.peak)):
        for key, vals in table.items():
            blob[f"{name}|" + "|".join(map(str, key))] = vals
    np.savez_compressed(path, **blob)


def load(path: str) -> S12.Calibration:
    cal = S12.Calibration()
    with np.load(path, allow_pickle=False) as z:
        for name in z.files:
            head, *parts = name.split("|")
            key = tuple(_coerce(p) for p in parts)
            (cal.dur if head == "dur" else cal.peak)[key] = z[name]
    return cal


def _coerce(s: str):
    if s in ("True", "False"):
        return s == "True"
    try:
        return int(s)
    except ValueError:
        return s


def discover(root: str | None = None) -> list[tuple[str, str]]:
    """Пары (дубль, сценарий) из папок проектов.

    root по умолчанию — ~/Videos либо KADR_VIDEOS, если задан.
    """
    base = Path(root or os.environ.get("KADR_VIDEOS") or (Path.home() / "Videos"))
    out: list[tuple[str, str]] = []
    if not base.is_dir():
        return out
    for d in sorted(base.iterdir()):
        script = d / "text.txt"
        if not script.is_file():
            continue
        for voice in sorted(d.glob("voice*.mp3")):
            out.append((str(voice), str(script)))
    return out


if __name__ == "__main__":
    cfg = config.load()
    pairs = discover()
    limit = int(sys.argv[1]) if len(sys.argv) > 1 else len(pairs)
    out = sys.argv[2] if len(sys.argv) > 2 else "calibration.npz"
    print(f"дублей найдено {len(pairs)}, берём {min(limit, len(pairs))}\n")
    build(pairs[:limit], out, cfg)
