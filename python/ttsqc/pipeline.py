"""Связка стадий: аудио + сценарий → выровненные символы и интервалы star."""
from __future__ import annotations

import numpy as np
import torch

from . import anchors as A
from . import babble as BAB
from . import asr as ASR
from . import ctc, io_audio
from .normalize import normalize_script
from .schema import CharAlign, Region, ScriptWord, StarSpan


class Aligned:
    def __init__(self) -> None:
        self.chars: list[CharAlign] = []
        self.stars: list[StarSpan] = []        # проход B: измерение вставки
        self.stars_a: list[StarSpan] = []      # проход A: законное покрытие
                                               # (края зон и слова, которые
                                               # нечем озвучить)
        self.regions: list[Region] = []
        self.script: list[ScriptWord] = []
        self.duration: float = 0.0
        self.anchor_coverage: float = 0.0
        self.speech_p = None            # покадровые вероятности речи Silero
        self.audio = None               # 16 кГц, нужен сигналам S3/S6
        self.word_reliable: dict[int, bool] = {}
        self.asr_words: list = []
        self.misreads: list = []
        self.babble: list = []          # лишний звук по жадному декоду
        self.greedy: list = []          # (символ, t0, t1) — что слышит модель
        self.misheard: list = []        # искажения внутри слова

    @property
    def trust(self) -> float:
        """Доля слов сценария, выровненных внутри надёжных зон.

        Если она низкая, инструмент обязан сказать, что выдаче доверять нельзя,
        а не выдавать уверенно выглядящий список.
        """
        if not self.script:
            return 0.0
        return sum(1 for v in self.word_reliable.values() if v) / len(self.script)


def _region_audio(audio: np.ndarray, r: Region, sr: int) -> np.ndarray:
    return audio[max(int(r.t0 * sr), 0):min(int(r.t1 * sr), len(audio))]


def _split_long(regions: list[Region], speech_p: np.ndarray, cfg: dict) -> list[Region]:
    """Дробление слишком длинных зон по самой глубокой паузе.

    Связывает не VRAM, а качество: чем длиннее зона, тем больше свободы у
    star-токена, и тем легче он съедает настоящие слова.
    """
    hop = 512 / 16000.0
    out: list[Region] = []
    queue = list(regions)
    while queue:
        r = queue.pop(0)
        if r.reliable or r.duration <= cfg["region_max_s"] or r.script_hi - r.script_lo < 4:
            out.append(r)
            continue
        i0, i1 = int(r.t0 / hop), int(r.t1 / hop)
        inner = speech_p[i0 + int(2.0 / hop): max(i1 - int(2.0 / hop), i0 + 1)]
        if inner.size < 4:
            r.reliable = False
            r.note = "длинная зона без внутренней паузы"
            out.append(r)
            continue
        cut_t = r.t0 + 2.0 + float(np.argmin(inner)) * hop
        mid = (r.script_lo + r.script_hi) // 2   # текст делим пополам: точнее нечем
        left = Region(r.script_lo, mid, r.t0, cut_t, r.star_left, True, False,
                      "дробление длинной зоны")
        right = Region(mid, r.script_hi, cut_t, r.t1, True, r.star_right, False,
                       "дробление длинной зоны")
        queue[:0] = [left, right]
    return out


