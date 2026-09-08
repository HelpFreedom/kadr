#!/usr/bin/env python3.11
"""Мост между Kadr и ttsqc (python/ttsqc).

Пакет ttsqc перенесён в репозиторий целиком, а вся склейка с редактором живёт
здесь — так копию пакета можно пересинхронизировать с оригиналом, не разбирая
чужие правки.

Протокол — NDJSON построчно в stdout, как у scripts/transcribe.py: по объекту
на строку, поле "type" разводит их, ошибки идут в stderr и сопровождаются
ненулевым кодом возврата.

Команды:
  --selftest        проверить окружение и выйти (один объект type=selftest)
  check             разобрать озвучку: дефекты + границы фраз к перегенерации
  phrase-at         посчитать фразу вокруг времени по готовому разбору —
                    для маркера, который пользователь поставил сам. Модели не
                    запускаются: хватает phrase-index.json и копии звука.
  learn             переобучить оценку уверенности на накопленных вердиктах

Строки check: {"type":"progress"|"sentences"|"defect"|"done"|"error"}.
"""
from __future__ import annotations

import argparse
import json
import os
import hashlib
import shutil
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
PKG_HOME = REPO / "python"

# Кэш декодированного звука по умолчанию уводим из репозитория: он растёт
# примерно на 3.8 МБ за минуту 16 кГц, а свободного места на этой машине мало.
os.environ.setdefault("KADR_TTSQC_CACHE",
                      str(Path.home() / ".cache" / "kadr" / "ttsqc"))
if str(PKG_HOME) not in sys.path:
    sys.path.insert(0, str(PKG_HOME))


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _binary(name: str) -> dict:
    path = shutil.which(name)
    if not path:
        return {"ok": False, "error": f"{name} не найден в PATH"}
    try:
        out = subprocess.run([path, "-version"], capture_output=True, text=True,
                             timeout=10).stdout.splitlines()
        return {"ok": True, "path": path, "version": out[0] if out else ""}
    except Exception as e:                                   # noqa: BLE001
        return {"ok": False, "path": path, "error": str(e)}


