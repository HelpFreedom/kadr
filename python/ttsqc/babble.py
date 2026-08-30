"""Абракадабра: звук, которого нет в сценарии, любой длины.

Самый частый дефект в реальном материале, и самый неудобный для покрытия по
VAD: он бывает длиной в одну букву, а на такой длительности обычная речь и
глюк по энергии неотличимы.

Решение — сравнить два прочтения ОДНОЙ матрицы эмиссий:

* насильное выравнивание по сценарию — что должно было прозвучать;
* жадное декодирование — что модель слышит на самом деле.

Обе последовательности символьные, обе на одной сетке кадров, обе от одной
модели. Их разность — это ровно лишний звук, с точностью до кадра, и в неё не
подмешивается WER стороннего распознавателя.

Одна оговорка, без которой сигнал утонет в шуме: жадный декод почти всегда
отличается от сценария на отдельные буквы, потому что модель слышит
коартикуляцию и редукцию. Поэтому дефектом объявляется не любое лишнее
вкрапление, а связный блок вставки, который к тому же попадает на
вокализованный участок.
"""
from __future__ import annotations

import difflib

import numpy as np

FRAME_MIN = 3           # короче трёх кадров (60 мс) — это дрожание декодера


def find_blocks(greedy: list[tuple[int, int, int, float]], expected: list[int],
                id2char: dict[int, str], t_offset: float, frame_dt: float,
                region_dur: float, skip_ids: set[int],
                min_frames: int = FRAME_MIN, min_chars: int = 2,
                edge_guard: float = 0.10, guard_left: float | None = None,
                guard_right: float | None = None) -> list[dict]:
    """Блоки, которые модель слышит, но которых нет в ожидаемой строке.

    Три вида мусора надо снять до сравнения, иначе настоящий сигнал в них
    тонет — на реальном файле было 460 блоков на 10 минут против примерно
    десятка настоящих.

    * **Токен-разделитель слов.** Он не звук, а служебная метка; расхождения
      по нему дают блоки вида «|||», то есть чистый шум.
    * **Края зоны.** Аудио зоны шире её текста на величину подпорки, поэтому у
      границы модель законно слышит соседние слова, которых в ожидаемой строке
      нет. Но отступ должен быть маленьким: промежуточные зоны захватывают по
      паре слов от соседних якорей, так что текст покрывает весь их звук.
      Большой отступ нужен только там, где у зоны открытый край — начало и
      конец файла. Плоские 0.4 с с двух сторон выбрасывали 30% кандидатов, а
      медианная промежуточная зона длится 1.1 с, то есть съедались целиком —
      и именно они, потому что абракадабра ломает якорь и создаёт промежуток.
    * **Слова, которые нечем озвучить** — снимаются выше по стеку, окнами.
    """
    keep = [(i, g) for i, g in enumerate(greedy) if g[0] not in skip_ids]
    exp = [e for e in expected if e not in skip_ids]
    heard_ids = [g[0] for _i, g in keep]

    sm = difflib.SequenceMatcher(None, exp, heard_ids, autojunk=False)
    out: list[dict] = []
    for tag, _i1, _i2, j1, j2 in sm.get_opcodes():
        if tag != "insert" or j2 - j1 < min_chars:
            continue
        f0 = keep[j1][1][1]
        f1 = keep[j2 - 1][1][2]
        if f1 - f0 < min_frames:
            continue
        t0 = f0 * frame_dt
        t1 = f1 * frame_dt
        gl = edge_guard if guard_left is None else guard_left
        gr = edge_guard if guard_right is None else guard_right
        if t0 < gl or t1 > region_dur - gr:
            continue
        text = "".join(id2char.get(keep[k][1][0], "?") for k in range(j1, j2))
        conf = float(np.mean([keep[k][1][3] for k in range(j1, j2)]))
        out.append({
            "t0": t_offset + t0,
            "t1": t_offset + t1,
            "heard": text,
            "n_chars": j2 - j1,
            "model_conf": round(conf, 3),
        })
    return out


def drop_windows(blocks: list[dict], windows: list[tuple[float, float]]
                 ) -> list[dict]:
    """Убрать блоки, попавшие на слова, которые нечем озвучить.

    Модель честно слышит «соневегоспро», и это правильный звук для написанного
    Sony Vegas Pro. Кириллицей мы его записать не умеем, поэтому в ожидаемой
    строке его нет — но дефектом он от этого не становится.
    """
    if not windows:
        return blocks
    out = []
    for b in blocks:
        mid = (b["t0"] + b["t1"]) / 2
        if any(w0 - 0.15 <= mid <= w1 + 0.15 for w0, w1 in windows):
            continue
        out.append(b)
    return out