def align_file(audio_path: str, script_path: str, cfg, device: str = "cuda") -> Aligned:
    res = Aligned()
    sr = cfg["audio"]["sr"]
    audio = io_audio.decode(audio_path, sr)
    res.duration = len(audio) / sr
    res.script = normalize_script(open(script_path, encoding="utf-8").read())

    asr_words, _speech = ASR.transcribe(audio, cfg["asr"])
    speech_p = ASR.speech_probs(audio)
    res.speech_p = speech_p
    res.audio = audio
    res.asr_words = asr_words

    acfg = cfg["anchors"]
    cands = A.find_candidates(res.script, asr_words, acfg)
    chain = A.prune(res.script, cands, acfg)
    res.anchor_coverage = A.coverage(chain, len(res.script))
    regions = A.build_regions(res.script, asr_words, chain, res.duration, acfg)
    res.regions = _split_long(regions, speech_p, acfg)

    per_word: dict[int, tuple[bool, list[CharAlign]]] = {}
    backend = ctc.load_aligner(device, cfg["ctc"]["model"],
                               cfg["ctc"].get("backend", "wav2vec2"))
    char2id = backend.char2id
    blank = backend.blank

    # Отдельная модель на расшифровку. Разделение — вывод из замера: замена
    # выравнивателя целиком на GigaAM подняла чистоту декода, но уронила
    # точность с 75% до 50%, потому что кадр 40 мс размывает границы слов и
    # покрытие начинает течь. Каждая модель делает то, в чём сильна.
    dec_name = cfg["ctc"].get("decoder") or cfg["ctc"].get("backend", "wav2vec2")
    decoder = (backend if dec_name == cfg["ctc"].get("backend", "wav2vec2")
               else ctc.load_aligner("cpu", cfg["ctc"]["model"], dec_name))
    id2char = {v: k for k, v in char2id.items()}
    # Разделитель слов — служебная метка, а не звук; расхождения по нему дают
    # блоки вида «|||».
    skip_ids = {char2id[c] for c in ("|", " ", "-") if c in char2id}
    log_p_star = cfg["ctc"]["log_p_star"]

    for r in res.regions:
        seg = _region_audio(audio, r, sr)
        if len(seg) < 400:
            continue
        em = backend.emissions(seg)
        em_s = ctc.with_star(em, log_p_star, blank)
        star_col = em_s.shape[1] - 1
        words = [res.script[i].align_form for i in range(r.script_lo, r.script_hi)]
        frame_dt = (len(seg) / sr) / em.shape[0]

        # Проход A: star только на краях — ничего не может спрятать.
        toks_a, own_a = ctc.build_tokens(words, char2id, star_col, False,
                                         r.star_left, r.star_right, backend.space)
        path_a, logp_a = ctc.forced_align(em_s, toks_a, blank)
        chars = _collect_chars(path_a, logp_a, em_s, toks_a, own_a, r, frame_dt)
        _merge_chars(per_word, chars, r)
        res.stars_a.extend(_collect_stars(path_a, toks_a, own_a, star_col, r, frame_dt))

        # Проход B: star между словами — прямое измерение вставки.
        toks_b, own_b = ctc.build_tokens(words, char2id, star_col, True,
                                         r.star_left, r.star_right, backend.space)
        path_b, _ = ctc.forced_align(em_s, toks_b, blank)
        res.stars.extend(_collect_stars(path_b, toks_b, own_b, star_col, r, frame_dt))

        # Что модель слышит на самом деле, против того, что должно было
        # прозвучать. Обе строки символьные, обе из этой же матрицы эмиссий.
        if decoder is backend:
            dec_em, dec_dt, dec_blank, dec_map = em, frame_dt, blank, id2char
        else:
            dec_em = decoder.emissions(seg)
            dec_dt = (len(seg) / sr) / max(dec_em.shape[0], 1)
            dec_blank, dec_map = decoder.blank, decoder.id2char
        greedy = ctc.greedy_decode(dec_em, dec_blank)
        res.greedy.extend((dec_map.get(g[0], "?"), r.t0 + g[1] * dec_dt,
                           r.t0 + g[2] * dec_dt)
                          for g in greedy if dec_map.get(g[0]) not in (" ", None))
        dec_c2i = decoder.char2id
        dec_skip = {dec_c2i[c] for c in ("|", " ", "-") if c in dec_c2i}
        expected = [dec_c2i[c] for w in words for c in w if c in dec_c2i]
        res.babble.extend(BAB.find_blocks(
            greedy, expected, dec_map, r.t0, dec_dt,
            region_dur=len(seg) / sr, skip_ids=dec_skip,
            # Открытый край — только там, где стоит star: начало и конец файла
            # либо зона без якоря с этой стороны.
            guard_left=0.40 if r.star_left else 0.10,
            guard_right=0.40 if r.star_right else 0.10))

    from . import misread as MR
    cands = MR.propose(res.script, asr_words)
    align_forms = {w.idx: w.align_form for w in res.script}
    res.misreads = MR.adjudicate(backend, char2id, audio, sr, device,
                                 cands, align_forms)

    if decoder is not backend:
        decoder.release()
    backend.release()
    res.word_reliable = {w: rel for w, (rel, _cs) in per_word.items()}
    res.chars = [c for _w, (_rel, cs) in sorted(per_word.items()) for c in cs]
    res.chars.sort(key=lambda c: (c.script_word, c.t0))
    return res


