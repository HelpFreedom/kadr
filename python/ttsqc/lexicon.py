"""Словарь произношения латиницы, измеренный по аудио, а не угаданный.

Латинские слова нельзя выровнять напрямую: в словаре акустической модели
только кириллица. До сих пор их произношение задавалось моей таблицей
догадок — и догадки регулярно оказывались неверными. `claude` записано как
«клод», а диктор говорит «клоуд»; `md` как «эмдэ», а звучит «эмдэй». Каждая
такая ошибка даёт ложную вставку на ровном месте: звук есть, ожидаемых букв
нет, детектор честно докладывает о лишнем.

Мерить это не нужно на слух. Латинское слово стоит между двумя обычными,
границы которых выравнивание знает, а жадный декод честно выдаёт, что звучит
в промежутке. Достаточно собрать эти промежутки по нескольким файлам и взять
устойчивое написание.
"""
from __future__ import annotations

import json
from collections import Counter
from pathlib import Path

from .paths import LEARNED


def load() -> dict[str, str]:
    if LEARNED.exists():
        try:
            return json.loads(LEARNED.read_text(encoding="utf-8"))
        except Exception:                 # noqa: BLE001
            return {}
    return {}


def save(d: dict[str, str]) -> None:
    LEARNED.write_text(json.dumps(d, ensure_ascii=False, indent=2, sort_keys=True),
                       encoding="utf-8")


def observe(al, script) -> dict[str, list[str]]:
    """Что звучит на месте каждого латинского слова.

    Окно берётся между соседями по выравниванию — теми, чьи границы известны
    надёжно. Если слово стоит рядом с другим латинским, окно охватывает оба, и
    такие наблюдения отбрасываются: разделить их нечем.
    """
    from .babble import transcribe_span

    placed = {}
    for c in al.chars:
        if not c.occupancy:
            continue
        lo, hi = placed.get(c.script_word, (c.t0, c.t1))
        placed[c.script_word] = (min(lo, c.t0), max(hi, c.t1))

    out: dict[str, list[str]] = {}
    i = 0
    while i < len(script):
        if not script[i].is_latin:
            i += 1
            continue
        # Цепочка подряд идущих латинских слов меряется целиком: «Claude Code»
        # и «CLAUDE.md» диктор читает слитно, а поодиночке их окна не выделить —
        # у соседа слева или справа тоже нет границ.
        j = i
        while j + 1 < len(script) and script[j + 1].is_latin:
            j += 1
        left = i - 1 if i - 1 in placed else None
        right = j + 1 if j + 1 in placed else None
        if left is None or right is None:
            i = j + 1
            continue
        t0, t1 = placed[left][1], placed[right][0]
        span = t1 - t0
        if not (0.05 < span < 3.0):
            i = j + 1
            continue
        heard = transcribe_span(al.greedy, t0, t1).strip()
        if 1 <= len(heard) <= 30:
            key = " ".join(script[k].match for k in range(i, j + 1))
            out.setdefault(key, []).append(heard)
        i = j + 1
    return out


def _plausible(key: str, heard: str) -> bool:
    """Похоже ли услышанное на произношение именно этой цепочки.

    Окно между соседями шире самого слова: границы у выравнивателя не идеально
    плотные, и в него затекает соседняя речь. Проверка на длину это ловит —
    «claude claude md» не может звучать как «утипашиклодклоудэмдио», это
    втрое длиннее написанного.

    Без проверки словарь навредит сильнее догадок: неверная форма подставится
    в выравнивание и породит ложную вставку на каждом вхождении слова.
    """
    letters = len(key.replace(" ", ""))
    return 0.6 * letters <= len(heard) <= 1.6 * letters + 2


def consolidate(obs: dict[str, list[str]], min_count: int = 2) -> dict[str, str]:
    """Устойчивое написание для каждого слова.

    Нужны два согласных наблюдения и правдоподобная длина. Одно наблюдение —
    это шум границ; слово без записи по-прежнему закрывается временным окном,
    что безопасно. Словарь поэтому наполняется по мере обработки файлов, и это
    как раз та часть системы, которая честно улучшается с объёмом.
    """
    out: dict[str, str] = {}
    for word, variants in obs.items():
        good = [v for v in variants if _plausible(word, v)]
        if len(good) < min_count:
            continue
        top, n = Counter(good).most_common(1)[0]
        if n / len(good) >= 0.5:
            out[word] = top
    return out
