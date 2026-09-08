// Node-side check of shared/voiceMap.ts — как времена переезжают после склейки.
//
// Ошибка, ради которой это существует: разбор дефектов описывает файл таким,
// каким он был в момент проверки, а каждая перегенерация переписывает звук.
// Пока карта не применена, ручная отметка, поставленная ПОСЛЕ склейки, ищется
// в координатах старого файла — подхватывается чужое предложение, и следующая
// перегенерация вырезает не тот кусок и портит дорожку.
// Run: node scripts/check-voicemap.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'voiceMap.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { spliceForward, spliceInverse, toAnalysisTime, fromAnalysisTime } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const near = (a, b, eps = 1e-9) => a !== null && Math.abs(a - b) < eps

// один заменённый участок: [10, 14) стал куском 2 с, то есть Δ = −2
const one = [{ cut0: 10, cut1: 14, patchDur: 2 }]
check('до реза время не меняется', near(spliceForward(one, 5), 5))
check('точка реза остаётся на месте', near(spliceForward(one, 10), 10))
check('после реза время уезжает на Δ', near(spliceForward(one, 20), 18))
check('внутри заменённого — линейно по доле', near(spliceForward(one, 12), 11))
check('конец заменённого — конец заплатки', near(spliceForward(one, 14), 12))

check('обратно: до реза', near(spliceInverse(one, 5), 5))
check('обратно: после реза', near(spliceInverse(one, 18), 20))
check('внутри заплатки обратного времени НЕТ', spliceInverse(one, 11) === null,
  String(spliceInverse(one, 11)))
check('край заплатки читается как её начало', near(spliceInverse(one, 10), 10))

// два участка в одной склейке: второй сдвигается накопленной дельтой
const two = [{ cut0: 10, cut1: 14, patchDur: 2 }, { cut0: 30, cut1: 33, patchDur: 5 }]
check('второй участок уезжает вместе с первым', near(spliceForward(two, 30), 28))
check('после обоих — сумма дельт', near(spliceForward(two, 40), 40 - 2 + 2))
check('порядок аргументов не важен',
  near(spliceForward([...two].reverse(), 40), spliceForward(two, 40)))
check('обратно через оба участка', near(spliceInverse(two, 40), 40))
check('внутри второй заплатки обратного времени нет',
  spliceInverse(two, 30) === null, String(spliceInverse(two, 30)))

// цепочка склеек — ровно то, что копится в phrase-index.json
const chain = [one, [{ cut0: 20, cut1: 22, patchDur: 4 }]]
check('цепочка вперёд', near(fromAnalysisTime(chain, 30), 30 - 2 + 2))
check('цепочка назад — точный круг', near(toAnalysisTime(chain, fromAnalysisTime(chain, 30)), 30))
check('вторая склейка знает про первую',
  near(toAnalysisTime(chain, 20), 22), String(toAnalysisTime(chain, 20)))
check('внутри поздней заплатки — null', toAnalysisTime(chain, 21) === null,
  String(toAnalysisTime(chain, 21)))
check('внутри ранней заплатки — тоже null', toAnalysisTime(chain, 11) === null,
  String(toAnalysisTime(chain, 11)))

// круговая проверка на сетке: вне заплаток отображение обязано быть точным
let bad = 0
for (let t = 0; t < 60; t += 0.017) {
  const f = fromAnalysisTime(chain, t)
  const b = toAnalysisTime(chain, f)
  if (b !== null && Math.abs(b - t) > 1e-9) bad++
}
check('круг «вперёд→назад» точен на всей сетке', bad === 0, `${bad} расхождений`)

// пустой список — тождество, чтобы прогон без склеек ничего не менял
check('без склеек ничего не меняется',
  near(spliceForward([], 7), 7) && near(toAnalysisTime([], 7), 7))

// вырожденный участок нулевой длины не должен делить на ноль
const zero = [{ cut0: 5, cut1: 5, patchDur: 3 }]
check('вставка нулевой длины не роняет карту', Number.isFinite(spliceForward(zero, 9)),
  String(spliceForward(zero, 9)))

console.log(fails ? `\n${fails} FAILED` : '\ncheck-voicemap: all good')
process.exit(fails ? 1 : 0)
