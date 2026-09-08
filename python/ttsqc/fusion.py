"""Слияние сигналов в спаны дефектов.

Правила, а не обученная модель. Структура правил останется и потом — обучаться
будет только калибровка, как только наберётся размеченных слов. Так решение
остаётся проверяемым: можно спросить «почему это отмечено» и получить ответ.

Рабочая точка задаётся бюджетом, а не порогом. Асимметрия в пользу полноты
примерно 50:1, но поток флагов — тоже провал: восемьдесят отметок на пятнадцать
минут, и их перестанут читать. Поэтому цель — не «всё, что выше порога», а
«двенадцать самых убедительных на десять минут», плюс два исключения, которые
бюджет игнорируют, потому что катастрофичны и редки.
"""
from __future__ import annotations

import math

from .schema import Defect, ScriptWord, StarSpan

# Короткие служебные слова законно сжимаются до неразличимости; требовать от
# них нормальной длительности значит флагать каждый предлог.
FUNCTION_WORDS = {
    "в", "во", "на", "за", "под", "по", "из", "к", "ко", "с", "со", "о", "об",
    "от", "до", "у", "и", "а", "но", "да", "не", "ни", "же", "ли", "бы", "то",
    "что", "как", "уже", "или", "их", "его", "её", "их",
}

MUST_REVIEW = 0.60
GLANCE = 0.25
PLAY_MAX_S = 12.0       # длинное предложение целиком слушать незачем
PLAY_PAD_S = 0.25


def _sigmoid(x: float) -> float:
    return 1.0 / (1.0 + math.exp(-max(min(x, 30.0), -30.0)))


def find_missing(script: list[ScriptWord], word_scores: dict[int, dict],
                 median_char_s: float) -> list[tuple[int, float]]:
    """Слова, которых в звуке фактически нет.

    Предохранитель: слово, которое CTC покрыл нормальной длительностью, не
    объявляется пропущенным, даже если ASR его потерял. Именно этот
    предохранитель не даёт проглоченным Whisper служебным словам затопить
    выдачу — а он их теряет постоянно, на этом материале 3–6% слов.
    """
    out: list[tuple[int, float]] = []
    for w in script:
        if not w.align_form:
            continue
        sc = word_scores.get(w.idx)
        if sc is None:
            out.append((w.idx, 0.75))          # не выровнено вовсе
            continue
        if w.match in FUNCTION_WORDS or len(w.match) <= 2:
            continue
        if not w.align_form:
            # Слово, которое нечем озвучить (латиница вне словаря), закрыто
            # star-токеном по построению. Объявлять его пропущенным — значит
            # флагать собственное незнание, а не дефект генерации.
            continue
        expected = max(sc["n_chars"] * median_char_s, 0.04)
        ratio = (sc["t1"] - sc["t0"]) / expected
        if sc["empty_frac"] >= 0.5:
            out.append((w.idx, min(0.9, 0.5 + sc["empty_frac"] / 2)))
        elif ratio < 0.25:
            out.append((w.idx, min(0.85, 0.4 + (0.25 - ratio) * 2)))
    return out


def find_truncation(script: list[ScriptWord], word_scores: dict[int, dict],
                    missing: list[tuple[int, float]], duration: float,
                    tail_slack: float = 1.0) -> tuple[int, float] | None:
    """Обрыв генерации: хвост сценария не произнесён, и аудио на этом кончилось.

    Самый дешёвый и самый ценный детектор во всей системе — одна проверка,
    ноль ложных срабатываний по построению, и ловит он катастрофу, которую
    иначе замечают уже после публикации.
    """
    miss = {i for i, _ in missing}
    if not miss or not word_scores:
        return None
    n = len(script)
    k = n
    while k > 0 and (k - 1) in miss:
        k -= 1
    if k == n or n - k < 3:
        return None
    aligned_end = max(sc["t1"] for sc in word_scores.values())
    if duration - aligned_end > tail_slack + 2.0:
        return None
    return k, 0.95


