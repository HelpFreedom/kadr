"""S3 — озвученная речь, не покрытая выравниванием.

Прямое измерение вставки: если в аудио есть звук, которому не соответствует ни
один символ сценария, значит произнесено что-то лишнее.

Star-токен эту роль в одиночку не тянет, и это видно на данных: в тишине blank
достаётся даром и законно выигрывает у star, поэтому 13-секундная пауза
остаётся непокрытой без единого срабатывания star, а на стыках слов star
наоборот нащипывает по кадру на коартикуляции. Star полезен как подтверждение,
но решение принимает покрытие плюс вокализованность.

Четыре фильтра, и нужны все четыре: длительность, отделение речи от дыхания,
счёт слоговых ядер и подтверждение со стороны star.
"""
from __future__ import annotations

import numpy as np

from .schema import CharAlign, StarSpan

VAD_HOP = 512 / 16000.0     # 32 мс, сетка Silero


def unalignable_windows(script, chars: list[CharAlign],
                        duration: float) -> list[tuple[float, float]]:
    """Временны́е окна слов, которые нечем озвучить (латиница вне словаря).

    Star-токен эту работу не делает, и это измерено: даже когда star дешевле
    лучшего класса, он берёт 8% кадров, а 60% достаётся blank. Причина в самой
    природе CTC — модель пиковая, и звук, который она не узнаёт, читается ею
    как blank, а не как «что-то не то». Конкурировать с blank star не может.

    Поэтому окно вычисляется прямо: от конца предыдущего выровненного слова до
    начала следующего. Внутри законно звучит то, чего мы не умеем записать
    кириллицей, и вставкой это не является.
    """
    placed: dict[int, tuple[float, float]] = {}
    for c in chars:
        if not c.occupancy:
            continue
        lo, hi = placed.get(c.script_word, (c.t0, c.t1))
        placed[c.script_word] = (min(lo, c.t0), max(hi, c.t1))

    out: list[tuple[float, float]] = []
    for w in script:
        if w.align_form or w.idx in placed:
            continue
        left = [placed[i][1] for i in range(w.idx - 1, -1, -1) if i in placed]
        right = [placed[i][0] for i in range(w.idx + 1, len(script)) if i in placed]
        t0 = left[0] if left else 0.0
        t1 = right[0] if right else duration
        if t1 > t0:
            out.append((t0, t1))

    # Запас по краям: сосед такого слова выравнивается плохо, потому что его
    # границу тянет на неопознанный звук. Плюс слияние соседних окон — подряд
    # идущие «Adobe After Effects» это одно окно, а не три.
    if not out:
        return out
    out.sort()
    merged = [list(out[0])]
    for a, b in out[1:]:
        if a - merged[-1][1] <= 0.30:
            merged[-1][1] = max(merged[-1][1], b)
        else:
            merged.append([a, b])
    return [(max(a - 0.40, 0.0), min(b + 0.40, duration)) for a, b in merged]


def uncovered_runs(speech_p: np.ndarray, chars: list[CharAlign],
                   duration: float, thr: float = 0.6,
                   min_run_s: float = 0.30,
                   legit_stars: list[StarSpan] | None = None,
                   legit_windows: list[tuple[float, float]] | None = None
                   ) -> list[tuple[float, float]]:
    """Прогоны речевых кадров, не покрытых ни одним выровненным символом.

    Покрытием считается и star прохода A. Там star стоит только на краях зоны
    и на словах, которые нечем озвучить (латиница вне словаря), — и то и
    другое законно. Без этой оговорки каждое «Sony Vegas Pro» из сценария
    приезжает как вставка, то есть детектор флагает собственное незнание.
    """
    n = len(speech_p)
    covered = np.zeros(n, dtype=bool)

    def mark(t0: float, t1: float) -> None:
        i0 = max(int(t0 / VAD_HOP), 0)
        i1 = min(int(np.ceil(t1 / VAD_HOP)), n)
        if i1 > i0:
            covered[i0:i1] = True

    for c in chars:
        if c.occupancy:
            mark(c.t0, c.t1)
    for st in (legit_stars or ()):
        mark(st.t0, st.t1)
    for wt0, wt1 in (legit_windows or ()):
        mark(wt0, wt1)

    hot = (speech_p > thr) & ~covered
    out: list[tuple[float, float]] = []
    i = 0
    while i < n:
        if not hot[i]:
            i += 1
            continue
        j = i
        while j < n and hot[j]:
            j += 1
        if (j - i) * VAD_HOP >= min_run_s:
            out.append((i * VAD_HOP, min(j * VAD_HOP, duration)))
        i = j
    return out


