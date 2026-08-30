"""Пути к данным пакета.

Вынесено сюда при переносе ttsqc внутрь Kadr. Оригинал держал calibration.npz,
scorer.pkl, ttsqc.toml, cache/ и runs/ рядом с пакетом. В редакторе пакет лежит
внутри приложения (после сборки — только для чтения), а данные должны жить в
каталоге пользователя. Поэтому каждый путь берётся из переменной окружения, а
по умолчанию остаётся ровно тем же, что был, — запуск из консоли не меняется.
"""
from __future__ import annotations

import os
from pathlib import Path


def _env(name: str, default: Path) -> Path:
    v = os.environ.get(name)
    return Path(v).expanduser() if v else default


#: корень данных; по умолчанию — каталог над пакетом, как в оригинале
HOME = _env("KADR_TTSQC_HOME", Path(__file__).resolve().parent.parent)

#: веса. В копии Kadr они лежат в models/, в оригинале — прямо в корне
MODELS = _env("KADR_TTSQC_MODELS",
              HOME / "models" if (HOME / "models").is_dir() else HOME)

CORPUS_CAL = _env("KADR_TTSQC_CALIBRATION", MODELS / "calibration.npz")
SCORER = _env("KADR_TTSQC_SCORER", MODELS / "scorer.pkl")
LEARNED = _env("KADR_TTSQC_LEXICON", MODELS / "lexicon_learned.json")
CONFIG = _env("KADR_TTSQC_CONFIG", HOME / "ttsqc.toml")
CACHE = _env("KADR_TTSQC_CACHE", HOME / "cache")
RUNS = _env("KADR_TTSQC_RUNS", HOME / "runs")
