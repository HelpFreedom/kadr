"""S6 — акустические аномалии, специфичные для нейронного TTS.

Здесь пока два детектора из шести — те, которые план требует строить рано,
потому что отдача на строку кода у них наибольшая.

Общая оговорка, обесценивающая любые пороги из литературы: вход — mp3 44.1 кГц,
у которого кодек режет верх и даёт пре-эхо. Поэтому всё, что здесь считается,
сравнивается с распределением этого же файла (или корпуса с той же кодековой
обработкой), а не с абсолютными значениями.
"""
from __future__ import annotations

import numpy as np

from .schema import CharAlign

SR = 16000
HOP = 160          # 10 мс
WIN = 400          # 25 мс
N_MELS = 40


def _mel_filters(n_fft: int, n_mels: int = N_MELS, sr: int = SR) -> np.ndarray:
    def hz2mel(f): return 2595.0 * np.log10(1.0 + f / 700.0)
    def mel2hz(m): return 700.0 * (10 ** (m / 2595.0) - 1.0)
    lo, hi = hz2mel(50.0), hz2mel(sr / 2)
    pts = mel2hz(np.linspace(lo, hi, n_mels + 2))
    bins = np.floor((n_fft + 1) * pts / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1))
    for m in range(n_mels):
        l, c, r = bins[m], bins[m + 1], bins[m + 2]
        if c == l:
            c = l + 1
        if r == c:
            r = c + 1
        if r >= fb.shape[1]:
            break
        fb[m, l:c] = np.linspace(0, 1, c - l, endpoint=False)
        fb[m, c:r] = np.linspace(1, 0, r - c, endpoint=False)
    return fb


def logmel(audio: np.ndarray) -> np.ndarray:
    """Лог-мел спектрограмма [T, 40] с шагом 10 мс."""
    n = max((len(audio) - WIN) // HOP + 1, 1)
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    idx = np.clip(idx, 0, len(audio) - 1)
    frames = audio[idx] * np.hanning(WIN)
    spec = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    fb = _mel_filters(WIN)
    return np.log(spec @ fb.T + 1e-10)


def loop_runs(mel: np.ndarray, min_lag: int = 5, max_lag: int = 100,
              ncc_thr: float = 0.97, min_frames: int = 20) -> list[tuple[float, float, int, float]]:
    """Детектор зацикливания генерации.

    Единственный детектор, который берёт «самовааар-варр-варр»: такие заикания
    CTC охотно впитывает в целевое слово почти без потери уверенности, потому
    что повторённый слог — это те же ожидаемые фонемы, просто ещё раз.

    Ищем устойчивую нормированную кросс-корреляцию мел-вектора с самим собой на
    фиксированном лаге. Возвращает (t0, t1, лаг, средний NCC).
    """
    T = mel.shape[0]
    if T <= max_lag + min_frames:
        return []
    x = mel - mel.mean(axis=1, keepdims=True)
    norm = np.linalg.norm(x, axis=1) + 1e-9

    out: list[tuple[float, float, int, float]] = []
    claimed = np.zeros(T, dtype=bool)
    for lag in range(min_lag, min(max_lag, T - 1) + 1):
        ncc = np.sum(x[lag:] * x[:-lag], axis=1) / (norm[lag:] * norm[:-lag])
        hot = ncc > ncc_thr
        i = 0
        while i < hot.size:
            if not hot[i]:
                i += 1
                continue
            j = i
            while j < hot.size and hot[j]:
                j += 1
            if j - i >= min_frames and not claimed[i + lag:j + lag].any():
                claimed[i + lag:j + lag] = True
                out.append(((i + lag) * HOP / SR, (j + lag) * HOP / SR,
                            lag, float(ncc[i:j].mean())))
            i = j
    return sorted(out)


def intraword_silence(audio: np.ndarray, chars: list[CharAlign],
                      min_gap: float = 0.060, stop_gap: float = 0.120,
                      floor_db: float = -45.0) -> list[tuple[int, float, float]]:
    """Неестественная пауза внутри слова.

    Порог поднимается после смычных: их смыкание законно длится 40–80 мс, и без
    этой оговорки детектор срабатывал бы на каждом «т» и «к».
    """
    stops = set("птк бдг цч".replace(" ", ""))
    out: list[tuple[int, float, float]] = []
    for a, b in zip(chars, chars[1:]):
        if a.script_word != b.script_word:
            continue
        gap = b.t0 - a.t1
        thr = stop_gap if a.char in stops else min_gap
        if gap < thr:
            continue
        seg = audio[int(a.t1 * SR):int(b.t0 * SR)]
        if seg.size < 16:
            continue
        db = 20 * np.log10(np.sqrt(np.mean(seg ** 2)) + 1e-10)
        if db < floor_db:
            out.append((a.script_word, a.t1, b.t0))
    return out
