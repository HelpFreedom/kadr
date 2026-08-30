"""S1 — провалы апостериорной вероятности, S2 — аномалии длительности.

Оба сигнала считаются по проходу A, у которого внутри зоны нет star-токенов:
всё обязано объясняться сценарием, поэтому спрятать дефект проход не может.

Общий приём для обоих: сырое значение сравнивается не с абсолютным порогом, а
с распределением того же символа в том же контексте. Конфаунд «тихая или
быстрая фонема тоже даёт низкую уверенность и малую длительность» снимается
обусловливанием, а не подбором порога: у /т/, /к/, /п/ разброс большой, у
гласных маленький, и z-score это поглощает сам. Ровно это и покупают шесть
часов одного голоса одной модели — конфаунд становится мешающим параметром.

Пока статистики берутся из самого файла (робастно, медиана и MAD). Корпусные
таблицы подключаются через `Calibration` без изменения вызывающего кода.
"""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np

from .schema import CharAlign

VOWELS = set("аеёиоуыэюя")
MAD_TO_SIGMA = 1.4826


class Calibration:
    """Эмпирические распределения по ячейкам контекста, с бэкоффом.

    Именно эмпирические, а не медиана с MAD. Распределение пиковой
    апостериорной вероятности сосредоточено почти в нуле (медиана -0.000) с
    длинным хвостом влево: MAD у него микроскопический, поэтому z-score
    взрывается сразу у всех, и все запинки приезжают с одинаковой
    уверенностью — ранжировать их становится нечем. Процентиль по
    накопленному распределению этой болезни не имеет.

    Ячейка: (символ, гласный ли, позиция в слове, бакет темпа, есть ли пауза
    после). Предпаузальное удлинение в русском большое, и без последнего
    признака сигнал длительности срабатывает на каждой запятой.
    """

    MIN_CELL = 30

    def __init__(self) -> None:
        self.dur: dict[tuple, np.ndarray] = {}
        self.peak: dict[tuple, np.ndarray] = {}

    @staticmethod
    def _cells(ch: str, pos: str, rate_b: int, prepause: bool) -> list[tuple]:
        v = ch in VOWELS
        return [(ch, v, pos, rate_b, prepause), (ch, v, pos), (ch, v), (ch,), (v,)]

    def _lookup(self, table: dict, ch: str, pos: str, rate_b: int,
                prepause: bool) -> np.ndarray | None:
        for key in self._cells(ch, pos, rate_b, prepause):
            hit = table.get(key)
            if hit is not None:
                return hit
        return None

    @staticmethod
    def _score(sorted_vals: np.ndarray | None, value: float, upper: bool) -> float:
        """Процентиль → сопоставимая величина `-log10(p)`, срезанная на 6.

        Единые единицы у всех сигналов — иначе веса слияния несравнимы между
        собой и подбираются вслепую.
        """
        if sorted_vals is None or sorted_vals.size < 8:
            return 0.0
        n = sorted_vals.size
        below = float(np.searchsorted(sorted_vals, value, side="left"))
        p = (n - below) / n if upper else below / n
        p = min(max(p, 1.0 / (n + 1)), 1.0)
        return float(min(-math.log10(p), 6.0))

    @classmethod
    def from_samples(cls, samples: list[tuple[tuple, float, float]]) -> "Calibration":
        """samples: [(ключ_ячейки, log_длительность, peak)]."""
        cal = cls()
        for table, which in ((cal.dur, 1), (cal.peak, 2)):
            buckets: dict[tuple, list[float]] = defaultdict(list)
            for row in samples:
                for key in cls._cells(*row[0]):
                    buckets[key].append(row[which])
            for key, vals in buckets.items():
                if len(vals) < cls.MIN_CELL and len(key) == 5:
                    continue
                table[key] = np.sort(np.asarray(vals, dtype=np.float64))
        return cal

    def dur_long(self, ch, pos, rate_b, prepause, value) -> float:
        """Насколько символ длиннее нормы: 0 — обычно, 3 — реже одного из 1000."""
        return self._score(self._lookup(self.dur, ch, pos, rate_b, prepause),
                           value, upper=True)

    def dur_short(self, ch, pos, rate_b, prepause, value) -> float:
        return self._score(self._lookup(self.dur, ch, pos, rate_b, prepause),
                           value, upper=False)

    def peak_bad(self, ch, pos, rate_b, prepause, value) -> float:
        """Насколько уверенность ниже обычной для этого символа в этом контексте."""
        return self._score(self._lookup(self.peak, ch, pos, rate_b, prepause),
                           value, upper=False)


