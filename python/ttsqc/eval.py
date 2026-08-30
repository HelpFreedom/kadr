"""Оценка по ручной разметке из отчёта.

Считает полноту и точность против verdicts.json, выгруженного пользователем.
Сопоставление по перекрытию областей: вердикт вынесен по прослушанной фразе,
поэтому флаг засчитывается, если его звук попадает внутрь этой фразы.

Существует ради одного: любой порог, снимающий ложные, режет и настоящие, и
без числа на обеих сторонах выбор порога — это подгонка под собственные
представления о том, что считать дефектом.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path


def load_verdicts(path: str) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """Границы вердикта: точные, если они есть в файле.

    В ранних выгрузках писалась только область проигрывания — целое
    предложение. Сопоставление по ней склеивает разные флаги одной фразы в
    один участок и завышает и точность, и полноту. Новые выгрузки содержат
    поля a0/a1 с границами самого дефекта.
    """
    rows = json.load(open(path, encoding="utf-8"))

    def span(r):
        return (r["a0"], r["a1"]) if "a0" in r else (r["t0"], r["t1"])

    yes = [span(r) for r in rows if r.get("verdict") == "yes"]
    no = [span(r) for r in rows if r.get("verdict") == "no"]
    return yes, no


def _hits(span: tuple[float, float], zones: list[tuple[float, float]]) -> bool:
    a, b = span
    return any(b > z0 and a < z1 for z0, z1 in zones)


def score(defects: list[dict], yes: list[tuple[float, float]],
          no: list[tuple[float, float]]) -> dict:
    found = [z for z in yes if any(_hits(tuple(d["audio"]), [z]) for d in defects)]
    hit_no = [d for d in defects if _hits(tuple(d["audio"]), no)]
    unknown = [d for d in defects
               if not _hits(tuple(d["audio"]), yes) and not _hits(tuple(d["audio"]), no)]
    return {
        "подтверждено": len(yes),
        "из них найдено": len(found),
        "полнота": round(len(found) / max(len(yes), 1), 3),
        "флагов": len(defects),
        "попало в отвергнутые": len(hit_no),
        "новых, не размеченных": len(unknown),
        "пропущено": [z for z in yes if z not in found],
    }


def main(argv: list[str]) -> int:
    defects = json.load(open(argv[0], encoding="utf-8"))["defects"]
    yes, no = load_verdicts(argv[1])
    r = score(defects, yes, no)
    print(f"полнота {r['полнота']:.0%} ({r['из них найдено']}/{r['подтверждено']})  "
          f"| флагов {r['флагов']}  | из них ранее отвергнуты {r['попало в отвергнутые']}  "
          f"| новых {r['новых, не размеченных']}")
    for a, b in r["пропущено"]:
        print(f"   пропущен подтверждённый дефект {a:.2f}-{b:.2f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
