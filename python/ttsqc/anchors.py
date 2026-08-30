"""Заякоривание сценария на аудио через свободный ASR.

Главное архитектурное правило проекта:

    ASR-дифф никогда не выдаёт дефект. Он только предлагает зоны.

WER Whisper на этом материале 3–6%, и если считать дефектом каждое его
расхождение со сценарием, выдачу затопит. Авторитет по `missing` и `corrupt` —
CTC-проход, авторитет по `insert` — VAD плюс star-токен. Здесь мы только
режем файл на участки, внутри которых выравниванию можно доверять.

Якоря ищутся не полным динамическим программированием, а seed-and-extend:
якорь по определению — длинная серия точных совпадений, а такие серии
находятся за линейное время по индексу k-грамм. Полное аффинное выравнивание
гоняется потом, но уже внутри зон, где оно дёшево и не может уехать лавиной.
"""
from __future__ import annotations

import math
from collections import defaultdict

from .schema import Anchor, AsrWord, Region, ScriptWord

SEED_K = 4     # длина k-граммы для затравки; совпадает с min_run по смыслу
LONG_RUN = 8   # серия такой длины не может совпасть случайно


def _seed_index(words: list[str], k: int) -> dict[tuple[str, ...], list[int]]:
    idx: dict[tuple[str, ...], list[int]] = defaultdict(list)
    for i in range(len(words) - k + 1):
        idx[tuple(words[i:i + k])].append(i)
    return idx


def _extend(a: list[str], b: list[str], i: int, j: int, k: int) -> tuple[int, int, int]:
    """Расширить затравку (i, j) длины k влево и вправо по точным совпадениям."""
    lo_a, lo_b = i, j
    while lo_a > 0 and lo_b > 0 and a[lo_a - 1] == b[lo_b - 1]:
        lo_a -= 1
        lo_b -= 1
    hi_a, hi_b = i + k, j + k
    while hi_a < len(a) and hi_b < len(b) and a[hi_a] == b[hi_b]:
        hi_a += 1
        hi_b += 1
    return lo_a, lo_b, hi_a - lo_a


def _split_at_gaps(asr: list[AsrWord], s_lo: int, a_lo: int, n: int,
                   max_gap: float) -> list[tuple[int, int, int]]:
    """Разделить серию по внутренним паузам, а не отбрасывать её из-за них.

    Пауза в 2.66 с между предложениями — нормальная начитка, а не признак
    плохого якоря. Отбрасывать из-за неё серию из 71 точного совпадения
    означает потерять единственный надёжный участок файла; деление даёт два
    хороших якоря вместо нуля и заодно более точную привязку ко времени.
    """
    cuts = [0]
    for t in range(1, n):
        if asr[a_lo + t].start - asr[a_lo + t - 1].end > max_gap:
            cuts.append(t)
    cuts.append(n)
    return [(s_lo + u, a_lo + u, v - u) for u, v in zip(cuts, cuts[1:]) if v > u]


