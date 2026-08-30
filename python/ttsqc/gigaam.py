"""GigaAM v3 CTC как акустическая модель выравнивания.

Зачем менять модель. Канал искажений внутри слова давал точность 13%, и все
ложные срабатывания были одного вида: «консоли» → «концоле», «коммит» →
«комид». Это не метод ошибался, а `wav2vec2-large-xlsr-53-russian` — тюнинг
2021 года на мультиязычной основе — плохо разбирал буквы. Метод опирается на
жадный декод, и чистота декода прямо определяет его точность.

GigaAM v3 (декабрь 2025, Sber) — русская модель, посимвольный словарь из 34
токенов, то есть ровно тот же интерфейс. Отличия, которые надо учесть:

* вход — лог-мел 64 полосы, а не сырая волна;
* прореживание вчетверо: кадр 40 мс против 20 мс у wav2vec2, то есть
  выравнивание грубее по времени вдвое;
* нормализация признаков по каждой полосе отдельно, как в NeMo.
"""
from __future__ import annotations

import glob
from pathlib import Path

import numpy as np

SR = 16000
N_FFT = 512
WIN = 400          # 25 мс
HOP = 160          # 10 мс
N_MELS = 64
PREEMPH = 0.97
LOG_GUARD = 2.0 ** -24
SUBSAMPLE = 4      # кадр на выходе = 40 мс

REPO = "csukuangfj/sherpa-onnx-nemo-ctc-giga-am-v3-russian-2025-12-16"


def _hz_to_mel(f):
    return 2595.0 * np.log10(1.0 + f / 700.0)


def _mel_to_hz(m):
    return 700.0 * (10.0 ** (m / 2595.0) - 1.0)


def _mel_filters(n_mels: int = N_MELS, n_fft: int = N_FFT, sr: int = SR) -> np.ndarray:
    lo, hi = 0.0, sr / 2
    pts = _mel_to_hz(np.linspace(_hz_to_mel(lo), _hz_to_mel(hi), n_mels + 2))
    bins = np.floor((n_fft + 1) * pts / sr).astype(int)
    fb = np.zeros((n_mels, n_fft // 2 + 1), dtype=np.float32)
    for m in range(n_mels):
        l, c, r = bins[m], bins[m + 1], bins[m + 2]
        c = max(c, l + 1)
        r = max(r, c + 1)
        if r >= fb.shape[1]:
            break
        fb[m, l:c] = np.linspace(0, 1, c - l, endpoint=False)
        fb[m, c:r] = np.linspace(1, 0, r - c, endpoint=False)
    # Нормировка Slaney, как в librosa и NeMo.
    enorm = 2.0 / (pts[2:n_mels + 2] - pts[:n_mels])
    return fb * enorm[:, None]


_FB = None


def features(audio: np.ndarray) -> np.ndarray:
    """Волна 16 кГц → лог-мел [64, T] с нормализацией по полосам."""
    global _FB
    if _FB is None:
        _FB = _mel_filters()
    x = np.asarray(audio, dtype=np.float32)
    x = np.concatenate([x[:1], x[1:] - PREEMPH * x[:-1]])
    n = max(1 + (len(x) - WIN) // HOP, 1)
    pad = (n - 1) * HOP + WIN - len(x)
    if pad > 0:
        x = np.pad(x, (0, pad))
    idx = np.arange(WIN)[None, :] + HOP * np.arange(n)[:, None]
    frames = x[idx] * np.hanning(WIN).astype(np.float32)
    spec = np.abs(np.fft.rfft(frames, n=N_FFT, axis=1)) ** 2
    mel = np.log(spec @ _FB.T + LOG_GUARD).T          # [64, T]
    mean = mel.mean(axis=1, keepdims=True)
    std = mel.std(axis=1, keepdims=True) + 1e-5
    return ((mel - mean) / std).astype(np.float32)


class Aligner:
    """Тот же контракт, что у обёртки wav2vec2: эмиссии и словарь символов."""

    frame_dt = HOP * SUBSAMPLE / SR       # 0.04 с

    def __init__(self, model_dir: str | None = None):
        import onnxruntime as ort
        from huggingface_hub import snapshot_download

        d = model_dir or snapshot_download(
            REPO, allow_patterns=["model.int8.onnx", "tokens.txt"])
        self.dir = d
        opts = ort.SessionOptions()
        opts.intra_op_num_threads = 4
        self.sess = ort.InferenceSession(str(Path(d) / "model.int8.onnx"),
                                         sess_options=opts,
                                         providers=["CPUExecutionProvider"])
        self.char2id, self.blank = self._load_tokens(Path(d) / "tokens.txt")
        self.id2char = {v: k for k, v in self.char2id.items()}

    @staticmethod
    def _load_tokens(path: Path) -> tuple[dict[str, int], int]:
        char2id: dict[str, int] = {}
        blank = 0
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line:
                continue
            # Формат «токен пробел идентификатор»; сам токен может БЫТЬ пробелом.
            tok, _, sid = line.rpartition(" ")
            if not sid.isdigit():
                continue
            i = int(sid)
            if tok == "<blk>":
                blank = i
            else:
                char2id[tok if tok else " "] = i
        return char2id, blank

    def emissions(self, audio: np.ndarray) -> np.ndarray:
        f = features(audio)[None, :, :]
        lens = np.array([f.shape[2]], dtype=np.int64)
        out = self.sess.run(None, {"features": f, "feature_lengths": lens})[0]
        return out[0]                     # [T, 34], уже log_probs
