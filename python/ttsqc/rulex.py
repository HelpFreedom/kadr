"""Развёртывание чисел и латиницы в русские слова.

Нужно по двум независимым причинам:

1. Словарь выравнивателя — только кириллица (39 токенов), цифр и латиницы в
   нём нет вообще.
2. Whisper нормализует числа по-своему: сценарий «Семь миллиардов» приезжает
   как «7 миллиардов», «семьдесят процентов» — как «70%». Без развёртывания в
   единую форму на обеих сторонах это ложные расхождения, и кучкуются они
   ровно там, где числа, то есть якоря теряются там, где нужнее всего.
"""
from __future__ import annotations

import re

_UNITS_M = ["ноль", "один", "два", "три", "четыре", "пять", "шесть", "семь",
            "восемь", "девять"]
_UNITS_F = ["ноль", "одна", "две", "три", "четыре", "пять", "шесть", "семь",
            "восемь", "девять"]
_TEENS = ["десять", "одиннадцать", "двенадцать", "тринадцать", "четырнадцать",
          "пятнадцать", "шестнадцать", "семнадцать", "восемнадцать", "девятнадцать"]
_TENS = ["", "", "двадцать", "тридцать", "сорок", "пятьдесят", "шестьдесят",
         "семьдесят", "восемьдесят", "девяносто"]
_HUNDREDS = ["", "сто", "двести", "триста", "четыреста", "пятьсот", "шестьсот",
             "семьсот", "восемьсот", "девятьсот"]

# (формы для 1, для 2-4, для 5+, женский ли род числительного перед ним)
_SCALES = [
    (1_000, ("тысяча", "тысячи", "тысяч"), True),
    (1_000_000, ("миллион", "миллиона", "миллионов"), False),
    (1_000_000_000, ("миллиард", "миллиарда", "миллиардов"), False),
    (1_000_000_000_000, ("триллион", "триллиона", "триллионов"), False),
]


def plural_form(n: int, forms: tuple[str, str, str]) -> str:
    """Русское согласование: 1 рубль / 2 рубля / 5 рублей."""
    n = abs(n) % 100
    if 11 <= n <= 14:
        return forms[2]
    n %= 10
    if n == 1:
        return forms[0]
    if 2 <= n <= 4:
        return forms[1]
    return forms[2]


