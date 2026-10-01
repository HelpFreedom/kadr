#!/usr/bin/env python3
"""Kadr transcription runner: faster-whisper with anti-hallucination guards.

Reads a wav/audio file, streams NDJSON to stdout:
  {"type":"segment","start":..,"end":..,"text":..,"words":[{"start","end","word","probability"}]}
  {"type":"progress","p":0..1}
  {"type":"done","language":"ru","duration":..}
Errors go to stderr with a non-zero exit code.

Hallucination defenses (Whisper invents text in silence/music):
- built-in Silero VAD skips non-speech regions entirely
- condition_on_previous_text=False breaks repetition feedback loops
- compression_ratio / log_prob / no_speech thresholds drop gibberish
- hallucination_silence_threshold skips text "heard" inside long silences
- post-filters: drop segments whose words are uniformly low-confidence and
  collapse runs of identical consecutive segments (classic loop artifact)
"""
import argparse
import json
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _register_nvidia_dlls():
    """pip wheels nvidia-cublas-cu12 / nvidia-cudnn-cu12 drop their DLLs under
    site-packages/nvidia/<lib>/bin, which is not on the Windows search path.
    Register those folders so ctranslate2 can find cublas64_12.dll & co."""
    if os.name != "nt" or not hasattr(os, "add_dll_directory"):
        return
    try:
        import nvidia  # namespace package from the wheels
    except ImportError:
        return
    for root in getattr(nvidia, "__path__", []):
        for lib in os.listdir(root):
            d = os.path.join(root, lib, "bin")
            if os.path.isdir(d):
                try:
                    os.add_dll_directory(d)
                    os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")
                except OSError:
                    pass


def pick_device():
    """cuda when ctranslate2 sees a GPU, cpu otherwise.
    KADR_WHISPER_DEVICE=cpu|cuda|auto overrides (default auto)."""
    want = os.environ.get("KADR_WHISPER_DEVICE", "auto").strip().lower()
    if want == "cpu":
        return "cpu"
    _register_nvidia_dlls()
    try:
        import ctranslate2
        has_cuda = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        has_cuda = False
    if not has_cuda and want == "cuda":
        sys.stderr.write("whisper: KADR_WHISPER_DEVICE=cuda but no CUDA device; using cpu\n")
    return "cuda" if has_cuda else "cpu"


def load_model(WhisperModel, name, device):
    if device == "cuda":
        try:
            m = WhisperModel(name, device="cuda", compute_type="float16")
            sys.stderr.write("whisper: cuda/float16\n")
            return m
        except Exception as e:  # noqa: BLE001 — any load failure means "use cpu"
            sys.stderr.write(f"whisper: cuda load failed ({e}); falling back to cpu\n")
    threads = max(4, (os.cpu_count() or 8) - 2)
    m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=threads)
    sys.stderr.write(f"whisper: cpu/int8 x{threads}\n")
    return m


def run(model, args, progress):
    segments, info = model.transcribe(
        args.audio,
        language=None if args.language == "auto" else args.language,
        beam_size=5,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=500, speech_pad_ms=120),
        condition_on_previous_text=False,
        word_timestamps=True,
        hallucination_silence_threshold=2.0,
        no_speech_threshold=0.6,
        log_prob_threshold=-1.0,
        compression_ratio_threshold=2.4,
    )

    total = args.duration or getattr(info, "duration", 0) or 0
    prev_text = None
    repeats = 0
    for seg in segments:
        text = seg.text.strip()
        if not text:
            continue
        words = [
            {"start": round(w.start, 3), "end": round(w.end, 3),
             "word": w.word, "probability": round(w.probability, 3)}
            for w in (seg.words or [])
        ]
        # uniformly unsure words = likely confabulated over noise/music
        if words:
            avg_p = sum(w["probability"] for w in words) / len(words)
            if avg_p < 0.2:
                continue
        # collapse repetition loops: the same line over and over
        if text == prev_text:
            repeats += 1
            if repeats >= 2:
                continue
        else:
            prev_text = text
            repeats = 0
        progress["segments"] += 1
        emit({
            "type": "segment",
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": text,
            "words": words,
        })
        if total > 0:
            emit({"type": "progress", "p": min(1.0, seg.end / total)})

    emit({"type": "done", "language": getattr(info, "language", args.language),
          "duration": total})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--duration", type=float, default=0.0)
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    device = pick_device()
    model = load_model(WhisperModel, args.model, device)

    progress = {"segments": 0}
    try:
        run(model, args, progress)
    except Exception as e:  # noqa: BLE001
        # only retry while nothing has reached the editor yet — a CPU
        # rerun after partial GPU output would stream every segment twice
        if device != "cuda" or progress["segments"]:
            raise
        # cuBLAS/cuDNN missing, VRAM exhausted, driver too old: the load
        # succeeded but the first kernel did not. Do the job on the CPU
        # instead of failing the user's transcription.
        sys.stderr.write(f"whisper: cuda inference failed ({e}); retrying on cpu\n")
        model = load_model(WhisperModel, args.model, "cpu")
        run(model, args, progress)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — single funnel to the caller
        sys.stderr.write(f"transcribe failed: {e}\n")
        sys.exit(1)