def _positions(chars: list[CharAlign]) -> dict[int, str]:
    """Позиция символа в слове: начало / середина / конец."""
    by_word: dict[int, list[int]] = defaultdict(list)
    for i, c in enumerate(chars):
        by_word[c.script_word].append(i)
    out: dict[int, str] = {}
    for idxs in by_word.values():
        for n, i in enumerate(idxs):
            out[i] = "init" if n == 0 else ("fin" if n == len(idxs) - 1 else "med")
    return out


def _rate_buckets(chars: list[CharAlign], window: float = 2.0,
                  n_bins: int = 5) -> tuple[dict[int, int], list[float]]:
    """Локальный темп: символов в секунду в окне ±window."""
    times = np.array([c.t0 for c in chars])
    rates = np.empty(len(chars))
    for i, t in enumerate(times):
        n = int(np.sum((times >= t - window) & (times <= t + window)))
        rates[i] = n / (2 * window)
    edges = list(np.quantile(rates, np.linspace(0, 1, n_bins + 1)[1:-1]))
    buckets = {i: int(np.searchsorted(edges, r)) for i, r in enumerate(rates)}
    return buckets, edges


def _prepause(chars: list[CharAlign], thr: float = 0.20) -> dict[int, bool]:
    out: dict[int, bool] = {}
    for i, c in enumerate(chars):
        nxt = chars[i + 1] if i + 1 < len(chars) else None
        out[i] = nxt is None or (nxt.t0 - c.t1) > thr
    return out


def context_keys(chars: list[CharAlign]) -> list[tuple]:
    """Ключ ячейки контекста для каждого символа."""
    pos = _positions(chars)
    rate, _ = _rate_buckets(chars)
    pre = _prepause(chars)
    return [(c.char, pos[i], rate[i], pre[i]) for i, c in enumerate(chars)]


def harvest(chars: list[CharAlign]) -> list[tuple[tuple, float, float]]:
    """Наблюдения для калибровки: только символы с непустой занятостью."""
    keys = context_keys(chars)
    out = []
    for c, k in zip(chars, keys):
        if c.occupancy <= 0 or not math.isfinite(c.peak):
            continue
        out.append((k, math.log(max(c.t1 - c.t0, 1e-3)), c.peak))
    return out


def score_words(chars: list[CharAlign], cal: Calibration) -> dict[int, dict]:
    """Пословные S1 и S2.

    S1 — среднее двух наименьших пиков слова: устойчиво, ловит «один слог
    мусорный», но не даёт одному взрывному согласному тянуть оценку вниз.

    S2 разделён на три выхода, потому что они означают разное: растяжка ведёт
    к `corrupt`, проглатывание — к `missing`, сжатие слова целиком — к третьему.
    В одиночку S2 не срабатывает: намеренно долгое слово от глюка по одной
    длительности неотличимо.
    """
    keys = context_keys(chars)
    by_word: dict[int, list[int]] = defaultdict(list)
    for i, c in enumerate(chars):
        by_word[c.script_word].append(i)

    out: dict[int, dict] = {}
    for w, idxs in by_word.items():
        bad, longs, shorts, empty = [], [], [], 0
        for i in idxs:
            c = chars[i]
            if c.occupancy <= 0:
                empty += 1
                continue
            ch, pos, rate_b, pre = keys[i]
            ld = math.log(max(c.t1 - c.t0, 1e-3))
            bad.append(cal.peak_bad(ch, pos, rate_b, pre, c.peak))
            longs.append(cal.dur_long(ch, pos, rate_b, pre, ld))
            shorts.append(cal.dur_short(ch, pos, rate_b, pre, ld))
        # Два худших символа слова: устойчиво к одному взрывному согласному,
        # но ловит «один слог мусорный».
        s1 = float(np.mean(sorted(bad, reverse=True)[:2])) if bad else 6.0
        out[w] = {
            "s1": s1,
            "s2_long": max(longs) if longs else 0.0,
            "s2_short": max(shorts) if shorts else 0.0,
            "empty_frac": empty / max(len(idxs), 1),
            "t0": min(chars[i].t0 for i in idxs),
            "t1": max(chars[i].t1 for i in idxs),
            "n_chars": len(idxs),
        }
    return out
