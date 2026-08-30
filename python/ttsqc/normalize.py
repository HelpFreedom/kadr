"""Токенизация сценария и выдачи ASR в единую сопоставимую форму.

Обе стороны прогоняются через одну и ту же функцию — иначе якорное
выравнивание ловит расхождения формата вместо расхождений произношения.

Три формы у каждого слова, и они нужны все три:
  raw         — как в исходном файле, для показа пользователю;
  match_form  — для сопоставления сценария с ASR (кириллица, ё→е, числа
                развёрнуты, латиница оставлена как есть — Whisper тоже
                выдаёт латиницу, так что они совпадут напрямую);
  align_form  — для CTC-выравнивателя, у которого в словаре только кириллица;
                None означает «озвучить нечем», и такое слово закрывается
                star-токеном, а не выдумывается.
"""
from __future__ import annotations

import re

from .rulex import expand_numeric, latin_to_cyrillic
from .schema import AsrWord, ScriptWord

# Токен: кириллица / латиница / число (с % и разделителями) / дефисные сцепки.
_TOKEN_RE = re.compile(
    r"[0-9]+(?:[.,][0-9]+)*%?"          # 70%  1.5  2026
    r"|[А-Яа-яЁё]+(?:-[А-Яа-яЁё]+)*"     # какой-нибудь
    r"|[A-Za-z]+(?:-[A-Za-z]+)*"         # Python  ADB
)

# Клитики: фонологически они часть соседнего слова, и без слияния «на» даёт
# паразитную «ударную» гласную, а относительные признаки модуля ударений
# считаются на неверной области. right = примыкает к следующему слову.
PROCLITICS = {
    "в", "во", "на", "за", "под", "по", "из", "изо", "к", "ко", "с", "со",
    "о", "об", "обо", "от", "ото", "до", "у", "при", "про", "для", "без",
    "над", "перед", "через", "не", "ни", "и", "а", "но", "да", "что", "как",
}
ENCLITICS = {"же", "ли", "бы", "б", "ль", "то"}

_CYR = re.compile(r"^[а-яё-]+$")
_LAT = re.compile(r"^[a-z-]+$")

# Огрубление до фонетического ключа: оглушение шумных, схлопывание пар,
# снятие мягкости. Нужно, чтобы «самоваор»↔«самовар» стоило дёшево, а
# «овадлвыо»↔что угодно осталось дорого.
_PHON = str.maketrans({
    "ё": "е", "ъ": "", "ь": "", "й": "и", "ы": "и",
    "б": "п", "в": "ф", "г": "к", "д": "т", "ж": "ш", "з": "с",
    "щ": "ш", "ц": "с", "о": "а", "я": "а", "ю": "у", "э": "е",
})


def phonetic_key(word: str) -> str:
    """Грубый фонетический ключ для стоимости замены в выравнивании."""
    return word.lower().translate(_PHON).replace("-", "")


def _canon(word: str) -> str:
    return word.lower().replace("ё", "е")


def _expand(raw: str) -> list[tuple[str, str | None]]:
    """Один сырой токен → [(match_form, align_form), ...]."""
    num = expand_numeric(raw)
    if num is not None:
        return [(w, w) for w in num]

    low = _canon(raw)
    if _CYR.match(low):
        # Дефисные сцепки режем: выравниватель знает дефис, но слова в ASR
        # приезжают порознь, и как один токен они не совпадут.
        parts = [p for p in low.split("-") if p]
        return [(p, p) for p in parts] or [(low, low)]

    if _LAT.match(low):
        # Измеренное произношение имеет приоритет над таблицей догадок.
        return [(low, latin_to_cyrillic(raw))]

    return [(low, None)]


_SENT_BREAK = re.compile(r"[.!?…]|\n\s*\n")


def normalize_script(text: str) -> list[ScriptWord]:
    """Сценарий → слова с сохранением смещений в исходный файл.

    Заодно проставляется номер предложения. Он нужен не для разбора, а для
    показа: короткий фрагмент в полсекунды прослушать невозможно — по нему не
    понять, есть там дефект или нет. Играть надо предложение целиком, а
    подсвечивать внутри него найденное место.
    """
    out: list[ScriptWord] = []
    sent = 0
    prev_end = 0
    for m in _TOKEN_RE.finditer(text):
        raw = m.group(0)
        if _SENT_BREAK.search(text[prev_end:m.start()]):
            sent += 1
        prev_end = m.end()
        for match_form, align_form in _expand(raw):
            out.append(ScriptWord(
                idx=len(out),
                raw=raw,
                match=match_form,
                align_form=align_form or "",
                char_start=m.start(),
                char_end=m.end(),
                is_expanded=(match_form != _canon(raw)),
                is_latin=bool(_LAT.match(_canon(raw))),
                sent=sent,
            ))
    _apply_learned_lexicon(out)
    _tag_clitics(out)
    return out


def _apply_learned_lexicon(words: list[ScriptWord]) -> None:
    """Подставить измеренное произношение латинских цепочек.

    Мерилось по цепочке целиком («claude code» → «клаудкод»), потому что
    поодиночке такие слова не выделить. Обратно оно делится между словами
    пропорционально их длине — грубо, но структуру выравнивания это сохраняет,
    а от угаданной таблицы отличается тем, что взято из вашего же звука.
    """
    from .lexicon import load as _learned
    learned = _learned()
    if not learned:
        return
    i = 0
    while i < len(words):
        if not words[i].is_latin:
            i += 1
            continue
        j = i
        while j + 1 < len(words) and words[j + 1].is_latin:
            j += 1
        key = " ".join(words[k].match for k in range(i, j + 1))
        heard = learned.get(key)
        if heard:
            total = sum(len(words[k].match) for k in range(i, j + 1)) or 1
            pos = 0
            for k in range(i, j + 1):
                take = round(len(heard) * len(words[k].match) / total)
                words[k].align_form = heard[pos:pos + take] if k < j else heard[pos:]
                pos += take
        i = j + 1


def _tag_clitics(words: list[ScriptWord]) -> None:
    for i, w in enumerate(words):
        f = w.match
        if f in PROCLITICS and i + 1 < len(words):
            w.clitic_host = i + 1
        elif f in ENCLITICS and i > 0:
            w.clitic_host = i - 1


def normalize_asr(raw_words: list[tuple[str, float, float, float]]) -> list[AsrWord]:
    """Слова faster-whisper (word, start, end, probability) → AsrWord.

    Токен, разворачивающийся в несколько слов («70%» → «семьдесят процентов»),
    делит свой интервал пропорционально длине слов: точных границ внутри него
    нет, а якоря всё равно опираются на серии, а не на отдельное слово.
    """
    out: list[AsrWord] = []
    for word, start, end, prob in raw_words:
        for m in _TOKEN_RE.finditer(word):
            pieces = _expand(m.group(0))
            total = sum(len(p[0]) for p in pieces) or 1
            t = start
            for match, _align in pieces:
                dt = (end - start) * len(match) / total
                out.append(AsrWord(idx=len(out), word=m.group(0), norm=match,
                                   start=t, end=t + dt, probability=prob))
                t += dt
    return out