def merge(blocks: list[dict], gap: float = 0.20) -> list[dict]:
    """Слить соседние блоки: одна вставка часто рвётся на куски."""
    if not blocks:
        return []
    blocks = sorted(blocks, key=lambda b: b["t0"])
    out = [dict(blocks[0])]
    for b in blocks[1:]:
        if b["t0"] - out[-1]["t1"] <= gap:
            out[-1]["t1"] = max(out[-1]["t1"], b["t1"])
            out[-1]["heard"] += b["heard"]
            out[-1]["n_chars"] += b["n_chars"]
            out[-1]["model_conf"] = min(out[-1]["model_conf"], b["model_conf"])
        else:
            out.append(dict(b))
    return out


def keep_voiced(blocks: list[dict], speech_p: np.ndarray, vad_hop: float,
                thr: float = 0.5) -> list[dict]:
    """Оставить только блоки, попавшие на озвученный участок.

    Лишние символы, выпавшие на тишину, — это дрожание декодера, а не звук.
    """
    out = []
    n = len(speech_p)
    for b in blocks:
        i0 = max(int(b["t0"] / vad_hop), 0)
        i1 = min(int(np.ceil(b["t1"] / vad_hop)), n)
        if i1 <= i0:
            continue
        if float(speech_p[i0:i1].mean()) >= thr:
            b["voiced"] = round(float(speech_p[i0:i1].mean()), 2)
            out.append(b)
    return out


def drop_coarticulation(blocks: list[dict], script, word_scores,
                        radius: int = 3, thr: float = 0.78,
                        mark_only: bool = False) -> list[dict]:
    """Убрать блоки, которые всего лишь пересказ соседнего текста.

    Жадный декод слышит «вто» там, где написано «в том», и «ра» внутри слова
    «работал»: модель просто разложила границу слова иначе, чем выравнивание.
    Это не лишний звук, а разночтение по стыку.

    Настоящая абракадабра на соседний текст не похожа: «шторымнимма» рядом с
    «масштаб поворот» даёт низкое сходство, а «вто» рядом с «в том» — высокое.
    Порог держится высоким намеренно: пропустить ложный флаг дешевле, чем
    съесть настоящий.
    """
    if not script:
        return blocks
    times = sorted((sc["t0"], i) for i, sc in word_scores.items())
    if not times:
        return blocks
    starts = [t for t, _ in times]
    idx = [i for _t, i in times]

    out = []
    for b in blocks:
        mid = (b["t0"] + b["t1"]) / 2
        k = max(min(int(np.searchsorted(starts, mid)), len(idx) - 1), 0)
        centre = idx[k]
        lo = max(centre - radius, 0)
        hi = min(centre + radius + 1, len(script))
        local = "".join(script[i].align_form for i in range(lo, hi))
        heard = b["heard"]
        if not local or not heard:
            out.append(b)
            continue
        best = 0.0
        n = len(heard)
        for start in range(max(len(local) - n + 1, 1)):
            window = local[start:start + n]
            best = max(best, difflib.SequenceMatcher(None, heard, window).ratio())
        b["local_sim"] = round(best, 2)
        if best < thr or mark_only:
            out.append(b)
    return out


def misheard_words(greedy_abs: list[tuple[str, float, float]], script,
                   word_scores: dict[int, dict], min_len: int = 4,
                   min_sim: float = 0.45, max_sim: float = 0.80,
                   pad: float = 0.04) -> list[dict]:
    """Слово, прочитанное искажённо: «конкретного» как «конерентного».

    Свободный распознаватель такое чинит — его языковая модель тянет звук к
    ближайшему настоящему слову, и в транскрипте появляется правильная форма.
    Жадный декод не тянет никуда: он выдаёт то, что слышит акустика, буква за
    буквой. Поэтому искажения внутри слова видны только здесь.

    Границы слов берутся из насильного выравнивания, а не угадываются по
    паузам в декоде. Угадывание уезжало и давало мусор вида «назад» → «за»:
    сравнивалось слово сценария со случайно нарезанным куском услышанного.
    """
    out: list[dict] = []
    for w in script:
        sc = word_scores.get(w.idx)
        form = w.align_form
        if sc is None or not form or len(form) < min_len:
            continue
        # Границы слова приходят от выравнивателя, а расшифровка — от другой
        # модели с вдвое более грубой сеткой. На стыке сеток символы срезаются,
        # и «туда» приезжает как «ту». Отсюда запас в один кадр с каждой
        # стороны и более строгий порог на усечение.
        heard = transcribe_span(greedy_abs, sc["t0"] - pad, sc["t1"] + pad)
        if not heard or len(heard) < 0.65 * len(form):
            continue
        sim = difflib.SequenceMatcher(None, form, heard).ratio()
        if not (min_sim <= sim <= max_sim):
            continue
        out.append({
            "script_word": w.idx,
            "t0": sc["t0"], "t1": sc["t1"],
            "want": form, "heard": heard,
            "similarity": round(sim, 2),
            "repeat": longest_repeat(heard),
        })
    return out


