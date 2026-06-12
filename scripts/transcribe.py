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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio", required=True)
    ap.add_argument("--model", default="large-v3")
    ap.add_argument("--language", default="auto")
    ap.add_argument("--duration", type=float, default=0.0)
    args = ap.parse_args()

    from faster_whisper import WhisperModel

    threads = max(4, (os.cpu_count() or 8) - 2)
    model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=threads)

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


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001 — single funnel to the caller
        sys.stderr.write(f"transcribe failed: {e}\n")
        sys.exit(1)
