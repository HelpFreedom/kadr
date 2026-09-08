"""Декодирование аудио и кэш.

Один декод в 16 кГц для моделей плюс отдельный поток 32 кГц для ВЧ-мер S6.
Причина раздельных потоков: вход — mp3 44.1 кГц, у которого кодек режет верх и
даёт пре-эхо, поэтому все ВЧ-меры имеют смысл только как z-скоры относительно
корпуса с той же кодековой обработкой, и считать их по 16 кГц нельзя.
"""
from __future__ import annotations

import hashlib
import subprocess
from pathlib import Path

import numpy as np

from .paths import CACHE


def _key(path: Path, sr: int) -> Path:
    st = path.stat()
    h = hashlib.sha1(f"{path}|{st.st_mtime_ns}|{st.st_size}|{sr}".encode()).hexdigest()[:16]
    return CACHE / f"{h}.npy"


def decode(path: str | Path, sr: int = 16000, use_cache: bool = True) -> np.ndarray:
    """Файл → mono float32 на заданной частоте."""
    path = Path(path)
    cached = _key(path, sr)
    if use_cache and cached.exists():
        return np.load(cached)
    cmd = ["ffmpeg", "-nostdin", "-threads", "0", "-i", str(path),
           "-f", "f32le", "-ac", "1", "-ar", str(sr), "-acodec", "pcm_f32le", "-"]
    proc = subprocess.run(cmd, capture_output=True, check=True)
    audio = np.frombuffer(proc.stdout, dtype=np.float32).copy()
    if use_cache:
        CACHE.mkdir(parents=True, exist_ok=True)
        np.save(cached, audio)
    return audio


def duration(path: str | Path) -> float:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", str(path)],
        capture_output=True, text=True, check=True)
    return float(out.stdout.strip())