def selftest() -> int:
    """Всё, без чего разбор дефектов не поедет, — одним объектом.

    Отдельными полями, а не одним "ok": редактор должен уметь сказать
    «нет весов» и «нет CUDA» разными словами, иначе пользователь будет чинить
    не то. Отсутствие CUDA — не ошибка: на CPU медленно, но работает.
    """
    report: dict = {"type": "selftest", "python": sys.version.split()[0],
                    "executable": sys.executable, "pkgHome": str(PKG_HOME)}
    problems: list[str] = []

    if sys.version_info < (3, 11):
        problems.append(f"нужен python >= 3.11 (tomllib), запущен {report['python']}")

    try:
        from ttsqc import paths                              # noqa: PLC0415
        report["paths"] = {k: str(getattr(paths, k)) for k in
                           ("HOME", "MODELS", "CORPUS_CAL", "SCORER",
                            "CONFIG", "CACHE", "RUNS")}
        for key, label in (("CONFIG", "ttsqc.toml"),
                           ("CORPUS_CAL", "calibration.npz"),
                           ("SCORER", "scorer.pkl")):
            p = getattr(paths, key)
            report.setdefault("files", {})[label] = p.exists()
            # время файла модели — то, по чему видно, что «Переобучить»
            # действительно что-то сделало: число примеров при этом не меняется
            if key == "SCORER" and p.exists():
                report["scorerMtime"] = int(p.stat().st_mtime * 1000)
            # scorer необязателен: без него ttsqc честно остаётся на правилах
            if not p.exists() and key != "SCORER":
                problems.append(f"нет файла {label}: {p}")
    except Exception as e:                                   # noqa: BLE001
        problems.append(f"пакет ttsqc не импортируется: {e}")

    for mod in ("numpy", "torch", "transformers", "faster_whisper",
                "onnxruntime", "sklearn"):
        try:
            m = __import__(mod)
            report.setdefault("modules", {})[mod] = getattr(m, "__version__", "?")
        except Exception as e:                               # noqa: BLE001
            report.setdefault("modules", {})[mod] = None
            problems.append(f"нет модуля {mod}: {type(e).__name__}")

    try:
        import torch                                         # noqa: PLC0415
        report["cuda"] = {"available": bool(torch.cuda.is_available())}
        if torch.cuda.is_available():
            free, total = torch.cuda.mem_get_info()
            report["cuda"].update(name=torch.cuda.get_device_name(0),
                                  freeMb=free // 2**20, totalMb=total // 2**20)
    except Exception as e:                                   # noqa: BLE001
        report["cuda"] = {"available": False, "error": str(e)}

    report["ffmpeg"] = _binary(os.environ.get("KADR_FFMPEG", "ffmpeg"))
    report["ffprobe"] = _binary(os.environ.get("KADR_FFPROBE", "ffprobe"))
    for tool in ("ffmpeg", "ffprobe"):
        if not report[tool]["ok"]:
            problems.append(report[tool]["error"])

    report["problems"] = problems
    report["ok"] = not problems
    emit(report)
    return 0 if report["ok"] else 2



# ---------------------------------------------------------------------------
# прогресс

_PROG = {'stage': '', 'lo': 0.0, 'hi': 0.0, 'done': 0, 'total': 1}


def progress(p: float, stage: str, extra: dict | None = None) -> None:
    emit({'type': 'progress', 'p': round(max(0.0, min(1.0, p)), 4), 'stage': stage,
          **(extra or {})})


def instrument(pipeline, ctc, duration: float) -> None:
    """Прогресс без правок пакета: оборачиваем два его метода снаружи.

    Внутри analyze() никаких колбэков нет, а операция идёт минуты — молчащая
    полоса на всё это время недопустима. Оборачиваем ASR (один длинный шаг) и
    поядерный emissions() выравнивателя (их столько, сколько зон).
    """
    # Замерено: 126 вызовов emissions() на 531.6 с (≈27 зон по 20 с) и 4 вызова
    # на 2.24 с (1 зона) — то есть около пяти проходов на зону. Оценка нужна
    # только чтобы полоса ехала; при промахе она упрётся в потолок диапазона.
    region_s = 20.0                       # anchors.region_target_s по умолчанию
    _PROG['total'] = max(1, int(duration / region_s + 0.5)) * 5

    orig_transcribe = pipeline.ASR.transcribe

    def transcribe(audio, cfg, *a, **kw):
        progress(0.08, 'asr')
        out = orig_transcribe(audio, cfg, *a, **kw)
        progress(0.35, 'anchors')
        return out

    pipeline.ASR.transcribe = transcribe

    for cls_name in ('Wav2Vec2Backend', 'GigaAMBackend'):
        cls = getattr(ctc, cls_name, None)
        if cls is None or not hasattr(cls, 'emissions'):
            continue
        orig = cls.emissions

        def wrapper(self, audio, _orig=orig):
            _PROG['done'] += 1
            frac = min(1.0, _PROG['done'] / max(1, _PROG['total']))
            progress(0.35 + 0.5 * frac, 'align')
            return _orig(self, audio)

        cls.emissions = wrapper


# ---------------------------------------------------------------------------
# разбор

def _audio_copy(src: Path, run_dir: Path) -> Path:
    """Копия разбираемого звука внутри прогона, названная по СОДЕРЖИМОМУ.

    На неё будет указывать defects.json. Иначе после первой же склейки
    переобучение читало бы уже другой звук под старой разметкой — ровно та
    ошибка, из-за которой в ttsqc появился _protect.
    """
    h = hashlib.sha1(src.read_bytes()).hexdigest()[:10]
    dst = run_dir / f'{src.stem}.{h}{src.suffix}'
    if not dst.exists():
        tmp = dst.with_suffix(dst.suffix + '.part')
        shutil.copyfile(src, tmp)
        tmp.replace(dst)          # .part → готово: прерванная копия не сойдёт за кэш
    return dst


def _phrase_finder(res, KP, edge_words: int):
    al = res.aligned
    sents = [w.sent for w in res.script_words]
    word_times = {i: (float(sc['t0']), float(sc['t1']))
                  for i, sc in res.word_scores.items()
                  if sc and 't0' in sc and 't1' in sc}
    return KP.PhraseFinder(sents, word_times, res.duration,
                           audio=getattr(al, 'audio', None), sr=16000,
                           speech_p=getattr(al, 'speech_p', None),
                           edge_words=edge_words)


# знаки, которые принадлежат фразе, хотя в слово сценария не входят
CLOSERS = '.!?…,;:»”")\''
OPENERS = '«“(\'"—–-'


def expand_chars(raw: str, c0: int, c1: int) -> tuple[int, int]:
    """Дотянуть границы до знаков препинания вокруг фразы.

    ScriptWord.char_end кончается на последней букве, поэтому точка в конце
    предложения в подстроку не попадала. Для синтеза это не мелочь: без точки
    ElevenLabs читает фразу как незаконченную, и вставленный кусок звучит
    иначе, чем всё остальное. Пробелы не трогаем — иначе можно утащить начало
    соседнего предложения.
    """
    if not (0 <= c0 <= c1 <= len(raw)):
        return c0, c1
    while c1 < len(raw) and raw[c1] in CLOSERS:
        c1 += 1
    while c0 > 0 and raw[c0 - 1] in OPENERS:
        c0 -= 1
    return c0, c1


def _phrase_payload(pf, res, raw_script: str, words, audio_span) -> dict:
    ph = pf.phrase(words, audio_span)
    lo, hi = ph['wordFrom'], ph['wordTo']
    if 0 <= lo < len(res.script_words) and 0 < hi <= len(res.script_words):
        c0, c1 = expand_chars(raw_script, res.script_words[lo].char_start,
                              res.script_words[hi - 1].char_end)
    else:
        c0 = c1 = -1
    ph['charFrom'], ph['charTo'] = c0, c1
    # точная подстрока сценария, вместе с пунктуацией: по ней и синтезируем
    ph['text'] = raw_script[c0:c1] if 0 <= c0 < c1 <= len(raw_script) else ''
    return ph


def cmd_check(args) -> int:
    progress(0.01, 'load')
    from ttsqc import analyze as A, config, ctc, pipeline   # noqa: PLC0415
    import kadr_phrases as KP                               # noqa: PLC0415

    audio_path = Path(args.audio).resolve()
    script_path = Path(args.script).resolve()
    run_dir = Path(args.run_dir).resolve()
    run_dir.mkdir(parents=True, exist_ok=True)

    raw_script = script_path.read_text(encoding='utf-8')
    cfg = config.load(args.config)
    instrument(pipeline, ctc, io_duration(audio_path))

    # ключевые слова обязательны: у analyze() между device и max_flags стоит
    # calibration, и позиционный вызов молча подсунул бы туда число
    res = A.analyze(str(audio_path), str(script_path), cfg,
                    device=args.device,
                    max_flags=args.max_flags,
                    min_confidence=args.min_confidence)

    progress(0.88, 'phrases')
    pf = _phrase_finder(res, KP, args.edge_words)
    emit({'type': 'sentences',
          'bounds': [[int(s), round(t0, 3), round(t1, 3)]
                     for s, (t0, t1) in sorted(pf.sent_times.items())]})

    copy = _audio_copy(audio_path, run_dir)
    (run_dir / 'script.txt').write_text(raw_script, encoding='utf-8')

    flags = []
    for d in res.defects:
        j = d.to_json()
        j['phrase'] = _phrase_payload(pf, res, raw_script, d.words, d.audio)
        flags.append(j)
        emit({'type': 'defect', **j})

    payload = {
        'audio': str(copy),                  # копия, а не живой файл монтажа
        'source_audio': str(audio_path),
        'script': str(run_dir / 'script.txt'),
        'duration': round(res.duration, 3),
        'trust': round(res.trust, 4),
        'stats': res.stats,
        'defects': [d.to_json() for d in res.defects],
        'suppressed': [d.to_json() for d in res.suppressed],
        'text_mismatches': [d.to_json() for d in res.text_mismatches],
        'scorer': str(getattr(A, 'SCORER', '')),
        'scorer_mtime': (A.SCORER.stat().st_mtime if getattr(A, 'SCORER', None)
                         and A.SCORER.exists() else 0)
    }
    _write_json(run_dir / 'defects.json', payload)

    # всё, что нужно, чтобы позже посчитать фразу БЕЗ моделей
    # свежий разбор отменяет все переносы: копия предыдущей версии лгала бы
    (run_dir / 'phrase-index.cur.json').unlink(missing_ok=True)
    _write_json(run_dir / 'phrase-index.json', {
        'duration': round(res.duration, 3),
        'audio': str(copy),
        'sents': [int(w.sent) for w in res.script_words],
        'charRanges': [[int(w.char_start), int(w.char_end)] for w in res.script_words],
        'wordTimes': {str(i): [round(t0, 4), round(t1, 4)]
                      for i, (t0, t1) in pf.word_times.items()},
        'speechP': ([int(round(float(x) * 255)) for x in pf.speech_p]
                    if pf.speech_p is not None else [])
    })

    emit({'type': 'done', 'runDir': str(run_dir), 'audio': str(copy),
          'duration': round(res.duration, 3), 'trust': round(res.trust, 4),
          'stats': res.stats, 'defects': len(res.defects),
          'suppressed': len(res.suppressed),
          'textMismatches': len(res.text_mismatches),
          'phrases': len(flags)})
    return 0


def _pick_index(run_dir: Path, want: float) -> dict:
    """Разбор той версии звука, по которой ставят отметку.

    Разбор описывает файл таким, каким он был В МОМЕНТ ПРОВЕРКИ, а каждая
    склейка переписывает звук; `voice:reindex` кладёт рядом перенесённую копию.
    Обе живут одновременно намеренно: отмена перегенерации возвращает проект к
    исходному файлу, а индекс на диске откатить некому — по длительности видно,
    о какой версии речь. Если ни одна не подошла, честный отказ: молча посчитать
    фразу в чужих координатах значит подхватить ЧУЖОЕ предложение, а следом
    вырезать не тот кусок и испортить дорожку.
    """
    found = []
    for name in ('phrase-index.cur.json', 'phrase-index.json'):
        p = run_dir / name
        if p.exists():
            found.append(json.loads(p.read_text(encoding='utf-8')))
    if not found:
        raise SystemExit('в прогоне нет разбора — переразберите озвучку')
    if want <= 0:
        return found[0]
    for idx in found:
        if abs(float(idx['duration']) - want) <= 0.05:
            return idx
    have = ', '.join(f"{float(i['duration']):.3f}" for i in found)
    raise SystemExit(
        f"разбор относится к другой версии озвучки ({have} с против {want:.3f} с "
        "на таймлайне) — перезапустите поиск дефектов, тогда отметки снова "
        "встанут точно")


def cmd_phrase_at(args) -> int:
    """Фраза вокруг времени по готовому разбору — маркер пользователя.

    Модели не поднимаются: индекс уже посчитан, звук берётся из копии прогона.
    """
    import kadr_phrases as KP                               # noqa: PLC0415
    import numpy as np                                      # noqa: PLC0415

    run_dir = Path(args.run_dir).resolve()
    idx = _pick_index(run_dir, float(getattr(args, 'audio_duration', 0) or 0))
    script = (run_dir / 'script.txt').read_text(encoding='utf-8')

    audio = decode_mono(idx['audio'], 16000)
    speech = (np.array(idx['speechP'], dtype=np.float32) / 255.0
              if idx.get('speechP') else None)
    word_times = {int(k): tuple(v) for k, v in idx['wordTimes'].items()}
    pf = KP.PhraseFinder(idx['sents'], word_times, idx['duration'],
                         audio=audio, sr=16000, speech_p=speech,
                         edge_words=args.edge_words)

    a0, a1 = float(args.start), float(args.end)
    # у ручной отметки нет слов сценария: берём те, что она накрывает по времени
    hits = [i for i, (t0, t1) in word_times.items() if t1 > a0 and t0 < a1]
    words = (min(hits), max(hits) + 1) if hits else _between(word_times, a0)

    ph = pf.phrase(words, (a0, a1))
    lo, hi = ph['wordFrom'], ph['wordTo']
    ranges = idx['charRanges']
    if 0 <= lo < len(ranges) and 0 < hi <= len(ranges):
        ph['charFrom'], ph['charTo'] = expand_chars(script, ranges[lo][0], ranges[hi - 1][1])
        ph['text'] = script[ph['charFrom']:ph['charTo']]
    else:
        ph['charFrom'] = ph['charTo'] = -1
        ph['text'] = ''
    emit({'type': 'phrase', 'words': [words[0], words[1]], 'phrase': ph})
    return 0


def _between(word_times: dict, t: float) -> tuple:
    """Пустой интервал между словами — как вставка у ttsqc: words=(i, i)."""
    after = [i for i, (t0, _t1) in word_times.items() if t0 >= t]
    return (min(after), min(after)) if after else (len(word_times), len(word_times))


def _write_json(path: Path, data) -> None:
    tmp = path.with_suffix(path.suffix + '.part')
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding='utf-8')
    tmp.replace(path)          # готовый файл появляется целиком или никак


