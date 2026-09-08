"""Границы фраз для перегенерации: где именно резать озвучку.

Отдельно от пакета ttsqc и без единого его импорта — здесь только числа, так
модуль проверяется синтетикой, без GPU и без моделей (scripts/check-phrases.py).

Почему не берём готовое `ttsqc.fusion.sentence_span`: оно считает область
ПРОСЛУШИВАНИЯ. Она паддится на ±0.25 с, обрезается по 12 с, а при неудаче
`assemble.add()` подменяет её на «дефект ±1 секунда». Для реза это негодно —
нужна точка в тишине между предложениями с точностью до миллисекунд.
"""
from __future__ import annotations

import bisect

import numpy as np

RMS_HOP_S = 0.005          # шаг поиска тишины: 5 мс даёт нужную точность
RMS_WIN_S = 0.010
VAD_HOP_S = 512 / 16000.0  # сетка Silero, как в ttsqc.signals_vad
VAD_SPEECH_P = 0.5         # выше — считаем, что там речь, и резать нельзя
SEAM_PAD_S = 0.05          # чуть шире зазора: границы слов сами по себе неточны
SILENCE_FLOOR_DB = -45.0
FLOOR_MARGIN_DB = 6.0


def rms_profile(audio, sr: int, hop_s: float = RMS_HOP_S,
                win_s: float = RMS_WIN_S) -> tuple[np.ndarray, float]:
    """Профиль громкости в дБ с шагом hop_s и робастный уровень шума файла."""
    if audio is None or len(audio) == 0:
        return np.zeros(0), SILENCE_FLOOR_DB
    hop = max(1, int(round(hop_s * sr)))
    win = max(hop, int(round(win_s * sr)))
    n = max(1, (len(audio) - 1) // hop + 1)
    sq = np.asarray(audio, dtype=np.float64) ** 2
    cs = np.concatenate(([0.0], np.cumsum(sq)))
    starts = np.arange(n) * hop
    ends = np.minimum(starts + win, len(audio))
    rms = np.sqrt((cs[ends] - cs[starts]) / np.maximum(ends - starts, 1))
    db = 20.0 * np.log10(rms + 1e-12)
    # Пятый процентиль — уровень шума: медиана слишком высока (в ней речь),
    # минимум слишком случаен (один почти нулевой кадр).
    floor_db = float(np.percentile(db, 5))
    return db, floor_db


def silence_threshold_db(floor_db: float) -> float:
    """Порог тишины: не строже −45 дБ и всегда выше собственного шума файла.

    max, а не min: в шумной записи «строже» означало бы, что тихого места не
    найдётся вовсе, и рез каждый раз падал бы в запасной вариант.
    """
    return max(SILENCE_FLOOR_DB, floor_db + FLOOR_MARGIN_DB)


def _longest_run(mask: np.ndarray) -> tuple[int, int]:
    """Самый длинный отрезок True: (начало, конец) или (-1, -1)."""
    best = (-1, -1)
    best_len = 0
    i, n = 0, len(mask)
    while i < n:
        if not mask[i]:
            i += 1
            continue
        j = i
        while j < n and mask[j]:
            j += 1
        if j - i > best_len:
            best_len = j - i
            best = (i, j)
        i = j
    return best


def cut_point(db: np.ndarray, floor_db: float, t_lo: float, t_hi: float,
              duration: float, speech_p=None,
              hop_s: float = RMS_HOP_S) -> tuple[float, str]:
    """Точка реза в зазоре [t_lo, t_hi] — середина самой длинной тишины.

    Возвращает (время, вид): 'silence' — нашли настоящую тишину, 'gap' — тишины
    нет, взяли самое тихое место, 'fallback' — зазора нет вовсе.
    """
    lo = max(0.0, min(t_lo, t_hi) - SEAM_PAD_S)
    hi = min(duration, max(t_lo, t_hi) + SEAM_PAD_S)
    mid = round((t_lo + t_hi) / 2, 3)
    if hi <= lo or len(db) == 0:
        return max(0.0, min(duration, mid)), 'fallback'

    i0 = max(0, int(lo / hop_s))
    i1 = min(len(db), int(np.ceil(hi / hop_s)))
    if i1 - i0 < 2:
        return max(0.0, min(duration, mid)), 'fallback'

    window = db[i0:i1]
    quiet = window < silence_threshold_db(floor_db)
    if speech_p is not None and len(speech_p):
        # кадр VAD грубее (32 мс), поэтому его решение просто накладывается
        times = (np.arange(i0, i1) + 0.5) * hop_s
        vi = np.clip((times / VAD_HOP_S).astype(int), 0, len(speech_p) - 1)
        quiet = quiet & (np.asarray(speech_p)[vi] < VAD_SPEECH_P)

    a, b = _longest_run(quiet)
    if a >= 0:
        t = ((i0 + a) + (i0 + b)) / 2 * hop_s
        return round(max(0.0, min(duration, t)), 3), 'silence'

    # тишины нет: предложения слиты. Тогда самое тихое место — меньшее из зол,
    # и шов помечается, чтобы кроссфейд взяли короче
    k = int(np.argmin(window))
    t = (i0 + k + 0.5) * hop_s
    return round(max(0.0, min(duration, t)), 3), 'gap'


class PhraseFinder:
    """Считает фразу к перегенерации по дефекту.

    Вход — только числа: номера предложений по словам сценария, времена
    выровненных слов, звук и вероятности речи. Никакого ttsqc, чтобы это можно
    было проверить синтетикой.
    """

    def __init__(self, sents: list[int], word_times: dict, duration: float,
                 audio=None, sr: int = 16000, speech_p=None, edge_words: int = 1):
        self.sents = list(sents)
        self.word_times = dict(word_times)
        self.duration = float(duration)
        self.speech_p = speech_p
        self.edge_words = int(edge_words)
        self.db, self.floor_db = (rms_profile(audio, sr) if audio is not None
                                  else (np.zeros(0), SILENCE_FLOOR_DB))

        # предложение → [первое слово, последнее+1)
        self.sent_words: dict = {}
        for i, s in enumerate(self.sents):
            r = self.sent_words.get(s)
            if r is None:
                self.sent_words[s] = [i, i + 1]
            else:
                r[1] = i + 1

        # предложение → (t0, t1); только те, у которых есть выровненные слова —
        # у остальных времени нет, и шагать на них нельзя
        self.sent_times: dict = {}
        for i, s in enumerate(self.sents):
            t = self.word_times.get(i)
            if t is None:
                continue
            cur = self.sent_times.get(s)
            self.sent_times[s] = ((min(cur[0], t[0]), max(cur[1], t[1])) if cur
                                  else (float(t[0]), float(t[1])))
        self.timed = sorted(self.sent_times)

    # -- шаги по предложениям, У КОТОРЫХ ЕСТЬ ВРЕМЯ -------------------------
    def _prev(self, sent: int):
        i = bisect.bisect_left(self.timed, sent)
        return self.timed[i - 1] if i > 0 else None

    def _next(self, sent: int):
        i = bisect.bisect_right(self.timed, sent)
        return self.timed[i] if i < len(self.timed) else None

    def _touched(self, lo: int, hi: int, a0: float, a1: float) -> list:
        n = len(self.sents)
        if hi > lo:
            idxs = [i for i in range(lo, hi) if 0 <= i < n]
        else:
            # вставка: своих слов нет, она стоит МЕЖДУ lo-1 и lo. Если это стык
            # предложений, оба сразу и попадут — ровно то, что нужно.
            idxs = [i for i in (lo - 1, lo) if 0 <= i < n]
        sents = sorted({self.sents[i] for i in idxs})
        if sents:
            return sents
        if not self.timed:
            return []
        mid = (a0 + a1) / 2
        return [min(self.timed,
                    key=lambda s: abs((self.sent_times[s][0] + self.sent_times[s][1]) / 2 - mid))]

    def phrase(self, words, audio_span) -> dict:
        lo, hi = int(words[0]), int(words[1])
        a0, a1 = float(audio_span[0]), float(audio_span[1])
        touched = self._touched(lo, hi, a0, a1)
        if not touched:
            return {'t0': 0.0, 't1': round(self.duration, 3), 'sentFrom': -1, 'sentTo': -1,
                    'wordFrom': -1, 'wordTo': -1, 'cut': ['fileStart', 'fileEnd']}

        first, last = touched[0], touched[-1]
        # «в одном слове от границы» — по ИНДЕКСАМ, а не по секундам: индекс не
        # дрожит вместе с выравниванием, в отличие от порога в 0.6 с у ttsqc
        fw = self.sent_words.get(first, [lo, max(hi, lo + 1)])
        lw = self.sent_words.get(last, [lo, max(hi, lo + 1)])
        start_ref = lo if hi > lo else lo - 1
        end_ref = hi if hi > lo else lo
        if start_ref - fw[0] <= self.edge_words:
            p = self._prev(first)
            if p is not None:
                first = p
        if lw[1] - end_ref <= self.edge_words:
            nx = self._next(last)
            if nx is not None:
                last = nx

        prev_s, next_s = self._prev(first), self._next(last)
        fb, lb = self.sent_times.get(first), self.sent_times.get(last)

        if prev_s is None or fb is None:
            t0, k0 = 0.0, 'fileStart'
        else:
            t0, k0 = cut_point(self.db, self.floor_db, self.sent_times[prev_s][1], fb[0],
                               self.duration, self.speech_p)
        if next_s is None or lb is None:
            t1, k1 = self.duration, 'fileEnd'
        else:
            t1, k1 = cut_point(self.db, self.floor_db, lb[1], self.sent_times[next_s][0],
                               self.duration, self.speech_p)
        cuts = [k0, k1]

        # Инвариант, на котором стоит вся перегенерация: звук дефекта целиком
        # внутри фразы. Если выравнивание подвело — расширяем, а не спорим.
        t0, t1 = min(t0, a0), max(t1, a1)
        if t1 <= t0:
            t0, t1 = max(0.0, min(a0, t0)), min(self.duration, max(a1, t1))
            cuts = ['fallback', 'fallback']

        fw2 = self.sent_words.get(first, [lo, hi])
        lw2 = self.sent_words.get(last, [lo, hi])
        return {'t0': round(max(0.0, t0), 3), 't1': round(min(self.duration, t1), 3),
                'sentFrom': first, 'sentTo': last,
                'wordFrom': fw2[0], 'wordTo': lw2[1], 'cut': cuts}