def longest_repeat(text: str, min_len: int = 2) -> str:
    """Самый длинный кусок, который звучит в слове дважды подряд.

    Прямая подпись заикания: «вещь», прочитанное как «весщьвещ», содержит
    «вещ» дважды; «понял» как «поняпоня» — «поня». Отличает настоящий срыв
    генерации от мелкой неточности декодера, где повтора нет.
    """
    n = len(text)
    best = ""
    for size in range(n // 2, min_len - 1, -1):
        for i in range(n - 2 * size + 1):
            if text[i:i + size] == text[i + size:i + 2 * size]:
                return text[i:i + size]
    return best


def transcribe_span(greedy_abs: list[tuple[str, float, float]],
                    t0: float, t1: float) -> str:
    """Что жадный декод слышит на заданном отрезке."""
    return "".join(c for c, a, b in greedy_abs if b > t0 and a < t1)


CHARS_PER_SEC = 14.0        # темп русской начитки в символах
LOW_YIELD = 0.35            # доля от нормы, ниже которой звук неразборчив


def low_char_yield(heard: str, dur: float) -> float:
    """Насколько мало символов дал жадный декод на этом звуке.

    Отдельный и независимый признак абракадабры, до которого я дошёл только по
    указанным вручную пропускам. Триста миллисекунд на уровне обычной речи,
    из которых модель извлекает пустую строку или одну букву, — это не речь,
    которую не туда положили, а звук, который не раскладывается на фонемы.
    Нормальная начитка даёт около четырнадцати символов в секунду.

    Возвращает отношение к норме: меньше — подозрительнее.
    """
    if dur <= 0:
        return 1.0
    return (len(heard) / dur) / CHARS_PER_SEC


def is_late_onset(heard: str, script, word_idx: int, radius: int = 2,
                  thr: float = 0.55, min_chars: int = 3,
                  max_share: float = 0.6) -> bool:
    """Опоздал ли выравниватель с началом слова, или это лишний звук.

    Различие, которое проверка на кратность сделать не могла и из-за которого
    терялись настоящие находки: она спрашивала, есть ли услышанные слова в
    соседнем тексте, а ответ там почти всегда «да».

    Здесь вопрос точнее. Если выравниватель просто поздно поставил границу, то
    в непокрытом звуке лежит НАЧАЛО следующего слова — и жадный декод выдаёт
    его первые буквы. Если это абракадабра, декод выдаёт что-то другое.

    Важная оговорка про объём: опоздание срезает несколько звуков, а не целые
    слова. Если в непокрытом звуке лежит слово целиком или несколько слов, то
    они произнесены дважды — выравниватель покрыл одно вхождение, второе
    осталось, — и это повтор, то есть настоящий дефект. Без этой оговорки
    терялась абракадабра, которую диктор проговаривает связными словами.
    """
    # На одной-двух буквах судить не о чем: они случайно совпадут с началом
    # почти любого слова, и проверка начнёт съедать настоящие находки — так
    # были потеряны сразу три подтверждённых дефекта.
    if not heard or not script or len(heard) < min_chars:
        return False
    lo = max(word_idx - radius, 0)
    hi = min(word_idx + radius + 1, len(script))
    for i in range(lo, hi):
        form = script[i].align_form
        if not form:
            continue
        # Повтор от среза отличается полнотой, а не длиной. «войтесь» рядом с
        # «Освойтесь» длинно, но это хвост слова — выравниватель сдвинул
        # границу. «думаешьпочему» рядом с «думаешь почему» — это те же слова
        # целиком, произнесённые второй раз.
        if difflib.SequenceMatcher(None, heard, form).ratio() >= 0.75 \
                and len(heard) >= 0.85 * len(form):
            continue                    # слово целиком — повтор, не срез
        if len(heard) > max_share * len(form) and len(heard) > len(form):
            continue
        head = form[:max(len(heard), 2)]
        tail = form[-max(len(heard), 2):]
        for part in (head, tail):
            if difflib.SequenceMatcher(None, heard, part).ratio() >= thr:
                return True
    return False