def find_corrupt(word_scores: dict[int, dict], reliable: dict[int, bool],
                 loops: list[tuple[float, float, int, float]],
                 intraword: list[tuple[int, float, float]],
                 s1_thr: float = 2.5, s2_thr: float = 2.5
                 ) -> list[tuple[int, float, dict]]:
    """Искажение внутри слова: лишний слог, заикание, глюк-всплеск.

    Самый трудный класс. Свободный ASR нормализует «самоваор» обратно в
    «самовар», и отчасти это делает и выравниватель: wav2vec2 учили на живой
    речи со всей её вариативностью. Поэтому одного S1 мало, и вторая половина
    правила требует совпадения длительности с акустической аномалией.
    """
    sil_words = {w for w, _a, _b in intraword}
    out: list[tuple[int, float, dict]] = []
    for w, sc in word_scores.items():
        if sc["n_chars"] < 4:
            # На «с», «в», «Но» провал уверенности ничего не означает: они
            # короткие, редуцируются и сливаются с соседями. Флагами по ним
            # выдача забивалась быстрее, чем чем-либо ещё.
            continue
        # Требовать надёжную зону нельзя, и это измерено: искажённое слово
        # ломает точное совпадение со свободным ASR, рвёт якорь и падает в
        # промежуток. На реальном файле при пороге 2.5 таких слов было три —
        # и все три в промежутках, то есть правило с гейтом «только якоря»
        # возвращало ноль всегда, независимо от того, что в аудио.
        # Вместо гейта — более высокая планка там, где выравнивание шатко.
        bar = s1_thr if reliable.get(w, False) else s1_thr + 1.0
        ev: dict = {}
        conf = 0.0
        if sc["s1"] >= bar:
            ev["s1"] = round(sc["s1"], 2)
            # s1 — это -log10(доля символов, которым модель верит меньше).
            # Шкала уже ограничена шестёркой, так что растягиваем её линейно и
            # без насыщения: бюджету нужно, чтобы флаги различались.
            conf = max(conf, min(0.90, 0.25 + 0.18 * (sc["s1"] - bar)))
        has_loop = any(t0 < sc["t1"] and t1 > sc["t0"] for t0, t1, _l, _n in loops)
        if has_loop:
            ev["loop"] = True
            conf = max(conf, 0.8)
        if sc["s2_long"] > s2_thr and (has_loop or w in sil_words):
            ev["s2_long"] = round(sc["s2_long"], 2)
            conf = max(conf, 0.65)
        elif sc["s2_long"] > s2_thr + 1.0 and sc["s1"] >= bar - 1.0:
            # Растяжка сама по себе не дефект (слово могли произнести с
            # нажимом), но растяжка вместе с просевшей уверенностью — это уже
            # лишний слог или заикание.
            ev["s2_long"] = round(sc["s2_long"], 2)
            ev["s1"] = round(sc["s1"], 2)
            conf = max(conf, 0.5)
        if conf > 0:
            out.append((w, conf, ev))
    return out


def from_misheard(misheard: list[dict]) -> list[tuple[int, float, dict]]:
    """Слово, которое акустика читает не так, как написано."""
    out = []
    for m in misheard:
        sim = m["similarity"]
        rep = m.get("repeat") or ""
        # Чем дальше услышанное от написанного, тем увереннее дефект; совсем
        # далёкое отсекается выше по стеку как «другое слово», а не искажение.
        conf = min(0.9, 0.30 + 0.7 * (0.82 - sim))
        ev = {"звучит": m["heard"], "написано": m["want"], "сходство": sim,
              "канал": "жадный декод"}
        if len(rep) >= 2:
            # Повтор куска внутри слова — прямая подпись заикания, а не
            # неточности декодера.
            conf = min(0.95, conf + 0.25)
            ev["повтор"] = rep
        out.append((m["script_word"], conf, ev))
    return out


