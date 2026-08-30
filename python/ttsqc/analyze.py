"""Полный проход: аудио + сценарий → список дефектов."""
from __future__ import annotations

import numpy as np

from pathlib import Path

from . import babble as BAB
from . import fusion, pipeline, signals_ctc as S12, signals_dsp as S6, signals_vad as S3


def S6_babble_blocks(al, windows, word_scores) -> list[dict]:
    blocks = BAB.drop_windows(al.babble, windows)
    blocks = BAB.merge(blocks)
    blocks = BAB.keep_voiced(blocks, al.speech_p, S3.VAD_HOP)
    # Похожесть на соседний текст сохраняется как признак, а не служит
    # приговором: раньше здесь терялись настоящие находки.
    return BAB.drop_coarticulation(blocks, al.script, word_scores, mark_only=True)
from .schema import AnalysisResult


from .paths import CORPUS_CAL, SCORER


def _rescore(defects: list, al=None, cfg=None, device: str = "cuda") -> None:
    """Пересчитать уверенность обученной моделью.

    Правила остаются структурой: они решают, ЧТО вообще стало кандидатом и к
    какому классу относится. Обученная модель решает НАСКОЛЬКО этому верить —
    то есть ровно ту часть, которую до сих пор я выставлял руками по десятку
    коэффициентов и не мог согласовать между собой.
    """
    if not SCORER.exists() or not defects:
        return
    try:
        import numpy as _np

        from . import train
        model, comp = train.load(str(SCORER))
        X = _np.vstack([train.featurize(d.to_json()) for d in defects])
        if comp is not None and al is not None:
            # Тот же замороженный энкодер, что и при обучении: модель видит не
            # только пересказ звука числами, но и сам звук.
            from . import ctc
            from .audiofeat import embed_spans
            backend = ctc.load_aligner(device, cfg["ctc"]["model"], "wav2vec2")
            try:
                E = embed_spans(al.audio, [tuple(d.audio) for d in defects],
                                backend, cfg["audio"]["sr"])
            finally:
                backend.release()
            X = _np.hstack([X, comp.transform(E)])
        p = model.predict_proba(X)[:, 1]
    except Exception:
        return                      # нет модели или сломана — остаёмся на правилах
    for d, prob in zip(defects, p):
        d.evidence["правило"] = d.confidence
        d.confidence = round(float(prob), 3)