def _merge_chars(per_word: dict, chars: list[CharAlign], r: Region) -> None:
    """Слово-«ручка» выравнивается дважды; побеждает надёжная зона.

    Промежуточные зоны намеренно захватывают по паре слов от соседних якорей,
    иначе star на краю зоны съедает первое настоящее слово. Расплата —
    дубликаты, и разрешать их надо в пользу заякоренного участка, где
    выравниванию есть на что опереться.
    """
    grouped: dict[int, list[CharAlign]] = {}
    for c in chars:
        grouped.setdefault(c.script_word, []).append(c)
    for w, cs in grouped.items():
        prev = per_word.get(w)
        if prev is None or (r.reliable and not prev[0]):
            per_word[w] = (r.reliable, cs)


def _collect_chars(path, logp, em, tokens, owner, r: Region,
                   dt: float) -> list[CharAlign]:
    """Кадры → символы: пик апостериорной вероятности, отрыв, занятость.

    Символ, которому путь не отдал ни одного кадра, всё равно попадает в
    выдачу с occupancy=0: вырожденный обход сам по себе сигнал (так выглядит
    проглоченный звук), и молча терять его нельзя.
    """
    by_tok: dict[int, list[int]] = {}
    for t, k in enumerate(path):
        k = int(k)
        if k >= 0:
            by_tok.setdefault(k, []).append(t)

    out: list[CharAlign] = []
    last_t = r.t0          # не 0.0: символ без кадров в середине файла иначе
                           # приезжает с нулевым таймкодом
    for k, (wi, _ci, ch) in enumerate(owner):
        if wi < 0:
            continue
        frames = by_tok.get(k)
        if not frames:
            out.append(CharAlign(ch, r.script_lo + wi, last_t, last_t,
                                 peak=float("-inf"), margin=0.0, occupancy=0))
            continue
        peak_t = max(frames, key=lambda t: logp[t])
        row = em[peak_t]
        top2 = torch.topk(row, 2).values
        best_other = float(top2[1] if int(torch.argmax(row)) == tokens[k] else top2[0])
        last_t = r.t0 + (frames[-1] + 1) * dt
        out.append(CharAlign(
            char=ch,
            script_word=r.script_lo + wi,
            t0=r.t0 + frames[0] * dt,
            t1=last_t,
            peak=float(logp[peak_t]),
            margin=float(logp[peak_t]) - best_other,
            occupancy=len(frames),
        ))
    return out


def _collect_stars(path, tokens, owner, star_col: int, r: Region,
                   dt: float) -> list[StarSpan]:
    out: list[StarSpan] = []
    run_k, run_t0 = None, 0
    for t in range(len(path) + 1):
        k = int(path[t]) if t < len(path) else -2
        is_star = k >= 0 and tokens[k] == star_col
        if is_star and run_k == k:
            continue
        if run_k is not None:
            n = t - run_t0
            if n > 0:
                after = next((owner[j][0] for j in range(run_k, -1, -1)
                              if owner[j][0] >= 0), -1)
                out.append(StarSpan(r.t0 + run_t0 * dt, r.t0 + t * dt,
                                    r.script_lo + after if after >= 0 else r.script_lo,
                                    n))
            run_k = None
        if is_star:
            run_k, run_t0 = k, t
    return out