def io_duration(path: Path) -> float:
    out = subprocess.run([os.environ.get('KADR_FFPROBE', 'ffprobe'), '-v', 'error',
                          '-show_entries', 'format=duration', '-of', 'csv=p=0', str(path)],
                         capture_output=True, text=True)
    try:
        return float(out.stdout.strip())
    except ValueError:
        return 0.0


def decode_mono(path: str, sr: int):
    import numpy as np                                      # noqa: PLC0415
    cmd = [os.environ.get('KADR_FFMPEG', 'ffmpeg'), '-nostdin', '-v', 'error',
           '-i', str(path), '-f', 'f32le', '-ac', '1', '-ar', str(sr), '-']
    out = subprocess.run(cmd, capture_output=True)
    if out.returncode != 0:
        raise RuntimeError(f'ffmpeg не смог декодировать {path}')
    return np.frombuffer(out.stdout, dtype=np.float32).copy()



# ---------------------------------------------------------------------------
# обучение


def _overlap(a: list, b: list) -> float:
    return max(0.0, min(a[1], b[1]) - max(a[0], b[0]))


def _candidates(payload: dict) -> list:
    """Все, кого показал генератор, а не только прошедшие порог."""
    return (payload.get('defects') or []) + (payload.get('suppressed') or []) + \
           (payload.get('text_mismatches') or [])


