/**
 * Как времена звука переезжают после склейки фразы.
 *
 * Разбор дефектов знает файл таким, каким он был В МОМЕНТ РАЗБОРА: времена слов,
 * границы предложений, вероятности речи. Каждая перегенерация переписывает файл
 * — и всё правее шва уезжает. Пока эти карты не применены, ручная отметка,
 * поставленная ПОСЛЕ склейки, ищется в координатах старого файла: подхватывается
 * чужое предложение, и перегенерация вырезает не тот кусок.
 *
 * Здесь только числа — ни node, ни electron: проверяется в чистом node
 * (`scripts/check-voicemap.mjs`).
 */

/** Один заменённый участок: [cut0, cut1) исходного файла стал куском patchDur. */
export interface SpliceUnitMap {
  cut0: number
  cut1: number
  patchDur: number
}

const sortUnits = (units: SpliceUnitMap[]): SpliceUnitMap[] =>
  [...units].sort((a, b) => a.cut0 - b.cut0)

/**
 * Время ДО склейки → время ПОСЛЕ.
 *
 * Внутри заменённого участка отображение линейное: там звучит тот же текст,
 * просто другим дублем, поэтому «доля пути» — единственная осмысленная оценка.
 * Точность здесь нужна не миллисекундная: по этим временам выбирают предложение,
 * а сам рез потом ищется по тишине в НАСТОЯЩЕМ файле.
 */
export function spliceForward(units: SpliceUnitMap[], t: number): number {
  let acc = 0
  for (const u of sortUnits(units)) {
    if (t <= u.cut0) return t + acc
    if (t < u.cut1) {
      const span = u.cut1 - u.cut0
      const k = span > 1e-9 ? (t - u.cut0) / span : 0
      return u.cut0 + acc + k * u.patchDur
    }
    acc += u.patchDur - (u.cut1 - u.cut0)
  }
  return t + acc
}

/**
 * Время ПОСЛЕ склейки → время ДО, или null внутри заменённого участка.
 *
 * null — это не сбой, а честный ответ: того звука в разобранном файле больше
 * нет, и придумывать ему координату нельзя (по ней потом обучается детектор).
 */
export function spliceInverse(units: SpliceUnitMap[], t: number): number | null {
  let acc = 0
  for (const u of sortUnits(units)) {
    const from = u.cut0 + acc
    if (t <= from) return t - acc
    if (t < from + u.patchDur) return null
    acc += u.patchDur - (u.cut1 - u.cut0)
  }
  return t - acc
}

/** Время текущего файла → время файла, который разбирал детектор. */
export function toAnalysisTime(batches: SpliceUnitMap[][], t: number): number | null {
  let cur: number | null = t
  for (let i = batches.length - 1; i >= 0; i--) {
    if (cur === null) return null
    cur = spliceInverse(batches[i], cur)
  }
  return cur
}

/** Время разобранного файла → время текущего. */
export function fromAnalysisTime(batches: SpliceUnitMap[][], t: number): number {
  let cur = t
  for (const b of batches) cur = spliceForward(b, cur)
  return cur
}
