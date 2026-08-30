"""Загрузка ttsqc.toml. Всё калибруемое живёт там, а не в коде."""
from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

from .paths import CONFIG as _DEFAULT


class Config:
    def __init__(self, data: dict[str, Any]):
        self._d = data

    def __getitem__(self, section: str) -> dict[str, Any]:
        return self._d[section]

    def get(self, section: str, key: str, default: Any = None) -> Any:
        return self._d.get(section, {}).get(key, default)


def load(path: str | Path | None = None) -> Config:
    p = Path(path) if path else _DEFAULT
    with open(p, "rb") as f:
        return Config(tomllib.load(f))
