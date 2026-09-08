"""Посимвольное CTC-выравнивание со star-токеном.

Почему свой Viterbi, а не готовые:

* `whisperx.align()` не подходит — режет по своим сегментам, пересобирает
  результат через NLTK и pandas, а главное выбрасывает матрицу эмиссий, из
  которой только и можно получить честную уверенность (см. Ф1: его
  пословный `score` усредняется по blank-кадрам и уверенностью не является).
* `torchaudio.functional.forced_align` помечен DEPRECATED и удаляется в 2.9,
  не умеет star-токен и не отдаёт полное соответствие кадр→токен.

Два прохода по одной матрице эмиссий — forward дорогой, DP микросекунды:

  Проход A — star только на краях зоны. Всё внутри обязано объясняться
  сценарием, поэтому проход ничего не может спрятать: это источник честных
  апостериорных вероятностей и длительностей.

  Проход B — star между каждой парой слов. Лишнему аудио есть куда деться,
  настоящие слова сохраняют точные границы, а занятость star в кадрах —
  прямое измерение вставки.
"""
from __future__ import annotations

import gc

import numpy as np
import torch

NEG = -1e30


class Wav2Vec2Backend:
    """`jonatasgrosman/wav2vec2-large-xlsr-53-russian` через whisperx."""

    name = "wav2vec2"

    def __init__(self, device: str = "cuda", lang: str = "ru"):
        from whisperx.alignment import load_align_model
        self.device = device
        self.model, meta = load_align_model(language_code=lang, device=device)
        self.char2id = meta["dictionary"]
        self.id2char = {v: k for k, v in self.char2id.items()}
        self.blank = 0
        self.space = self.char2id.get("|", self.char2id.get(" ", -1))

    def emissions(self, audio: np.ndarray) -> torch.Tensor:
        with torch.inference_mode():
            # preprocessor_config.json модели: do_normalize=true. whisperx этот
            # шаг пропускает; на чистой речи разница мала, на тихих участках нет.
            a = (audio - audio.mean()) / (audio.std() + 1e-7)
            x = torch.from_numpy(np.ascontiguousarray(a)).to(self.device).unsqueeze(0)
            out = self.model(x)
            logits = out.logits if hasattr(out, "logits") else out
            return torch.log_softmax(logits[0].float(), dim=-1).cpu()

    def release(self) -> None:
        release(self.model)


class GigaAMBackend:
    """GigaAM v3 CTC (Sber, декабрь 2025) — русский, посимвольный, ONNX на CPU.

    Заменён wav2vec2 2021 года по измеренной причине: канал искажений внутри
    слова давал 13% точности, и все ложные были вида «консоли» → «концоле», то
    есть ошибками разбора букв, а не речи. У этой модели тот же посимвольный
    интерфейс, но жадный декод выдаёт связный текст.

    Цена — вдвое более грубая сетка: кадр 40 мс против 20 мс.
    """

    name = "gigaam"

    def __init__(self, device: str = "cpu", lang: str = "ru"):
        from .gigaam import Aligner
        self._a = Aligner()
        self.char2id = self._a.char2id
        self.id2char = self._a.id2char
        self.blank = self._a.blank
        self.space = self.char2id.get(" ", -1)

    def emissions(self, audio: np.ndarray) -> torch.Tensor:
        return torch.from_numpy(self._a.emissions(np.ascontiguousarray(audio)))

    def release(self) -> None:
        self._a = None
        gc.collect()


def load_aligner(device: str = "cuda", lang: str = "ru", backend: str = "wav2vec2"):
    """Акустическая модель за единым интерфейсом."""
    if backend == "gigaam":
        return GigaAMBackend(device, lang)
    return Wav2Vec2Backend(device, lang)


def release(model) -> None:
    """6 ГБ VRAM: ASR и выравниватель не должны жить одновременно."""
    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def emissions(model, audio: np.ndarray, device: str) -> torch.Tensor:
    """Аудио зоны → лог-апостериорные вероятности [T, V], на CPU."""
    with torch.inference_mode():
        # preprocessor_config.json модели: do_normalize=true. whisperx этот шаг
        # пропускает; на чистой речи разница мала, но на тихих участках нет.
        a = (audio - audio.mean()) / (audio.std() + 1e-7)
        x = torch.from_numpy(np.ascontiguousarray(a)).to(device).unsqueeze(0)
        out = model(x)
        logits = out.logits if hasattr(out, "logits") else out
        return torch.log_softmax(logits[0].float(), dim=-1).cpu()


def with_star(emission: torch.Tensor, log_p_star: float,
              blank: int = 0) -> torch.Tensor:
    """Дописать колонку star: лучший не-blank класс со штрафом.

    Перенормировать не нужно — forced alignment это argmax по путям, важны
    только относительные величины. Индекс blank зависит от модели: у wav2vec2
    он нулевой, у GigaAM последний.
    """
    mask = torch.ones(emission.shape[1], dtype=torch.bool)
    mask[blank] = False
    non_blank = emission[:, mask].max(dim=-1).values
    star = (non_blank + log_p_star).unsqueeze(1)
    return torch.cat([emission, star], dim=1)


