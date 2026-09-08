"""Свободное распознавание — намеренно без привязки к сценарию.

Именно поэтому этот проход устойчив к вставкам: он ничего не предполагает о
тексте, и полторы секунды абракадабры не заставляют его растягивать соседние
слова. Привязка к сценарию появляется только на следующей стадии, и уже в
виде якорей.
"""
from __future__ import annotations

import gc

import numpy as np
import torch

from .normalize import normalize_asr
from .schema import AsrWord


def transcribe(audio: np.ndarray, cfg: dict) -> tuple[list[AsrWord], list[tuple[float, float]]]:
    """Аудио 16 кГц → слова с таймкодами и речевые интервалы VAD."""
    from faster_whisper import WhisperModel

    model = WhisperModel(cfg["model"], device=cfg["device"],
                         compute_type=cfg["compute_type"])
    segments, _info = model.transcribe(
        audio,
        language=cfg["language"],
        beam_size=cfg["beam_size"],
        temperature=0.0,              # без fallback-декода = без пути к галлюцинациям
        condition_on_previous_text=False,  # иначе языковая модель «причёсывает» запинки
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=300, speech_pad_ms=100),
    )
    raw: list[tuple[str, float, float, float]] = []
    speech: list[tuple[float, float]] = []
    for seg in segments:
        speech.append((seg.start, seg.end))
        for w in seg.words or []:
            raw.append((w.word, float(w.start), float(w.end), float(w.probability)))

    del model
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()
    return normalize_asr(raw), speech


def speech_probs(audio: np.ndarray) -> np.ndarray:
    """Покадровые вероятности речи Silero (одна на 512 сэмплов = 32 мс).

    Модель лежит внутри faster-whisper (assets/silero_vad_v6.onnx), качать
    ничего не нужно и сеть не требуется.
    """
    from faster_whisper.vad import get_vad_model
    model = get_vad_model()
    chunk = 512
    n = (len(audio) // chunk) * chunk
    if n == 0:
        return np.zeros(0, dtype=np.float32)
    probs = model(np.ascontiguousarray(audio[:n], dtype=np.float32))
    return np.ravel(np.asarray(probs, dtype=np.float32))