def _passes_guards(script: list[ScriptWord], asr: list[AsrWord],
                   s_lo: int, a_lo: int, n: int, cfg: dict) -> bool:
    """Оговорки поверх длины серии, масштабированные по самой длине.

    Голая длина 4 на служебных словах («и в на с») совпадает случайно, и такой
    якорь ставит зону не туда — ошибка заякоривания дороже пропущенного якоря,
    потому что уводит всё выравнивание дальше по файлу. Но случайное точное
    совпадение восьми слов подряд невозможно, поэтому длинная серия проходит
    по длине и без остальных проверок.

    Порог по вероятности берётся от медианы, а не от минимума: одно слово с
    низкой оценкой внутри безупречной серии — свойство оценки, а не серии.
    """
    if n < cfg["min_run"]:
        return False
    win = asr[a_lo:a_lo + n]
    if n >= LONG_RUN:
        return True
    probs = sorted(w.probability for w in win)
    if probs[len(probs) // 2] < cfg["min_word_prob"]:
        return False
    long_words = sum(1 for w in win if len(w.norm) >= cfg["min_long_word_chars"])
    if long_words < cfg["min_long_words"]:
        return False
    return win[-1].end - win[0].start >= cfg["min_duration_s"]


def find_candidates(script: list[ScriptWord], asr: list[AsrWord],
                    cfg: dict) -> list[Anchor]:
    a = [w.match for w in script]
    b = [w.norm for w in asr]
    k = max(2, min(SEED_K, cfg["min_run"]))
    if len(a) < k or len(b) < k:
        return []

    index = _seed_index(a, k)
    seen: set[tuple[int, int, int]] = set()
    out: list[Anchor] = []
    j = 0
    while j <= len(b) - k:
        gram = tuple(b[j:j + k])
        for i in index.get(gram, ()):
            run = _extend(a, b, i, j, k)
            if run in seen:
                continue
            seen.add(run)
            for s_lo, a_lo, n in _split_at_gaps(asr, *run, cfg["max_internal_gap_s"]):
                if _passes_guards(script, asr, s_lo, a_lo, n, cfg):
                    out.append(Anchor(script_lo=s_lo, script_hi=s_lo + n,
                                      asr_lo=a_lo, asr_hi=a_lo + n,
                                      t0=asr[a_lo].start, t1=asr[a_lo + n - 1].end))
        j += 1
    return out


def _rate_penalty(script: list[ScriptWord], prev: Anchor, cur: Anchor,
                  cfg: dict) -> float:
    """Насколько правдоподобен переход между двумя якорями по темпу речи.

    Это не жёсткий фильтр: между якорями может лежать настоящий дефект, и
    тогда темп законно вылетает за диапазон (вставка — много аудио на мало
    текста, обрыв — наоборот). Штраф мягкий и ограничен сверху, чтобы
    настоящий дефект не разрывал цепочку якорей. Задача проверки — ловить
    мис-заякоривание на повторяющейся фразе, когда переход неправдоподобен
    грубо, а не на десятки процентов.
    """
    chars = sum(len(script[i].match) for i in range(prev.script_hi, cur.script_lo))
    gap_t = cur.t0 - prev.t1
    if gap_t < -0.05:
        return -math.inf              # немонотонно по времени — исключено
    lo, hi = cfg["rate_min_s_per_char"], cfg["rate_max_s_per_char"]
    mid = (lo + hi) / 2
    expected = max(chars * mid, 0.05)
    ratio = max(gap_t, 0.01) / expected
    if lo / mid <= ratio <= hi / mid:
        return 0.0
    dev = abs(math.log(ratio / 1.0))
    return -min(3.0, dev)


def prune(script: list[ScriptWord], cands: list[Anchor], cfg: dict) -> list[Anchor]:
    """Оставить самую тяжёлую цепочку якорей, монотонную и по тексту, и по времени.

    Взвешенная возрастающая подпоследовательность: вес якоря — длина серии,
    вес перехода — правдоподобие темпа. Именно монотонность убивает
    мис-заякоривание на повторах вроде «Прокачанные аккаунты уходят на
    западные…», которое в реальном файле звучит дважды.
    """
    if not cands:
        return []
    cands = sorted(cands, key=lambda x: (x.script_lo, x.asr_lo))
    n = len(cands)
    best = [float(c.n_words) for c in cands]
    prev = [-1] * n
    for i in range(n):
        ci = cands[i]
        for j in range(i):
            cj = cands[j]
            if cj.script_hi > ci.script_lo or cj.asr_hi > ci.asr_lo:
                continue
            pen = _rate_penalty(script, cj, ci, cfg)
            if pen == -math.inf:
                continue
            cand = best[j] + ci.n_words + pen
            if cand > best[i]:
                best[i] = cand
                prev[i] = j
    end = max(range(n), key=lambda i: best[i])
    chain: list[Anchor] = []
    while end != -1:
        chain.append(cands[end])
        end = prev[end]
    return list(reversed(chain))


def build_regions(script: list[ScriptWord], asr: list[AsrWord],
                  anchors: list[Anchor], duration: float, cfg: dict) -> list[Region]:
    """Сплошное покрытие файла зонами: и заякоренные участки, и промежутки.

    Якоря задают границы отрезков, а не право пропускать их. Гонять CTC только
    по межъякорным дыркам означало бы разбирать ровно дефектные места и не
    смотреть на остальные 85% файла — а `corrupt` живёт как раз внутри
    заякоренного текста: «самоваор» свободный ASR нормализует обратно в
    «самовар», серия точных совпадений не рвётся, и слово попадает в якорь.

    Промежуточные зоны прихватывают по паре слов от соседних якорей как
    «ручки»: без них star-токен на краю зоны съедает первое настоящее слово.
    Эти слова выравниваются дважды; при сборке побеждает надёжная зона.
    """
    pad = cfg["region_pad_s"]
    h = cfg["region_handle_words"]
    out: list[Region] = []

    if not anchors:
        return [Region(0, len(script), 0.0, duration, True, True, False,
                       "якорей не найдено")]

    def gap(s_lo: int, s_hi: int, t0: float, t1: float,
            star_l: bool, star_r: bool) -> None:
        s_lo, s_hi = max(s_lo, 0), min(s_hi, len(script))
        t0, t1 = max(t0, 0.0), min(t1, duration)
        if s_hi > s_lo and t1 - t0 > 0.02:
            out.append(Region(s_lo, s_hi, t0, t1, star_l, star_r, False, "промежуток"))

    target = cfg["region_target_s"]

    def emit_anchor(a: Anchor) -> None:
        """Якорь режется на куски по границам слов ASR, а не пополам по тексту.

        Внутри якоря соответствие «слово сценария ↔ слово ASR» точное — они
        совпали посимвольно, — поэтому точка разреза известна, а не угадывается.
        Куски остаются надёжными: длина зоны ограничивается ради того, чтобы
        star-токену было меньше свободы, а не потому что участок сомнителен.
        """
        lo, t_lo = a.script_lo, a.t0
        for k in range(a.script_lo, a.script_hi):
            j = a.asr_lo + (k - a.script_lo)
            t_end = asr[j].end
            is_last = k == a.script_hi - 1
            if t_end - t_lo >= target or is_last:
                out.append(Region(lo, k + 1, t_lo, t_end, False, False, True, "якорь"))
                lo, t_lo = k + 1, t_end
        if lo < a.script_hi:
            out.append(Region(lo, a.script_hi, t_lo, a.t1, False, False, True, "якорь"))

    first = anchors[0]
    if first.script_lo > 0 or first.t0 > 0.05:
        gap(0, first.script_lo + h, 0.0, first.t0 + pad, True, False)

    for i, a in enumerate(anchors):
        emit_anchor(a)
        if i + 1 < len(anchors):
            nxt = anchors[i + 1]
            gap(a.script_hi - h, nxt.script_lo + h, a.t1 - pad, nxt.t0 + pad,
                False, False)

    last = anchors[-1]
    if last.script_hi < len(script) or duration - last.t1 > 0.05:
        gap(last.script_hi - h, len(script), last.t1 - pad, duration, False, True)

    return sorted(out, key=lambda r: (r.t0, r.script_lo))


def coverage(anchors: list[Anchor], n_script: int) -> float:
    return sum(a.n_words for a in anchors) / max(n_script, 1)