def cmd_learn(args) -> int:
    """Переобучение на накопленной разметке.

    Про пользовательские отметки. Соблазн — дописать их в обучение как есть,
    но у ручной отметки НЕТ улик: `звучит`, `сходство`, `star_s`, `правило` и
    прочее, из чего featurize() строит вектор. Нули на их месте — не «нет
    признака», а отдельный, прекрасно выучиваемый угол «улик нет ⇒ дефект»,
    после которого модель начнёт продвигать пустышки.

    Поэтому отметка попадает в обучение ТОЛЬКО если генератор породил на этом
    месте кандидата (пусть и подавленного) — тогда у строки настоящие признаки,
    и обучение делает ровно то, что умеет: поднимает то, что правила нашли, а
    ранжировщик закопал. Отметки, которых генератор не порождает вовсе,
    считаются и показываются отдельно: их этот вид обучения поднять не может
    (см. NOTES.md, «Почему пропуски не подтянутся сами»).
    """
    from ttsqc import train                                 # noqa: PLC0415
    import numpy as np                                      # noqa: PLC0415

    runs_dir = Path(args.runs).resolve()
    verdict_glob = str(runs_dir / '*' / 'verdicts.json')
    X, y, g, keep = train.load_dataset(verdict_glob, str(runs_dir))

    # load_dataset нумерует группы ЧИСЛАМИ (по одному на аудиофайл), а не путями.
    # Дописать сюда строку — значит привести весь массив к строкам и развалить
    # перекрёстную проверку на лишние «файлы».
    path_gid = {}
    for gi, row in zip(list(g), keep):
        path_gid.setdefault(row.get('_audio', ''), int(gi))
    next_gid = (max(int(x) for x in g) + 1) if len(g) else 0

    matched, unmatched = 0, 0
    for marks_path in sorted(runs_dir.glob('*/user_marks.json')):
        payload_path = marks_path.parent / 'defects.json'
        if not payload_path.exists():
            continue
        payload = json.loads(payload_path.read_text(encoding='utf-8'))
        cands = _candidates(payload)
        audio = payload.get('audio', '')
        for m in json.loads(marks_path.read_text(encoding='utf-8')):
            span = [float(m['a0']), float(m['a1'])]
            best, best_ov = None, 0.0
            for c in cands:
                ov = _overlap(span, c.get('audio') or [0, 0])
                if ov > best_ov:
                    best, best_ov = c, ov
            if best is None or best_ov <= 0:
                unmatched += 1
                continue
            gid = path_gid.get(audio)
            if gid is None:
                gid = next_gid
                path_gid[audio] = gid
                next_gid += 1
            vec = train.featurize(best)
            X = np.vstack([X, vec]) if len(X) else np.array([vec])
            y = np.append(y, 1)
            g = np.append(g, gid)
            keep.append(dict(best, _audio=audio))
            matched += 1

    n = len(y)
    report = {'type': 'learn', 'examples': int(n),
              'positives': int(sum(1 for v in y if v == 1)),
              'files': int(len({int(x) for x in g})) if n else 0,
              'userMatched': matched, 'userUnmatched': unmatched,
              'runs': len(list(runs_dir.glob('*/defects.json')))}
    if n < args.min or len({int(x) for x in g}) < 2:
        report['ok'] = False
        report['problem'] = (f'нужно не меньше {args.min} примеров по >=2 файлам; '
                             f'есть {n} по {len({int(x) for x in g})}')
        emit(report)
        return 0 if args.dry else 3

    cv = train.cross_val(np.asarray(X), np.asarray(y), np.asarray(g))
    report['crossVal'] = {k: (round(float(v), 4) if isinstance(v, (int, float)) else v)
                          for k, v in cv.items()}
    report['ok'] = True
    if args.dry:
        emit(report)
        return 0

    out = Path(args.out).resolve()
    if out.exists():
        # старую модель сохраняем: плохой круг разметки не должен стать
        # необратимым — она же работает и в консольном ttsqc пользователя
        backup = out.with_name(f'{out.stem}.{int(out.stat().st_mtime)}{out.suffix}')
        shutil.copyfile(out, backup)
        report['backup'] = str(backup)
    model = train.fit(np.asarray(X), np.asarray(y), np.asarray(g))
    train.save(model, str(out))
    report['saved'] = str(out)
    # время и размер записанного файла — единственное честное доказательство,
    # что модель действительно пересобрана: число примеров от переобучения не
    # меняется (корпус тот же), и по нему пользователь ничего понять не может
    st = out.stat()
    report['savedAt'] = int(st.st_mtime * 1000)
    report['savedSize'] = int(st.st_size)
    emit(report)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="мост Kadr ↔ ttsqc")
    ap.add_argument("--selftest", action="store_true",
                    help="проверить окружение и выйти")
    sub = ap.add_subparsers(dest="cmd")

    c = sub.add_parser("check", help="разобрать озвучку и посчитать фразы")
    c.add_argument("--audio", required=True)
    c.add_argument("--script", required=True)
    c.add_argument("--run-dir", required=True)
    c.add_argument("--device", default="cuda")
    c.add_argument("--config", default=None)
    c.add_argument("--max-flags", type=int, default=40)
    c.add_argument("--min-confidence", type=float, default=0.0)
    c.add_argument("--edge-words", type=int, default=1,
                   help="сколько слов от края предложения считать границей")
    c.set_defaults(func=cmd_check)

    lr = sub.add_parser("learn", help="переобучить оценку на накопленных вердиктах")
    lr.add_argument("--runs", required=True)
    lr.add_argument("--out", required=True, help="куда писать scorer.pkl")
    lr.add_argument("--min", type=int, default=30,
                    help="минимум примеров (у ttsqc порог тот же)")
    lr.add_argument("--dry", action="store_true", help="только посчитать, не сохранять")
    lr.set_defaults(func=cmd_learn)

    q = sub.add_parser("phrase-at", help="фраза вокруг интервала, без моделей")
    q.add_argument("--run-dir", required=True)
    q.add_argument("--start", type=float, required=True)
    q.add_argument("--end", type=float, required=True)
    q.add_argument("--edge-words", type=int, default=1)
    q.add_argument("--audio-duration", type=float, default=0.0)
    q.set_defaults(func=cmd_phrase_at)

    args = ap.parse_args()
    if args.selftest:
        return selftest()
    if not getattr(args, "func", None):
        ap.error("укажите команду: --selftest, check или phrase-at")
    return args.func(args)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as e:                                   # noqa: BLE001
        sys.stderr.write(f"ttsqc_run failed: {type(e).__name__}: {e}\n")
        sys.exit(1)
