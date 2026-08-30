"""Label track для Audacity: метки поверх волны и спектрограммы."""
from __future__ import annotations

from ..schema import AnalysisResult

RU = {"insert": "вставка", "corrupt": "запинка", "missing": "пропуск",
      "truncation": "обрыв", "stress": "ударение",
      "misread": "прочтено не так", "script_typo": "опечатка в тексте", "region_fail": "не разобрано"}


def write(res: AnalysisResult, path: str) -> None:
    with open(path, "w", encoding="utf-8") as f:
        for d in res.defects:
            label = f"{RU.get(d.cls, d.cls)} {d.confidence:.2f}"
            if d.text:
                label += f" «{d.text[:40]}»"
            f.write(f"{d.audio[0]:.6f}\t{d.audio[1]:.6f}\t{label}\n")
