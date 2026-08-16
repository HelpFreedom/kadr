#!/usr/bin/env python3
"""Warm local Qwen3-TTS worker for Kadr's private voice-over studio."""

from __future__ import annotations

import argparse
import json
import math
import os
import subprocess
import sys
import tempfile
import wave
from pathlib import Path

import mlx.core as mx
import numpy as np
from mlx_audio.audio_io import write as audio_write
from mlx_audio.tts.utils import load_model


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


def generate(model, request: dict) -> None:
    job_id = str(request["id"])
    text = str(request["text"]).strip()
    output = Path(request["outputPath"])
    settings = request["settings"]
    if not text:
        raise ValueError("Пустой текст")
    output.parent.mkdir(parents=True, exist_ok=True)
    emit({"type": "progress", "id": job_id, "stage": "generating", "progress": 0.22})

    accepted = None
    failures: list[str] = []
    base_seed = int(settings.get("seed", 20260816))
    for attempt in range(3):
        seed = base_seed + attempt
        mx.random.seed(seed)
        try:
            result = next(model.generate(
                text=text,
                instruct=str(settings["voicePrompt"]),
                lang_code=str(settings.get("language", "Russian")),
                temperature=float(settings.get("temperature", 0.45)),
                top_k=int(settings.get("topK", 30)),
                top_p=float(settings.get("topP", 0.82)),
                repetition_penalty=float(settings.get("repetitionPenalty", 1.08)),
                max_tokens=int(settings.get("maxTokens", 700)),
                verbose=False,
            ))
            segment = trim_to_speech(np.array(result.audio), int(model.sample_rate))
            duration = len(segment) / int(model.sample_rate)
            minimum = max(0.45, len(text) / 34.0)
            maximum = max(7.0, len(text) / 6.0)
            if not minimum <= duration <= maximum:
                raise ValueError(f"Неправдоподобная длительность {duration:.2f} с")
            accepted = (segment, seed)
            break
        except Exception as exc:  # retry protects against rare truncated takes
            failures.append(str(exc))
    if accepted is None:
        raise RuntimeError("; ".join(failures))

    segment, used_seed = accepted
    emit({"type": "progress", "id": job_id, "stage": "mastering", "progress": 0.82})
    with tempfile.TemporaryDirectory(prefix="kadr-voice-") as temp_dir:
        raw = Path(temp_dir) / "raw.wav"
        mastered = Path(temp_dir) / "master.wav"
        audio_write(str(raw), segment, int(model.sample_rate), format="wav")
        subprocess.run([
            os.environ.get("KADR_FFMPEG", "ffmpeg"), "-y", "-hide_banner", "-loglevel", "error",
            "-i", str(raw),
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
    args = parser.parse_args()
    model = load_model(model_path=args.model)
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
