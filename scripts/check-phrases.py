#!/usr/bin/env python3.11
"""Проверка расчёта границ фраз (python/kadr_phrases.py) на синтетике.

Ни моделей, ни GPU, ни ttsqc: строим звук с заведомо известными паузами и
проверяем главное требование — рез попадает В ТИШИНУ между предложениями, а
дефект у границы втягивает оба смежных предложения.

Запуск: <venv>/python3.11 scripts/check-phrases.py
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / 'python'))
import kadr_phrases as K  # noqa: E402

SR = 16000
WORD_S = 0.30          # слово
INWORD_GAP_S = 0.06    # пауза между словами внутри предложения
SENT_GAP_S = 0.40      # пауза между предложениями
WORDS_PER_SENT = 7   # чтобы у предложения была настоящая «глубина»
N_SENTS = 5

fails = 0


def check(name, ok, detail=''):
    global fails
    print(f"{'PASS' if ok else 'FAIL'}  {name}{'  — ' + str(detail) if detail else ''}")
    if not ok:
        fails += 1


def build(sent_gap=SENT_GAP_S, noise=1e-4):
    """Звук + времена слов + номера предложений."""
    sents, times, spans = [], {}, []
    t = 0.25                                   # немного тишины в начале
    for s in range(N_SENTS):
        for w in range(WORDS_PER_SENT):
            idx = len(sents)
            sents.append(s)
            times[idx] = (round(t, 4), round(t + WORD_S, 4))
            spans.append((t, t + WORD_S))
            t += WORD_S + (INWORD_GAP_S if w < WORDS_PER_SENT - 1 else sent_gap)
    duration = t + 0.25
    n = int(duration * SR)
    rng = np.random.default_rng(7)
    audio = (rng.standard_normal(n) * noise).astype(np.float32)
    tt = np.arange(n) / SR
    for a, b in spans:                         # слово — тон с огибающей
        m = (tt >= a) & (tt < b)
        audio[m] += (0.35 * np.sin(2 * np.pi * 180 * tt[m])).astype(np.float32)
    return audio, sents, times, duration


audio, sents, times, duration = build()
pf = K.PhraseFinder(sents, times, duration, audio=audio, sr=SR)

print(f"синтетика: {N_SENTS} предложений по {WORDS_PER_SENT} слов, "
      f"{duration:.2f} с, паузы между предложениями {SENT_GAP_S} с\n")

# --- 0. профиль и порог ----------------------------------------------------
check('уровень шума найден ниже речи', pf.floor_db < -50, f'{pf.floor_db:.1f} дБ')
check('порог тишины не строже -45 дБ', K.silence_threshold_db(pf.floor_db) == -45.0,
      f'{K.silence_threshold_db(pf.floor_db):.1f} дБ')
check('в шумной записи порог поднимается', K.silence_threshold_db(-30.0) == -24.0,
      f'{K.silence_threshold_db(-30.0):.1f} дБ')


def silence_windows():
    """Настоящие паузы между предложениями — эталон для проверки резов."""
    out = []
    for s in range(N_SENTS - 1):
        end = times[s * WORDS_PER_SENT + WORDS_PER_SENT - 1][1]
        start = times[(s + 1) * WORDS_PER_SENT][0]
        out.append((end, start))
    return out


SIL = silence_windows()


def in_silence(t):
    return any(a <= t <= b for a, b in SIL)


# индексы считаем от начала предложения, иначе в них невозможно разобраться
def w(sent, k):
    return sent * WORDS_PER_SENT + k


# --- 1. дефект глубоко внутри предложения ----------------------------------
# «глубоко» = дальше чем в одном слове от обоих краёв: у семисловного
# предложения это слова 2..4
a, b = w(2, 2), w(2, 4)
p = pf.phrase((a, b), (times[a][0], times[b - 1][1]))
check('глубокий дефект берёт только своё предложение',
      p['sentFrom'] == 2 and p['sentTo'] == 2, f"{p['sentFrom']}..{p['sentTo']}")
check('оба реза попали в настоящую тишину', in_silence(p['t0']) and in_silence(p['t1']),
      f"{p['t0']} / {p['t1']}")
check('вид реза — тишина', p['cut'] == ['silence', 'silence'], p['cut'])
mid0 = sum(SIL[1]) / 2
check('рез стоит у середины паузы (±30 мс)', abs(p['t0'] - mid0) < 0.03,
      f"{p['t0']} против середины {mid0:.3f}")
check('дефект целиком внутри фразы', p['t0'] <= times[a][0] and p['t1'] >= times[b - 1][1])

# ровно одно слово до конца предложения — это уже «у границы»
c = w(2, WORDS_PER_SENT - 2)
p = pf.phrase((c, c + 1), (times[c][0], times[c][1]))
check('одно слово до конца — уже граница, берём и следующее',
      p['sentFrom'] == 2 and p['sentTo'] == 3, f"{p['sentFrom']}..{p['sentTo']}")

# --- 2. дефект у начала предложения -> втягивает предыдущее -----------------
f0 = w(2, 0)
p = pf.phrase((f0, f0 + 1), (times[f0][0], times[f0][1]))
check('дефект на первом слове втягивает предыдущее предложение',
      p['sentFrom'] == 1 and p['sentTo'] == 2, f"{p['sentFrom']}..{p['sentTo']}")
f1 = w(2, 1)
p = pf.phrase((f1, f1 + 1), (times[f1][0], times[f1][1]))
check('дефект во втором слове — тоже (в одном слове от границы)',
      p['sentFrom'] == 1 and p['sentTo'] == 2, f"{p['sentFrom']}..{p['sentTo']}")

# --- 3. дефект у конца предложения -> втягивает следующее -------------------
e0 = w(2, WORDS_PER_SENT - 1)
p = pf.phrase((e0, e0 + 1), (times[e0][0], times[e0][1]))
check('дефект на последнем слове втягивает следующее предложение',
      p['sentFrom'] == 2 and p['sentTo'] == 3, f"{p['sentFrom']}..{p['sentTo']}")

# --- 4. вставка ровно на стыке предложений ---------------------------------
gap = SIL[2]
p = pf.phrase((w(3, 0), w(3, 0)), (gap[0] + 0.05, gap[1] - 0.05))
check('вставка на стыке берёт ОБА смежных предложения',
      p['sentFrom'] == 2 and p['sentTo'] == 3, f"{p['sentFrom']}..{p['sentTo']}")
check('её резы тоже в тишине', in_silence(p['t0']) and in_silence(p['t1']),
      f"{p['t0']} / {p['t1']}")
check('вставка целиком внутри фразы', p['t0'] <= gap[0] + 0.05 and p['t1'] >= gap[1] - 0.05)

# --- 5. края файла ----------------------------------------------------------
d0, d1 = w(0, 2), w(0, 4)
p = pf.phrase((d0, d1), (times[d0][0], times[d1 - 1][1]))
check('в первом предложении левый рез — начало файла',
      p['t0'] == 0.0 and p['cut'][0] == 'fileStart', f"{p['t0']} {p['cut']}")
last = N_SENTS * WORDS_PER_SENT - 1
p = pf.phrase((last - 1, last + 1), (times[last - 1][0], times[last][1]))
check('в последнем предложении правый рез — конец файла',
      abs(p['t1'] - duration) < 1e-6 and p['cut'][1] == 'fileEnd', f"{p['t1']} {p['cut']}")

# --- 6. предложения без пауз -> честный 'gap', а не выдумка -----------------
audio2, sents2, times2, dur2 = build(sent_gap=INWORD_GAP_S)
pf2 = K.PhraseFinder(sents2, times2, dur2, audio=audio2, sr=SR)
g0, g1 = w(2, 2), w(2, 4)
p2 = pf2.phrase((g0, g1), (times2[g0][0], times2[g1 - 1][1]))
check('слитые предложения дают шов вида gap или silence',
      set(p2['cut']) <= {'gap', 'silence'}, p2['cut'])
prev_end, next_start = times2[w(1, WORDS_PER_SENT - 1)][1], times2[w(2, 0)][0]
check('и рез всё равно лежит между словами',
      prev_end - 0.06 <= p2['t0'] <= next_start + 0.06,
      f"{p2['t0']} в [{prev_end:.3f}, {next_start:.3f}]")

# --- 7. сценарий без пунктуации: одно предложение на весь файл -------------
one = [0] * (N_SENTS * WORDS_PER_SENT)
pf3 = K.PhraseFinder(one, times, duration, audio=audio, sr=SR)
p3 = pf3.phrase((a, b), (times[a][0], times[b - 1][1]))
check('без пунктуации фраза — весь файл',
      p3['t0'] == 0.0 and abs(p3['t1'] - duration) < 1e-6 and p3['cut'] == ['fileStart', 'fileEnd'],
      f"{p3['t0']}..{p3['t1']} {p3['cut']}")

# --- 8. вырожденные входы не роняют расчёт ---------------------------------
p4 = pf.phrase((999, 1001), (1.0, 1.2))
check('индексы вне сценария не роняют расчёт', p4['t1'] > p4['t0'], p4)
pf5 = K.PhraseFinder([], {}, 3.0, audio=None)
p5 = pf5.phrase((0, 0), (1.0, 1.2))
check('пустой сценарий даёт весь файл', p5['t0'] == 0.0 and p5['t1'] == 3.0, p5)
pf6 = K.PhraseFinder(sents, {}, duration, audio=audio, sr=SR)
p6 = pf6.phrase((a, b), (times[a][0], times[b - 1][1]))
check('без выровненных слов фраза не разваливается', p6['t1'] > p6['t0'], p6['cut'])

# --- 9. инвариант на всех дефектах подряд ----------------------------------
bad = []
for i in range(0, N_SENTS * WORDS_PER_SENT - 1):
    q = pf.phrase((i, i + 1), (times[i][0], times[i][1]))
    if not (q['t0'] <= times[i][0] and q['t1'] >= times[i][1] and q['t1'] > q['t0']):
        bad.append(i)
check('инвариант «дефект внутри фразы» держится на всех словах', not bad, bad)

deep_cuts = []
for sn in range(1, N_SENTS - 1):
    i = w(sn, 3)
    q = pf.phrase((i, i + 1), (times[i][0], times[i][1]))
    deep_cuts += [q['t0'], q['t1']]
check('все резы глубоких дефектов — в тишине', all(in_silence(t) for t in deep_cuts),
      [round(t, 3) for t in deep_cuts])

# --- 10. текст фразы дотягивается до пунктуации -----------------------------
# без точки ElevenLabs читает фразу как незаконченную, и вставка звучит иначе
sys.path.insert(0, str(Path(__file__).resolve().parent))
import importlib.util  # noqa: E402
spec = importlib.util.spec_from_file_location(
    'ttsqc_run', Path(__file__).resolve().parent / 'ttsqc_run.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

raw = 'Первое предложение. «Второе», сказал он! Третье?'
c0, c1 = mod.expand_chars(raw, 0, len('Первое предложение'))
check('точка в конце фразы попадает в текст', raw[c0:c1] == 'Первое предложение.', repr(raw[c0:c1]))
i = raw.index('Второе')
c0, c1 = mod.expand_chars(raw, i, i + len('Второе'))
check('кавычки и следующая за ними запятая тоже', raw[c0:c1] == '«Второе»,', repr(raw[c0:c1]))
j = raw.index('он')
c0, c1 = mod.expand_chars(raw, j, j + 2)
check('восклицательный знак подхватывается', raw[c0:c1] == 'он!', repr(raw[c0:c1]))
c0, c1 = mod.expand_chars(raw, 0, len('Первое'))
check('пробел не проглатывается — соседнее слово не утащено',
      raw[c0:c1] == 'Первое', repr(raw[c0:c1]))
c0, c1 = mod.expand_chars(raw, -5, 999)
check('негодные границы возвращаются как есть', (c0, c1) == (-5, 999), (c0, c1))

print(f"\n{fails} проверок не прошло" if fails else '\nвсе проверки пройдены')
sys.exit(1 if fails else 0)
