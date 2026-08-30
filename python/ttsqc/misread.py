"""Сверка «произнесено ли то, что написано» через сравнение правдоподобий.

Правило плана «ASR-дифф никогда не выдаёт дефект» было верно по духу и
слишком абсолютно по букве. Верно оно потому, что WER Whisper на этом
материале 3–6%, и объявлять дефектом каждое его расхождение — значит утопить
выдачу. Слишком абсолютно потому, что расхождение — единственный дешёвый
источник кандидатов на искажение слова, а таких искажений на реальном файле
десятки.

Развязка: дифф **предлагает** кандидата, а CTC **выносит приговор**.
На один и тот же отрезок звука выравнивается и сценарная форма слова, и
услышанная, и сравнивается, какая садится лучше. Это прямой ответ на вопрос
«произнесено ли написанное», и он не зависит от того, прав ли был ASR:

* услышанная форма садится заметно лучше → диктор сказал не то, что написано;
* сценарная садится не хуже → ошибся распознаватель, дефекта нет.

Отдельно нужно различать, кто виноват. «цветокорекции» → «цветокоррекции» это
опечатка в сценарии, звук верен; «называемое» → «называемая» это ошибка
генерации. Различает морфология: если формы отличаются только окончанием, это
чтение, если серединой слова — чаще всего опечатка автора.
"""
from __future__ import annotations

import difflib

import numpy as np
import torch

from . import ctc
from .normalize import phonetic_key
from .schema import AsrWord, ScriptWord

NEAR_LO = 0.50          # ниже — это уже разные слова, а не искажение одного
NEAR_HI = 0.999
MIN_GAIN = 0.35         # насколько услышанная форма должна выиграть, в logp/символ


class Candidate:
    __slots__ = ("script_lo", "script_hi", "asr_lo", "asr_hi", "t0", "t1",
                 "want", "heard", "similarity", "kind")

    def __init__(self, script_lo, script_hi, asr_lo, asr_hi, t0, t1,
                 want, heard, similarity, kind):
        self.script_lo, self.script_hi = script_lo, script_hi
        self.asr_lo, self.asr_hi = asr_lo, asr_hi
        self.t0, self.t1 = t0, t1
        self.want, self.heard = want, heard
        self.similarity, self.kind = similarity, kind


def propose(script: list[ScriptWord], asr: list[AsrWord]) -> list[Candidate]:
    """Кандидаты из расхождений сценария и свободного ASR."""
    a = [w.match for w in script]
    b = [w.norm for w in asr]
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    out: list[Candidate] = []
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal" or j2 <= j1:
            continue
        t0 = asr[j1].start
        t1 = asr[j2 - 1].end
        want = " ".join(a[i1:i2])
        heard = " ".join(b[j1:j2])
        if tag == "replace":
            sim = difflib.SequenceMatcher(
                None, phonetic_key(want), phonetic_key(heard)).ratio()
            if not (NEAR_LO <= sim <= NEAR_HI):
                continue
            kind = "misread"
        else:                       # insert: звук есть, текста нет
            sim = 0.0
            kind = "extra"
        out.append(Candidate(i1, i2, j1, j2, t0, t1, want, heard, sim, kind))
    return out


def _fit(backend, char2id: dict[str, int], audio: np.ndarray, device: str,
         text: str) -> float:
    """Средний по символам пик апостериорной вероятности при насильном
    выравнивании `text` на этот отрезок. Больше — лучше сидит."""
    letters = [c for c in text.replace(" ", "") if c in char2id]
    if not letters or audio.size < 640:
        return float("-inf")
    em = backend.emissions(np.ascontiguousarray(audio))
    toks, owner = ctc.build_tokens([text], char2id, em.shape[1] - 1,
                                   False, False, False, backend.space)
    if not toks:
        return float("-inf")
    path, logp = ctc.forced_align(em, toks, backend.blank)
    peaks: dict[int, float] = {}
    for t, k in enumerate(path):
        k = int(k)
        if k >= 0:
            peaks[k] = max(peaks.get(k, -1e30), float(logp[t]))
    return float(np.mean(list(peaks.values()))) if peaks else float("-inf")


def _blame(want: str, heard: str) -> str:
    """Опечатка в сценарии или ошибка чтения.

    Формы, различающиеся только хвостом, — это выбор окончания, то есть чтение.
    Различие в середине слова («цветокорекции» / «цветокоррекции») почти всегда
    означает, что автор написал слово не так, а диктор прочёл нормально.
    """
    w, h = want.replace(" ", ""), heard.replace(" ", "")
    n = min(len(w), len(h))
    common = 0
    while common < n and w[common] == h[common]:
        common += 1
    tail = max(len(w), len(h)) - common
    return "чтение" if common >= max(3, int(0.7 * n)) and tail <= 3 else "сценарий"


def adjudicate(backend, char2id: dict[str, int], audio: np.ndarray, sr: int,
               device: str, cands: list[Candidate],
               align_forms: dict[int, str], pad: float = 0.12
               ) -> list[dict]:
    """Приговор по каждому кандидату сравнением правдоподобий."""
    out: list[dict] = []
    for c in cands:
        i0 = max(int((c.t0 - pad) * sr), 0)
        i1 = min(int((c.t1 + pad) * sr), len(audio))
        seg = audio[i0:i1]
        if seg.size < 640:
            continue

        want_cyr = " ".join(align_forms.get(i, "") for i in
                            range(c.script_lo, c.script_hi)).strip()
        if c.kind == "misread" and not want_cyr:
            continue                    # нечем озвучить — судить не о чем

        heard_fit = _fit(backend, char2id, seg, device, c.heard)
        want_fit = (_fit(backend, char2id, seg, device, want_cyr)
                    if want_cyr else float("-inf"))
        gain = heard_fit - want_fit
        if not np.isfinite(gain) or gain < MIN_GAIN:
            continue                    # написанное садится не хуже — ASR ошибся

        out.append({
            "kind": c.kind,
            "script_lo": c.script_lo, "script_hi": c.script_hi,
            "t0": c.t0, "t1": c.t1,
            "want": c.want, "heard": c.heard,
            "similarity": round(c.similarity, 2),
            "gain": round(float(gain), 2),
            "blame": _blame(c.want, c.heard) if c.kind == "misread" else "чтение",
        })
    return out
