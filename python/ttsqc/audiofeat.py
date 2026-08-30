"""Представление звука для каждого кандидата: замороженный энкодер + пробник.

Двадцать признаков, которые считались до сих пор, — это мой пересказ звука:
длительность, плотность символов, сходство строк. Модель видела пересказ, а не
сам звук, и кривая обучения на этом упёрлась в плато: от 13 примеров до 92
качество не растёт.

Сеть с нуля здесь не годится — на трёх десятках положительных примеров она
запомнит выборку. Годится другое: wav2vec2 уже обучен на тысячах часов речи, и
его скрытые состояния описывают звук куда богаче любых рукописных чисел. Их
берут замороженными, сжимают до десятков измерений и поверх ставят линейную
модель — этот приём работает как раз на малых выборках.

Сжатие обучается ТОЛЬКО на обучающей части: иначе проверочный файл подсмотрит
собственное распределение, и оценка выйдет завышенной.
"""
from __future__ import annotations

import numpy as np
import torch

PAD = 0.30          # контекст вокруг кандидата: дефект слышен на фоне соседей
MIN_SAMPLES = 640


def embed_spans(audio: np.ndarray, spans: list[tuple[float, float]],
                backend, sr: int = 16000) -> np.ndarray:
    """Отрезки → [N, 2048]: среднее и разброс скрытых состояний энкодера.

    Разброс важен не меньше среднего: срыв генерации — это резкая смена внутри
    отрезка, и на усреднении она исчезает, а на дисперсии видна.
    """
    model = getattr(backend, "model", None)
    device = getattr(backend, "device", "cpu")
    out = []
    for t0, t1 in spans:
        i0 = max(int((t0 - PAD) * sr), 0)
        i1 = min(int((t1 + PAD) * sr), len(audio))
        seg = audio[i0:i1]
        if seg.size < MIN_SAMPLES or model is None:
            out.append(np.zeros(2048, dtype=np.float32))
            continue
        a = (seg - seg.mean()) / (seg.std() + 1e-7)
        with torch.inference_mode():
            x = torch.from_numpy(np.ascontiguousarray(a)).to(device).unsqueeze(0)
            hs = model(x, output_hidden_states=True).hidden_states[-1][0].float().cpu()
        out.append(np.concatenate([hs.mean(0).numpy(), hs.std(0).numpy()]))
    return np.asarray(out, dtype=np.float32)


class Compressor:
    """Сжатие представления, обучаемое только на обучающей части."""

    def __init__(self, n: int = 24):
        self.n = n
        self._p = None

    def fit(self, E: np.ndarray) -> "Compressor":
        from sklearn.decomposition import PCA
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import make_pipeline
        k = int(min(self.n, max(E.shape[0] - 1, 1), E.shape[1]))
        self._p = make_pipeline(StandardScaler(), PCA(n_components=k, random_state=0))
        self._p.fit(E)
        return self

    def transform(self, E: np.ndarray) -> np.ndarray:
        return self._p.transform(E) if self._p is not None else np.zeros((len(E), 0))