def find_insert(speech_runs: list[tuple[float, float, float, str]],
                stars: list[StarSpan], merge_gap: float = 0.25,
                min_len: float = 0.35,
                babble: list[dict] | None = None
                ) -> list[tuple[float, float, float, dict]]:
    """Вставки: озвученная речь, которой не соответствует ничего в сценарии.

    Соседние прогоны сливаются до классификации: одна вставка почти всегда
    рвётся на куски вдохом или микропаузой внутри неё, и без слияния она
    приезжает как три отдельных флага вместо одного.
    """
    # Каждый прогон приходит с расшифровкой жадного декода: пользователю важно
    # видеть не координату, а что именно звучит.
    heard_by: dict[tuple[float, float], str] = {}
    late_by: dict[tuple[float, float], float] = {}
    runs = []
    for item in speech_runs:
        t0, t1, c = item[0], item[1], item[2]
        runs.append((t0, t1, c))
        if len(item) > 3 and item[3]:
            heard_by[(t0, t1)] = item[3]
        if len(item) > 4:
            late_by[(t0, t1)] = float(item[4])
    # Блоки жадного декода идут отдельным входом: у них нет ограничения на
    # длительность, потому что абракадабра длиной в одну букву — самый частый
    # случай, а покрытие по VAD на такой длине уже не работает.
    for b in (babble or ()):
        runs.append((b["t0"], b["t1"], 0.9))
        heard_by[(b["t0"], b["t1"])] = b["heard"]
    if not runs:
        return []
    runs = sorted(runs)
    merged: list[list] = [[*runs[0], heard_by.get((runs[0][0], runs[0][1]), "")]]
    for t0, t1, c in runs[1:]:
        h = heard_by.get((t0, t1), "")
        if t0 - merged[-1][1] <= merge_gap:
            merged[-1][1] = max(merged[-1][1], t1)
            merged[-1][2] = max(merged[-1][2], c)
            merged[-1][3] = (merged[-1][3] + h) if h else merged[-1][3]
        else:
            merged.append([t0, t1, c, h])

    out = []
    for t0, t1, c, heard_txt in merged:
        dur = t1 - t0
        heard = [b for b in (babble or ())
                 if b["t1"] > t0 - 0.05 and b["t0"] < t1 + 0.05]
        if dur < min_len and not heard and not heard_txt:
            continue
        star = sum(max(0.0, min(t1, s.t1) - max(t0, s.t0)) for s in stars)
        conf = min(0.95, 0.35 + 0.25 * min(dur / 1.5, 1.0) + 0.4 * c
                   + (0.1 if star > 0.1 else 0.0))
        ev = {"len_s": round(dur, 2), "voiced": round(c, 2),
              "star_s": round(star, 2),
              "опоздание": max((late_by.get((a, b), 0.0) for a, b, *_ in runs
                                if b > t0 and a < t1), default=0.0),
              "похоже_на_текст": max((float(x.get("local_sim", 0.0))
                                      for x in heard), default=0.0)}
        txt = "".join(b["heard"] for b in heard) or heard_txt
        if txt:
            ev["звучит"] = txt
        out.append((t0, t1, conf, ev))
    return out


def from_misreads(misreads: list[dict]) -> list[tuple]:
    """Приговоры сверки правдоподобий → срабатывания.

    Класс различается по тому, кто виноват. Опечатка сценария — это тоже
    находка, её пользователь захочет увидеть, но чинится она правкой текста, а
    не перегенерацией, поэтому смешивать их в одну кучу нельзя.
    """
    out = []
    for m in misreads:
        if m["kind"] == "extra":
            continue                    # лишний звук идёт по каналу вставок
        cls = "script_typo" if m["blame"] == "сценарий" else "misread"
        # Выигрыш в logp на символ: 0.35 — порог допуска, 3.0 и выше — очевидно.
        conf = min(0.95, 0.40 + 0.18 * (m["gain"] - 0.35))
        out.append((m["script_lo"], m["script_hi"], cls, conf, m["t0"], m["t1"],
                    {"звучит": m["heard"], "выигрыш": m["gain"],
                     "сходство": m["similarity"]}))
    return out


def _sentence_bounds(script: list[ScriptWord], word_scores: dict[int, dict]
                     ) -> list[tuple[int, float, float]]:
    """Границы предложений во времени: (номер, начало, конец)."""
    acc: dict[int, list[float]] = {}
    for w in script:
        sc = word_scores.get(w.idx)
        if sc is None:
            continue
        cur = acc.get(w.sent)
        if cur is None:
            acc[w.sent] = [sc["t0"], sc["t1"]]
        else:
            cur[0] = min(cur[0], sc["t0"])
            cur[1] = max(cur[1], sc["t1"])
    return sorted((k, v[0], v[1]) for k, v in acc.items())