def analyze(audio_path: str, script_path: str, cfg, device: str = "cuda",
            calibration: S12.Calibration | None = None,
            max_flags: int = 40,
            min_confidence: float = 0.0) -> AnalysisResult:
    al = pipeline.align_file(audio_path, script_path, cfg, device)

    cal = calibration
    if cal is None and CORPUS_CAL.exists():
        # Норма по чужим дублям того же голоса. Без неё оценка сигнала — это
        # процентиль внутри разбираемого файла, а он по построению не умеет
        # сказать «этот файл хуже обычного»: порог «худшие 0.3%» пропустит
        # ровно 0.3% слов и в чистом файле, и в разваленном.
        from . import calibrate
        cal = calibrate.load(str(CORPUS_CAL))
    if cal is None:
        # Пока корпусных таблиц нет, статистики берутся из самого файла.
        # Оценки робастные (медиана и MAD), поэтому дефекты, которых по
        # определению меньшинство, свою же норму не сдвигают.
        cal = S12.Calibration.from_samples(S12.harvest(al.chars))

    word_scores = S12.score_words(al.chars, cal)
    # Длительность на символ считаем по СПАНУ слова, а не по кадрам,
    # назначенным символу: между символами лежат blank-кадры, и сравнивать
    # span слова с суммой назначенных кадров — сравнивать разные величины.
    per_char = [(sc["t1"] - sc["t0"]) / sc["n_chars"]
                for sc in word_scores.values() if sc["n_chars"] > 2]
    median_char_s = float(np.median(per_char)) if per_char else 0.06

    windows = S3.unalignable_windows(al.script, al.chars, al.duration)
    # Абракадабра из расхождения жадного декода с ожидаемой строкой.
    bab = S6_babble_blocks(al, windows, word_scores)
    runs = S3.merge_runs(S3.uncovered_runs(
        al.speech_p, al.chars, al.duration,
        legit_stars=al.stars_a, legit_windows=windows))
    local_rms = float(np.sqrt(np.mean(al.audio ** 2)))
    speech_runs, echoes = [], 0
    for t0, t1 in runs:
        dur = t1 - t0
        prof = S3.voicing_profile(al.audio, t0, t1)
        kind, conf = S3.classify_merged(prof, local_rms, dur)
        if kind != "speech":
            continue
        near = fusion._word_at(word_scores, t0)
        # Проверка на кратность заменена: она спрашивала «есть ли услышанные
        # слова в соседнем тексте», а ответ там почти всегда «да», и из-за
        # этого терялись настоящие находки — шесть пропущенных дефектов из
        # разметки пользователя лежали ровно в отброшенных ею прогонах.
        #
        # Вопрос задаётся точнее: что жадный декод слышит на этом отрезке.
        # Если выравниватель просто опоздал с границей, там лежит начало
        # соседнего слова. Если абракадабра — что-то другое.
        heard = BAB.transcribe_span(al.greedy, t0, t1)
        yield_ratio = BAB.low_char_yield(heard, dur)
        late = BAB.is_late_onset(heard, al.script, near)
        if late:
            echoes += 1
        if yield_ratio < BAB.LOW_YIELD:
            conf = max(conf, 0.55 + 0.3 * (1.0 - yield_ratio / BAB.LOW_YIELD))
            heard = heard or f"неразборчиво {dur * 1000:.0f} мс"
        elif late:
            conf *= 0.5
        # Кандидат не выбрасывается: признак «похоже на опоздание границы»
        # уходит в оценку и там взвешивается вместе с остальными. Жёсткий
        # отсев здесь был бы потолком полноты, который никакой разметкой не
        # поднять — модель учится только на том, что ей показали, а
        # выброшенное она не увидит никогда.
        speech_runs.append((t0, t1, min(conf, 0.95), heard, 1.0 if late else 0.0))

    mel = S6.logmel(al.audio)
    loops = S6.loop_runs(mel)
    intraword = S6.intraword_silence(al.audio, al.chars)

    missing = fusion.find_missing(al.script, word_scores, median_char_s)
    truncation = fusion.find_truncation(al.script, word_scores, missing, al.duration)
    corrupt = fusion.find_corrupt(word_scores, al.word_reliable, loops, intraword)
    # Искажения внутри слова по жадному декоду. Свободный распознаватель их
    # чинит — его языковая модель тянет звук к ближайшему настоящему слову, —
    # поэтому «конкретного», прочитанное как «конерентного», видно только здесь.
    al.misheard = BAB.misheard_words(al.greedy, al.script, word_scores)
    corrupt += fusion.from_misheard(al.misheard)
    inserts = fusion.find_insert(speech_runs, al.stars, babble=bab)

    mis = fusion.from_misreads(al.misreads)
    # Кандидаты «звук есть, текста нет» из ASR-диффа шли в никуда: propose их
    # находил, а from_misreads молча выбрасывал. Заводим в канал вставок.
    for m in al.misreads:
        if m["kind"] == "extra":
            speech_runs.append((m["t0"], m["t1"], 0.9,
                                BAB.transcribe_span(al.greedy, m["t0"], m["t1"]), 0.0))
    kept, dropped = fusion.assemble(al.script, word_scores, missing, truncation,
                                    corrupt, inserts, al.duration, misreads=mis,
                                    budget_per_10min=max_flags)

    _rescore(kept + dropped, al, cfg, device)

    # Один список, упорядоченный обученной оценкой.
    #
    # Раньше здесь стояло ручное разделение по классам: канал заикания
    # выносился во второй список целиком, потому что давал 13% точности.
    # Это был костыль вместо ранжирования — он отправлял вниз и те три
    # находки из двадцати трёх, которые были настоящими.
    #
    # Обученная оценка ранжирует точнее любого правила по классу: те же самые
    # ложные срабатывания она сама кладёт на 0.01–0.06, а настоящие заикания
    # поднимает. Поэтому деление осталось только там, где отличается ДЕЙСТВИЕ:
    # опечатка в сценарии чинится правкой текста, а не перегенерацией.
    kept = [d for d in kept + dropped if d.confidence >= min_confidence]
    kept.sort(key=lambda d: -d.confidence)
    for d in kept:
        d.tier = "must-review" if d.confidence >= 0.70 else "glance"
    mismatches = [d for d in kept if d.cls == "script_typo"]
    kept = [d for d in kept if d.cls != "script_typo"]
    dropped = []

    res = AnalysisResult(
        audio_path=audio_path, script_path=script_path, duration=al.duration,
        script_words=al.script, regions=al.regions, defects=kept,
        suppressed=dropped, text_mismatches=mismatches, trust=al.trust,
        stats={
            "anchor_coverage": round(al.anchor_coverage, 4),
            "chars_aligned": len(al.chars),
            "chars_empty": sum(1 for c in al.chars if c.occupancy == 0),
            "star_s": round(sum(s.t1 - s.t0 for s in al.stars), 2),
            "speech_runs": len(speech_runs),
            "echo_filtered": echoes,
            "unalignable_windows": len(windows),
            "misread_candidates": len(al.misreads),
            "babble_raw": len(al.babble),
            "babble_kept": len(bab),
            "misheard_words": len(al.misheard),
            "late_onset_filtered": echoes,
            "loops": len(loops),
            "intraword_silence": len(intraword),
            "median_char_s": round(median_char_s, 4),
        },
    )
    res.aligned = al
    res.word_scores = word_scores
    return res
