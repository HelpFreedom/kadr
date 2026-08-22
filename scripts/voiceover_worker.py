#!/usr/bin/env python3
"""Warm local F5-TTS worker for Kadr's private voice-over studio."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
import unicodedata
import wave
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
from f5_tts.api import F5TTS


def emit(payload: dict) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def trim_to_speech(audio: np.ndarray, sample_rate: int) -> np.ndarray:
    mono = np.asarray(audio, dtype=np.float32).reshape(-1)
    frame = max(1, int(sample_rate * 0.05))
    hop = max(1, int(sample_rate * 0.01))
    if len(mono) < frame:
        raise ValueError("Аудио короче одного анализируемого кадра")
    rms = np.array([
        np.sqrt(np.mean(mono[pos:pos + frame] ** 2) + 1e-12)
        for pos in range(0, len(mono) - frame + 1, hop)
    ])
    active = np.flatnonzero(rms >= 0.002)
    if active.size == 0:
        raise ValueError("Модель вернула только тишину")
    start = max(0, int(active[0] * hop) - int(sample_rate * 0.10))
    end = min(len(mono), int(active[-1] * hop + frame) + int(sample_rate * 0.16))
    trimmed = mono[start:end].copy()
    fade = min(int(sample_rate * 0.012), len(trimmed) // 4)
    if fade > 1:
        trimmed[:fade] *= np.linspace(0.0, 1.0, fade, dtype=np.float32)
        trimmed[-fade:] *= np.linspace(1.0, 0.0, fade, dtype=np.float32)
    return trimmed


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as source:
        return source.getnframes() / source.getframerate()


def f5_stress_marks(text: str) -> str:
    """Convert UI-friendly combining accents (молоко́) to F5 Russian + notation."""
    normalized = unicodedata.normalize("NFD", text)
    vowels = "АЕЁИОУЫЭЮЯаеёиоуыэюя"
    for vowel in vowels:
        normalized = normalized.replace(f"{vowel}\N{COMBINING ACUTE ACCENT}", f"+{vowel}")
    return unicodedata.normalize("NFC", normalized)


def f5_spoken_text(text: str) -> str:
    """Expand symbols the Russian F5 vocabulary cannot pronounce reliably.

    In particular, an ampersand at the start of generated speech can make F5
    continue the final words of the reference and skip the first requested
    phrase. Keep the editor text untouched and normalize only the model input.
    """
    expanded = re.sub(r"[ \t]*&[ \t]*", " и ", text)
    expanded = re.sub(r"[ \t]+", " ", expanded)
    return f5_stress_marks(expanded.strip())


def worker_log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def generate(model: F5TTS, request: dict) -> None:
    job_id = str(request["id"])
    text = str(request["text"]).strip()
    output = Path(request["outputPath"])
    settings = request["settings"]
    voice = request["voice"]
    reference = Path(str(voice["referencePath"]))
    if not text:
        raise ValueError("Пустой текст")
    if not reference.is_file():
        raise ValueError(f"Не найден голосовой референс: {reference}")
    output.parent.mkdir(parents=True, exist_ok=True)
    emit({"type": "progress", "id": job_id, "stage": "generating", "progress": 0.22})

    used_seed = int(settings.get("seed", 20260816))
    with tempfile.TemporaryDirectory(prefix="kadr-voice-") as temp_dir:
        raw = Path(temp_dir) / "raw.wav"
        trimmed = Path(temp_dir) / "trimmed.wav"
        mastered = Path(temp_dir) / "master.wav"
        model.infer(
            ref_file=str(reference),
            ref_text=str(voice["referenceText"]),
            gen_text=f5_spoken_text(text),
            show_info=worker_log,
            progress=None,
            target_rms=0.1,
            cross_fade_duration=float(settings.get("crossFadeDuration", 0.12)),
            sway_sampling_coef=float(settings.get("swaySamplingCoef", -1)),
            cfg_strength=float(settings.get("cfgStrength", 2)),
            nfe_step=int(settings.get("nfeStep", 24)),
            speed=float(settings.get("speed", 1)),
            remove_silence=False,
            file_wave=str(raw),
            seed=used_seed,
        )
        audio, sample_rate = sf.read(raw, dtype="float32", always_2d=False)
        if np.asarray(audio).ndim > 1:
            audio = np.mean(audio, axis=1)
        segment = trim_to_speech(np.asarray(audio), int(sample_rate))
        duration = len(segment) / int(sample_rate)
        minimum = max(0.35, len(text) / 42.0)
        maximum = max(8.0, len(text) / 4.0)
        if not minimum <= duration <= maximum:
            raise ValueError(f"Неправдоподобная длительность {duration:.2f} с")
        sf.write(trimmed, segment, int(sample_rate), subtype="PCM_16")
        emit({"type": "progress", "id": job_id, "stage": "mastering", "progress": 0.82})
        subprocess.run([
            os.environ.get("KADR_FFMPEG", "ffmpeg"), "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(trimmed),
            "-af", (
                "highpass=f=70,"
                f"loudnorm=I={float(settings.get('loudnessLufs', -16))}:"
                f"TP={float(settings.get('truePeakDb', -1.5))}:LRA=7"
            ),
            "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(mastered)
        ], check=True)
        pending = output.with_suffix(".part.wav")
        pending.write_bytes(mastered.read_bytes())
        pending.replace(output)

    emit({
        "type": "done",
        "id": job_id,
        "path": str(output),
        "duration": round(wav_duration(output), 3),
        "seed": used_seed,
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--vocab", required=True)
    args = parser.parse_args()
    if torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    else:
        device = "cpu"
    model = F5TTS(
        model="F5TTS_v1_Base",
        ckpt_file=args.model,
        vocab_file=args.vocab,
        device=device,
    )
    emit({"type": "ready"})
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        try:
            generate(model, request)
        except Exception as exc:
            emit({"type": "error", "id": str(request.get("id", "")), "message": str(exc)})


if __name__ == "__main__":
    main()