def sentence_span(script: list[ScriptWord], word_scores: dict[int, dict],
                  lo: int, hi: int, duration: float,
                  audio: tuple[float, float] | None = None,
                  edge_s: float = 0.6) -> tuple[float, float]:
    """Область проигрывания: предложение, а на стыке — оба соседних.

    Полсекунды звука прослушать невозможно, нужен контекст фразы. Но выбирать
    фразу по слову сценария нельзя: у вставки своего слова нет, а сама она
    часто садится ровно на стык двух предложений. Тогда проигрывание одного из
    них не даёт понять, что произошло — половина события остаётся за краем.

    Поэтому область считается от времени: берутся все предложения, которых
    дефект касается, и добавляется соседнее, если дефект прижат к границе.
    Инвариант, который держится всегда: звук дефекта целиком внутри области.
    """
    bounds = _sentence_bounds(script, word_scores)
    if not bounds:
        return (0.0, duration) if audio is None else audio

    if audio is None:
        idx = [w.idx for w in script[lo:hi]]
        ts = [word_scores[i] for i in idx if i in word_scores]
        audio = ((min(x["t0"] for x in ts), max(x["t1"] for x in ts)) if ts
                 else (0.0, duration))
    a0, a1 = audio

    touched = [k for k, (_s, t0, t1) in enumerate(bounds)
               if t1 >= a0 - 0.05 and t0 <= a1 + 0.05]
    if not touched:
        nearest = min(range(len(bounds)),
                      key=lambda k: abs((bounds[k][1] + bounds[k][2]) / 2 - a0))
        touched = [nearest]

    first, last = touched[0], touched[-1]
    # Прижат к началу своей фразы — добавляем предыдущую; к концу — следующую.
    if a0 - bounds[first][1] < edge_s and first > 0:
        first -= 1
    if bounds[last][2] - a1 < edge_s and last < len(bounds) - 1:
        last += 1

    t0 = max(min(bounds[first][1], a0) - PLAY_PAD_S, 0.0)
    t1 = min(max(bounds[last][2], a1) + PLAY_PAD_S, duration)

    if t1 - t0 > PLAY_MAX_S:
        # Обрезаем вокруг дефекта, но так, чтобы он целиком остался внутри.
        need = a1 - a0
        room = max(PLAY_MAX_S - need, 1.0)
        t0 = max(a0 - room / 2, t0)
        t1 = min(max(t0 + PLAY_MAX_S, a1 + 0.3), duration)
    return t0, t1


def _context(script: list[ScriptWord], lo: int, hi: int, n: int = 4) -> tuple[str, str]:
    before = " ".join(w.raw for w in script[max(lo - n, 0):lo])
    after = " ".join(w.raw for w in script[hi:hi + n])
    return before, after


def assemble(script: list[ScriptWord], word_scores: dict[int, dict],
             missing, truncation, corrupt, inserts, duration: float,
             misreads=(), budget_per_10min: int = 40
             ) -> tuple[list[Defect], list[Defect]]:
    """Пословные срабатывания → спаны, затем отбор по бюджету."""
    cands: list[Defect] = []
    n = 0

    def add(cls, conf, words, audio, ev):
        nonlocal n
        lo, hi = words
        text = " ".join(w.raw for w in script[lo:hi])
        cb, ca = _context(script, lo, hi)
        play = sentence_span(script, word_scores, lo, max(hi, lo + 1), duration,
                             audio=audio)
        if play[1] <= play[0] or play[0] > audio[0] or play[1] < audio[1]:
            play = (max(audio[0] - 1.0, 0.0), min(audio[1] + 1.0, duration))
        n += 1
        cands.append(Defect(f"d{n:03}", cls, "glance", round(conf, 3),
                            (lo, hi), audio, text, play, cb, ca, ev))

    if truncation:
        k, conf = truncation
        last_t = max((sc["t1"] for sc in word_scores.values()), default=duration)
        add("truncation", conf, (k, len(script)), (max(last_t - 1.0, 0.0), duration),
            {"не произнесено слов": len(script) - k})

    trunc_lo = truncation[0] if truncation else len(script)
    for group in _group_words([m for m in missing if m[0] < trunc_lo]):
        lo, hi, conf = group
        t0, t1 = _word_time(word_scores, lo, hi, script, duration)
        add("missing", conf, (lo, hi), (t0, t1), {"слов": hi - lo})

    for group in _group_words([(w, c) for w, c, _ in corrupt]):
        lo, hi, conf = group
        t0, t1 = _word_time(word_scores, lo, hi, script, duration)
        ev = {}
        for w, _c, e in corrupt:
            if lo <= w < hi:
                ev.update(e)
        add("corrupt", conf, (lo, hi), (t0, t1), ev)

    for lo, hi, cls, conf, t0, t1, ev in misreads:
        add(cls, conf, (lo, hi), (max(t0 - 0.15, 0.0), min(t1 + 0.15, duration)), ev)

    for t0, t1, conf, ev in inserts:
        lo = _word_at(word_scores, t0)
        add("insert", conf, (lo, lo), (max(t0 - 0.20, 0.0), min(t1 + 0.25, duration)), ev)

    cands = _dedup(cands)
    cands.sort(key=lambda d: -d.confidence)
    quota = max(int(round(budget_per_10min * duration / 600)), 3)
    kept: list[Defect] = []
    dropped: list[Defect] = []
    for d in cands:
        # Бюджет обходят только катастрофы. Планка 1.0 с оказалась слишком
        # низкой: на реальном материале почти каждая вставка её проходит, и
        # бюджет переставал работать вовсе.
        forced = d.cls == "truncation" or (d.cls == "insert" and
                                           d.audio[1] - d.audio[0] >= 2.0)
        if forced or (len(kept) < quota and d.confidence >= GLANCE):
            d.tier = "must-review" if d.confidence >= MUST_REVIEW else "glance"
            kept.append(d)
        else:
            d.tier = "suppressed"
            dropped.append(d)
    kept.sort(key=lambda d: d.audio[0])
    return kept, dropped