def build_tokens(words: list[str], char2id: dict[str, int], star_id: int,
                 star_between: bool, star_left: bool, star_right: bool,
                 space_id: int | None = None
                 ) -> tuple[list[int], list[tuple[int, int, str]]]:
    """Слова зоны → последовательность токенов и владелец каждого токена.

    Владелец — тройка (индекс слова в зоне, индекс символа в слове, сам
    символ); для star и пробелов индекс слова равен -1.
    """
    tokens: list[int] = []
    owner: list[tuple[int, int, str]] = []
    space = char2id.get("|", char2id.get(" ", -1)) if space_id is None else space_id

    def push(tok: int, own: tuple[int, int, str]) -> None:
        tokens.append(tok)
        owner.append(own)

    none = (-1, -1, "")
    if star_left:
        push(star_id, none)
    for wi, w in enumerate(words):
        if wi and space >= 0:
            push(space, none)
        if not w:                       # озвучить нечем — закрываем star
            push(star_id, none)
            continue
        for ci, ch in enumerate(w):
            tid = char2id.get(ch)
            if tid is not None:
                push(tid, (wi, ci, ch))
        if star_between and wi < len(words) - 1:
            push(star_id, none)
    if star_right:
        push(star_id, none)
    return tokens, owner


def forced_align(emission: torch.Tensor, tokens: list[int], blank: int = 0
                 ) -> tuple[np.ndarray, np.ndarray]:
    """Классический CTC forced alignment по решётке с проложенными blank.

    Возвращает (path, frame_logp): для каждого кадра — индекс токена цели
    (или -1, если кадр отдан blank) и логарифм вероятности выбранного класса.
    """
    T = emission.shape[0]
    n = len(tokens)
    if n == 0 or T == 0:
        return np.full(T, -1, dtype=np.int32), np.zeros(T, dtype=np.float32)

    # Цель с проложенными blank: [b, y0, b, y1, ..., y_{n-1}, b], длина 2n+1.
    S = 2 * n + 1
    y = np.full(S, blank, dtype=np.int64)
    y[1::2] = tokens
    y_t = torch.from_numpy(y)

    em = emission
    # skip[s] — можно ли прыгнуть через blank в позицию s (обычное правило CTC:
    # нельзя, если это blank или если два одинаковых токена подряд).
    skip = np.zeros(S, dtype=bool)
    skip[3::2] = np.array(tokens[1:]) != np.array(tokens[:-1])
    skip_t = torch.from_numpy(skip)

    alpha = torch.full((S,), NEG, dtype=torch.float32)
    alpha[0] = em[0, y[0]]
    if S > 1:
        alpha[1] = em[0, y[1]]
    back = torch.zeros((T, S), dtype=torch.int8)

    for t in range(1, T):
        stay = alpha
        prev = torch.cat([torch.full((1,), NEG), alpha[:-1]])
        jump = torch.cat([torch.full((2,), NEG), alpha[:-2]])
        jump = torch.where(skip_t, jump, torch.full_like(jump, NEG))
        stacked = torch.stack([stay, prev, jump])
        best, arg = stacked.max(dim=0)
        alpha = best + em[t, y_t]
        back[t] = arg.to(torch.int8)

    # Разбор: путь обязан закончиться на последнем токене или на blank за ним.
    s = S - 1 if alpha[S - 1] >= alpha[S - 2] else S - 2
    path = np.full(T, -1, dtype=np.int32)
    frame_logp = np.zeros(T, dtype=np.float32)
    for t in range(T - 1, -1, -1):
        path[t] = (s - 1) // 2 if s % 2 == 1 else -1
        frame_logp[t] = float(em[t, y[s]])
        if t:
            s -= int(back[t, s])
    return path, frame_logp


def greedy_decode(emission: torch.Tensor, blank: int = 0
                  ) -> list[tuple[int, int, int, float]]:
    """Что модель слышит на самом деле: (токен, кадр_начала, кадр_конца, logp).

    Свободное декодирование той же матрицы эмиссий, по которой шло насильное
    выравнивание. Это даёт сравнение «яблоки с яблоками»: одна модель, одна
    матрица, одна сетка кадров — в отличие от диффа со свободным Whisper, где
    к расхождению примешивается его собственный WER.

    Нужно оно ради самого частого дефекта: абракадабры произвольной длины,
    вплоть до одной буквы. Такой звук слишком короток, чтобы надёжно попасть в
    непокрытую речь по VAD, но модель его слышит и честно выдаёт лишние
    символы, которых в сценарии нет.
    """
    best = emission.argmax(dim=-1)
    logp = emission.max(dim=-1).values
    out: list[tuple[int, int, int, float]] = []
    prev = -1
    start = 0
    for t in range(len(best)):
        tok = int(best[t])
        if tok == prev:
            continue
        if prev not in (-1, blank):
            out.append((prev, start, t, float(logp[start:t].max())))
        prev, start = tok, t
    if prev not in (-1, blank):
        out.append((prev, start, len(best), float(logp[start:].max())))
    return out