def _under_1000(n: int, feminine: bool) -> list[str]:
    out: list[str] = []
    if n >= 100:
        out.append(_HUNDREDS[n // 100])
        n %= 100
    if n >= 20:
        out.append(_TENS[n // 10])
        n %= 10
    if 10 <= n <= 19:
        out.append(_TEENS[n - 10])
        n = 0
    if n > 0:
        out.append((_UNITS_F if feminine else _UNITS_M)[n])
    return out


def number_to_words(n: int, feminine: bool = False) -> list[str]:
    """Целое число → список русских слов. Порядковые формы не поддерживаются."""
    if n < 0:
        return ["минус", *number_to_words(-n, feminine)]
    if n == 0:
        return ["ноль"]
    out: list[str] = []
    for scale, forms, scale_fem in reversed(_SCALES):
        if n >= scale:
            count = n // scale
            n %= scale
            # «тысяча человек», а не «одна тысяча человек»: перед названием
            # разряда единица в русском опускается.
            if count != 1:
                out.extend(_under_1000(count, scale_fem))
            out.append(plural_form(count, forms))
    if n > 0:
        out.extend(_under_1000(n, feminine))
    return out


# Термины, которые пользователь реально произносит; здесь важна не
# академическая транскрипция, а то, как это звучит в его роликах.
LATIN_LEXICON: dict[str, str] = {
    "python": "пайтон", "linux": "линукс", "windows": "виндовс",
    "android": "андроид", "ios": "иос", "macos": "макос",
    "claude": "клод", "chatgpt": "чатджипити", "openai": "опенэйай",
    "fable": "фейбл", "code": "код", "cloud": "клауд", "opus": "опус",
    "sonnet": "соннет", "haiku": "хайку", "vegas": "вегас", "sony": "сони",
    "adobe": "адоби", "premiere": "премьер", "effects": "эффектс",
    "after": "афтер", "pro": "про", "kadr": "кадр", "ffprobe": "эфэфпроб",
    "ffmpeg": "эфэфэмпег", "max": "макс",
    "escape": "эскейп", "rewind": "ревайнд", "undo": "анду", "redo": "риду",
    "commit": "коммит", "push": "пуш", "pull": "пул", "branch": "бранч",
    "prompt": "промпт", "token": "токен", "context": "контекст",
    "agent": "агент", "skill": "скилл", "hook": "хук", "plan": "план",
    "anthropic": "антропик", "google": "гугл", "youtube": "ютуб",
    "telegram": "телеграм", "tiktok": "тикток", "github": "гитхаб",
    "git": "гит", "docker": "докер", "kubernetes": "кубернетес",
    "javascript": "джаваскрипт", "typescript": "тайпскрипт",
    "node": "нод", "react": "реакт", "remotion": "ремоушен",
    "sudo": "судо", "bash": "баш", "shell": "шелл", "root": "рут",
    "api": "апи", "adb": "адэбэ", "rpg": "эрпэгэ", "cpu": "цэпэу",
    "gpu": "джипию", "ram": "рам", "ssd": "эсэсди", "usb": "юэсби",
    "http": "хаттэтэпэ", "https": "хаттэтэпэес", "url": "урл",
    "json": "джейсон", "html": "эйчтиэмэль", "css": "цэсэс",
    "sql": "эскуэль", "ai": "аи", "ml": "эмэль", "llm": "элэлэм",
    "genshin": "геншин", "impact": "импакт",
    "elevenlabs": "элевенлабс", "whisper": "виспер",
    "md": "эмдэ", "pdf": "пэдээф", "id": "айди", "ok": "окей",
}

# Названия русских букв — для аббревиатур, которых нет в словаре.
_LETTER_NAMES = {
    "a": "эй", "b": "би", "c": "си", "d": "ди", "e": "и", "f": "эф",
    "g": "джи", "h": "эйч", "i": "ай", "j": "джей", "k": "кей", "l": "эль",
    "m": "эм", "n": "эн", "o": "оу", "p": "пи", "q": "кью", "r": "ар",
    "s": "эс", "t": "ти", "u": "ю", "v": "ви", "w": "дабл-ю", "x": "экс",
    "y": "уай", "z": "зет",
}


def latin_to_cyrillic(word: str) -> str | None:
    """Латинское слово → кириллическая форма, или None если приблизить нечем.

    Возврат None — сознательное решение, а не заглушка: скармливать
    выравнивателю выдуманную транскрипцию хуже, чем честно сказать «это слово
    я озвучить не берусь». Такие слова закрываются star-токеном, и провал
    уверенности на них не превращается в ложный флаг `corrupt`.
    """
    low = word.lower()
    if low in LATIN_LEXICON:
        return LATIN_LEXICON[low]
    # Аббревиатура из заглавных (ADB, RPG, CPU) — читаем по буквам.
    if word.isupper() and 2 <= len(word) <= 5 and word.isalpha():
        parts = [_LETTER_NAMES.get(c.lower()) for c in word]
        if all(parts):
            return "".join(parts)  # type: ignore[arg-type]
    return None


_PERCENT_FORMS = ("процент", "процента", "процентов")


def expand_numeric(token: str) -> list[str] | None:
    """`70%` → [семьдесят, процентов]; `1000` → [тысяча]; иначе None.

    Разделители разрядов (пробел, апостроф) уже должны быть сняты токенизатором.
    Дробные и версии вида v0.4.0 читаются по частям — намеренно грубо, они
    редки и всё равно требуют ручного словаря.
    """
    t = token.strip()
    if not t:
        return None
    percent = t.endswith("%")
    if percent:
        t = t[:-1].strip()
    if not t:
        return None
    if not re.fullmatch(r"[0-9]+([.,][0-9]+)*", t):
        return None

    out: list[str] = []
    parts = re.split(r"[.,]", t)
    last = 0
    for part in parts:
        last = int(part)
        out.extend(number_to_words(last))
    if percent:
        out.append(plural_form(last, _PERCENT_FORMS))
    return out