# Чем класс полезнее пользователю: тот, кто говорит «написано X, звучит Y»,
# даёт готовое действие; «вставка без текста» — только координату.
_CLASS_RANK = {"truncation": 0, "misread": 1, "script_typo": 2, "insert": 3,
               "missing": 4, "corrupt": 5, "stress": 6, "region_fail": 7}


def _dedup(cands: list[Defect], gap: float = 0.30) -> list[Defect]:
    """Одно место — один флаг.

    Каналы намеренно перекрываются: пропущенное слово видно и по пустому
    выравниванию, и по провалу уверенности, и по непокрытому звуку рядом.
    Это хорошо для полноты и плохо для чтения: пользователь получает три
    отметки об одном и том же и трижды слушает одно место.

    Побеждает самый информативный класс, а улики остальных переезжают к нему —
    так ничего не теряется.
    """
    if not cands:
        return []
    order = sorted(cands, key=lambda d: (d.audio[0], d.audio[1]))
    groups: list[list[Defect]] = [[order[0]]]
    for d in order[1:]:
        last = groups[-1]
        end = max(x.audio[1] for x in last)
        start = min(x.audio[0] for x in last)
        if d.audio[0] <= end + gap and d.audio[1] >= start - gap:
            last.append(d)
        else:
            groups.append([d])

    out: list[Defect] = []
    for g in groups:
        g.sort(key=lambda d: (_CLASS_RANK.get(d.cls, 9), -d.confidence))
        head = g[0]
        for other in g[1:]:
            head.confidence = max(head.confidence, other.confidence)
            for k, v in other.evidence.items():
                head.evidence.setdefault(f"{other.cls}:{k}" if k in head.evidence
                                         else k, v)
            head.audio = (min(head.audio[0], other.audio[0]),
                          max(head.audio[1], other.audio[1]))
        if len(g) > 1:
            head.evidence["каналов"] = len(g)
        out.append(head)
    return out


def _group_words(hits: list[tuple[int, float]], max_gap: int = 1
                 ) -> list[tuple[int, int, float]]:
    if not hits:
        return []
    hits = sorted(hits)
    out: list[list] = [[hits[0][0], hits[0][0] + 1, hits[0][1]]]
    for w, c in hits[1:]:
        if w - out[-1][1] <= max_gap:
            out[-1][1] = w + 1
            out[-1][2] = max(out[-1][2], c)
        else:
            out.append([w, w + 1, c])
    return [(a, b, c) for a, b, c in out]


def _word_time(word_scores, lo, hi, script, duration) -> tuple[float, float]:
    ts = [word_scores[w] for w in range(lo, hi) if w in word_scores]
    if ts:
        return max(min(s["t0"] for s in ts) - 0.20, 0.0), \
               min(max(s["t1"] for s in ts) + 0.25, duration)
    # Слово не выровнено вовсе: опираемся на ближайшего выровненного соседа
    # слева, а если его нет — справа. Ноль тут был бы враньём: пропуск
    # посреди файла показывался бы на нулевой секунде.
    left = [word_scores[w]["t1"] for w in range(lo - 1, -1, -1) if w in word_scores]
    if left:
        t = left[0]
        return max(t - 0.20, 0.0), min(t + 0.6, duration)
    right = [word_scores[w]["t0"] for w in range(hi, len(script)) if w in word_scores]
    t = right[0] if right else 0.0
    return max(t - 0.4, 0.0), min(t + 0.2, duration)


def _word_at(word_scores: dict[int, dict], t: float) -> int:
    """Слово сценария, после которого звучит момент t.

    Берётся последнее по ВРЕМЕНИ, а не с наибольшим индексом: одно плохо
    выровненное слово с большим индексом и малым t1 иначе притягивает к себе
    все вставки файла, и они все показываются в одном и том же месте текста.
    """
    prev = [(s["t1"], w) for w, s in word_scores.items() if s["t1"] <= t]
    return max(prev)[1] + 1 if prev else 0
