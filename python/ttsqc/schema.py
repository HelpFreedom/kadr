"""Структуры данных, ходящие между стадиями.

Соглашение по координатам, важное для всего проекта: первичный ключ дефекта —
это интервал индексов слов сценария, а таймкоды производны от него. Таймкоды
умирают при любой перегенерации и при любом изменении выравнивания, индекс
слова в известном тексте живёт вечно. Интервалу разрешено быть пустым:
words=(412, 412) означает вставку между словом 412 и 413.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Any, Literal

DefectClass = Literal["insert", "corrupt", "missing", "truncation", "stress",
                      "misread", "script_typo", "region_fail"]
Tier = Literal["must-review", "glance", "suppressed"]


@dataclass(slots=True)
class ScriptWord:
    """Слово сценария после нормализации.

    `raw` — как в исходном файле, `match` — форма для сопоставления с ASR,
    `align_form` — кириллическая форма для выравнивателя ("" если приблизить
    нечем: такое слово закрывается star-токеном, а не выдумывается).
    `char_start`/`char_end` указывают в исходный текст, чтобы отчёт мог
    показать контекст ровно так, как он написан у пользователя.
    """
    idx: int
    raw: str
    match: str          # форма для сопоставления сценария с ASR
    align_form: str     # кириллическая форма для CTC; "" = озвучить нечем
    char_start: int
    char_end: int
    is_expanded: bool = False   # цифра или латиница, развёрнутая в слова
    is_latin: bool = False      # исходно латиница — произношение измеряемо
    clitic_host: int | None = None  # индекс слова-хозяина, если это клитика
    sent: int = 0               # номер предложения — область проигрывания


@dataclass(slots=True)
class AsrWord:
    idx: int
    word: str
    norm: str
    start: float
    end: float
    probability: float


@dataclass(slots=True)
class Anchor:
    """Серия точных совпадений, связывающая сценарий со временем."""
    script_lo: int
    script_hi: int      # полуинтервал [lo, hi)
    asr_lo: int
    asr_hi: int
    t0: float
    t1: float

    @property
    def n_words(self) -> int:
        return self.script_hi - self.script_lo


@dataclass(slots=True)
class Region:
    """Участок между якорями, внутри которого гоняется CTC-выравнивание."""
    script_lo: int
    script_hi: int
    t0: float
    t1: float
    star_left: bool = True
    star_right: bool = True
    reliable: bool = True
    note: str = ""

    @property
    def duration(self) -> float:
        return self.t1 - self.t0


@dataclass(slots=True)
class CharAlign:
    """Один символ сценария, привязанный ко времени."""
    char: str
    script_word: int
    t0: float
    t1: float
    peak: float         # max log-апостериорной вероятности по кадрам символа
    margin: float       # отрыв от лучшего конкурента в пиковом кадре
    occupancy: int      # число кадров; 0 = вырожденный обход, сам по себе сигнал


@dataclass(slots=True)
class StarSpan:
    """Интервал, отданный star-токену на проходе B — прямое измерение вставки."""
    t0: float
    t1: float
    after_word: int     # индекс слова сценария, после которого стоит star
    frames: int


@dataclass(slots=True)
class WordAlign:
    script_word: int
    t0: float
    t1: float
    chars: list[CharAlign] = field(default_factory=list)
    reliable: bool = True


@dataclass(slots=True)
class Defect:
    id: str
    cls: DefectClass
    tier: Tier
    confidence: float
    words: tuple[int, int]
    audio: tuple[float, float]      # точные границы дефекта, для подсветки
    text: str
    play: tuple[float, float] = (0.0, 0.0)   # что проигрывать: всё предложение
    context_before: str = ""
    context_after: str = ""
    evidence: dict[str, Any] = field(default_factory=dict)

    def to_json(self) -> dict[str, Any]:
        d = asdict(self)
        d["class"] = d.pop("cls")
        d["words"] = list(self.words)
        d["audio"] = [round(self.audio[0], 3), round(self.audio[1], 3)]
        d["play"] = [round(self.play[0], 3), round(self.play[1], 3)]
        return d


@dataclass(slots=True)
class AnalysisResult:
    audio_path: str
    script_path: str
    duration: float
    script_words: list[ScriptWord]
    regions: list[Region]
    defects: list[Defect]
    suppressed: list[Defect] = field(default_factory=list)
    text_mismatches: list[Defect] = field(default_factory=list)
    trust: float = 1.0          # доля слов, выровненных внутри надёжных зон
    stats: dict[str, Any] = field(default_factory=dict)
    aligned: Any = None         # промежуточные данные выравнивания, для отчёта
    word_scores: dict[int, Any] = field(default_factory=dict)