def voicing_profile(audio: np.ndarray, t0: float, t1: float,
                    sr: int = 16000) -> dict[str, float]:
    """Отличить бормотание от дыхания и щелчка.

    Дыхание: шумное, спектрально плоское, тихое. Бормотание: с формантной
    структурой, периодичное, по громкости как обычная речь. Именно эта пара
    признаков разделяет `insert` и обычный вдох, и разделяет надёжно.
    """
    a = audio[int(t0 * sr):int(t1 * sr)]
    if a.size < 512:
        return {"rms": 0.0, "flatness": 1.0, "hnr": 0.0, "nuclei_rate": 0.0}

    rms = float(np.sqrt(np.mean(a ** 2)) + 1e-12)

    win = 512
    n = (a.size // win) * win
    frames = a[:n].reshape(-1, win) * np.hanning(win)
    spec = np.abs(np.fft.rfft(frames, axis=1)) + 1e-10
    gm = np.exp(np.mean(np.log(spec), axis=1))
    am = np.mean(spec, axis=1)
    flatness = float(np.mean(gm / am))

    # HNR через пик автокорреляции в речевом диапазоне F0 (80–400 Гц).
    x = a - a.mean()
    ac = np.correlate(x, x, mode="full")[x.size - 1:]
    ac /= (ac[0] + 1e-12)
    lo, hi = sr // 400, sr // 80
    peak = float(ac[lo:hi].max()) if hi < ac.size else 0.0
    peak = min(max(peak, 1e-6), 0.999)
    hnr = float(10.0 * np.log10(peak / (1.0 - peak)))

    # Слоговые ядра: огибающая полосы 300–1000 Гц, пики с проминентностью.
    band = spec[:, int(300 / (sr / 2) * spec.shape[1]):
                   int(1000 / (sr / 2) * spec.shape[1])]
    env = band.sum(axis=1)
    if env.size >= 3:
        env_db = 20 * np.log10(env + 1e-10)
        med = np.median(env_db)
        peaks = sum(1 for k in range(1, env.size - 1)
                    if env_db[k] > env_db[k - 1] and env_db[k] > env_db[k + 1]
                    and env_db[k] - med > 3.0)
        nuclei_rate = peaks / max(t1 - t0, 1e-3)
    else:
        nuclei_rate = 0.0

    return {"rms": rms, "flatness": flatness, "hnr": hnr,
            "nuclei_rate": float(nuclei_rate)}


def star_overlap(stars: list[StarSpan], t0: float, t1: float) -> float:
    return sum(max(0.0, min(t1, s.t1) - max(t0, s.t0)) for s in stars)


def classify_run(prof: dict[str, float], local_rms: float) -> tuple[str, float]:
    """Прогон → (тип, уверенность). Тип: speech | breath | click."""
    rel = prof["rms"] / (local_rms + 1e-12)
    if prof["nuclei_rate"] < 1.0 and rel < 0.35:
        return "click", 0.2
    if prof["flatness"] > 0.35 and prof["hnr"] < 3.0 and rel < 0.35:
        return "breath", 0.2
    score = 0.0
    score += 0.35 if prof["flatness"] < 0.30 else 0.0
    score += 0.30 if prof["hnr"] > 5.0 else 0.0
    score += 0.20 if rel > 0.35 else 0.0
    score += 0.15 if prof["nuclei_rate"] >= 2.0 else 0.0
    return ("speech", score) if score >= 0.5 else ("breath", score)


def classify_merged(prof: dict[str, float], local_rms: float, dur: float
                    ) -> tuple[str, float]:
    """То же, но с поправкой на длительность склеенного события.

    Вдох длиной больше полусекунды и на уровне обычной речи — это не вдох.
    Мера HNR здесь известна как ненадёжная (даёт отрицательные значения даже на
    явной речи), поэтому на длинных событиях решает громкость, а не она.
    """
    kind, score = classify_run(prof, local_rms)
    if kind != "speech" and dur >= 0.55 and prof["rms"] / (local_rms + 1e-12) > 0.5:
        return "speech", max(score, 0.55)
    return kind, score


def is_alignment_artifact(asr_words, script, word_scores, t0: float, t1: float,
                          near_word: int, radius: int = 8) -> bool:
    """Артефакт выравнивания или настоящая вставка.

    Различает их не наличие слов в сценарии, а их КРАТНОСТЬ.

    Непокрытый участок почти всегда содержит слова, которые в сценарии рядом
    написаны — просто выравниватель не сумел их туда положить (край зоны,
    латиница, редкое слово). Спрашивать «есть ли это слово в тексте» поэтому
    бесполезно: ответ почти всегда «да», и фильтр сносит заодно настоящие
    находки.

    А вот кратность разделяет чисто:

    * «Здесь же одно окошко» в сценарии, «Одно же одно окошко» в звуке —
      «одно» произнесено дважды, написано один раз. Настоящий повтор.
    * «не просто монтирую, а монтирую вдвоём» — в звуке «монтирую» дважды и
      в сценарии дважды. Автор так написал, дефекта нет.

    Служебные слова из подсчёта исключаются: они встречаются всюду.
    """
    from collections import Counter

    from .fusion import FUNCTION_WORDS

    heard = Counter(w.norm for w in asr_words
                    if w.end > t0 and w.start < t1
                    and w.norm not in FUNCTION_WORDS and len(w.norm) > 2)
    if not heard:
        return True                     # только служебные слова — судить не о чем

    lo = max(near_word - radius, 0)
    hi = min(near_word + radius, len(script))
    written = Counter(script[i].match for i in range(lo, hi)
                      if script[i].match not in FUNCTION_WORDS
                      and len(script[i].match) > 2)

    # Хоть одно слово звучит чаще, чем написано, — это лишний звук.
    return not any(n > written.get(w, 0) for w, n in heard.items())


def merge_runs(runs: list[tuple[float, float]], gap: float = 0.35
               ) -> list[tuple[float, float]]:
    """Слить соседние прогоны ДО классификации, а не после.

    Одно событие абракадабры почти всегда рвётся на куски: внутри неё есть
    микропаузы, и VAD честно их отмечает. По отдельности каждый кусок выглядит
    коротким и незначительным — в реальных данных событие на 31–34 секунде
    приезжало тремя обрывками по 0.3–0.7 с, и каждый в одиночку не тянул ни на
    длительность, ни на уверенную вокализацию. Склеенное же событие длиной в
    две секунды не спутать ни с вдохом, ни с коартикуляцией.
    """
    if not runs:
        return []
    out = [list(runs[0])]
    for a, b in sorted(runs)[1:]:
        if a - out[-1][1] <= gap:
            out[-1][1] = max(out[-1][1], b)
        else:
            out.append([a, b])
    return [(a, b) for a, b in out]
