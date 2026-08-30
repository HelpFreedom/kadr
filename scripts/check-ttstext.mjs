// Node-side check of shared/ttsText.ts — script normalisation and chunking for
// the ElevenLabs module. The load-bearing property is that chunking loses
// NOTHING: ttsqc addresses defects by character offset into the script, so a
// chunker that trimmed a space would silently shift every later index.
// No test runner in the repo: transpile with esbuild, import through a data URL.
// Run: node scripts/check-ttstext.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'ttsText.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { normalizeScript, chunkText, sentenceEnds } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64')
)

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// --- normalisation ---------------------------------------------------------
check('CRLF becomes LF', !normalizeScript('а\r\nб').includes('\r'))
check('BOM is dropped', !normalizeScript('﻿Привет.').startsWith('﻿'))
check('trailing spaces go', normalizeScript('раз   \nдва').split('\n')[0] === 'раз')
check('blank-line runs squeeze to one', normalizeScript('а\n\n\n\n\nб').includes('а\n\nб'))
check('ends with exactly one newline', /[^\n]\n$/.test(normalizeScript('  текст  ')))
check('paragraph structure survives', normalizeScript('Абзац один.\n\nАбзац два.') === 'Абзац один.\n\nАбзац два.\n')

// --- chunking: the invariant ----------------------------------------------
const para = (n) => Array.from({ length: n },
  (_, i) => `Предложение номер ${i}, довольно длинное, чтобы набрать объём. Второе тоже здесь!`).join(' ')
const script = normalizeScript(para(120) + '\n\n' + para(80))
const rejoin = (text, parts) => parts.map((p) => text.slice(p.from, p.to)).join('')

let lossless = true, ordered = true, withinLimit = true
for (const limit of [80, 200, 1000, 4000, 999999]) {
  const parts = chunkText(script, limit)
  if (rejoin(script, parts) !== script) lossless = false
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].to <= parts[i].from) ordered = false
    if (i && parts[i].from !== parts[i - 1].to) ordered = false
    if (parts[i].to - parts[i].from > limit) withinLimit = false
  }
  if (parts[0].from !== 0 || parts[parts.length - 1].to !== script.length) ordered = false
}
check('chunks rejoin to the original exactly, every limit', lossless)
check('chunks are contiguous and cover the whole script', ordered)
check('no chunk exceeds its limit', withinLimit)

// --- chunking: it prefers the strongest boundary ---------------------------
const twoParas = 'Первый абзац, короткий.\n\nВторой абзац, тоже короткий.\n'
const atPara = chunkText(twoParas, 30)
check('a paragraph break wins when one fits',
  atPara.length > 1 && twoParas.slice(atPara[0].from, atPara[0].to).endsWith('\n\n'),
  JSON.stringify(twoParas.slice(atPara[0].from, atPara[0].to)))

const sentences = 'Раз два три четыре. Пять шесть семь восемь. Девять десять.\n'
const atSent = chunkText(sentences, 30)
check('otherwise a sentence end wins',
  atSent.length > 1 && /[.!?…]\s+$/.test(sentences.slice(atSent[0].from, atSent[0].to)),
  JSON.stringify(sentences.slice(atSent[0].from, atSent[0].to)))

const clause = 'Раз два три четыре пять, шесть семь восемь девять десять\n'
const atClause = chunkText(clause, 30)
check('then a clause comma', atClause.length > 1 && clause.slice(atClause[0].from, atClause[0].to).includes(','))

// --- chunking: degenerate input --------------------------------------------
const wall = 'ф'.repeat(250) + '\n'
const hard = chunkText(wall, 100)
check('an unbreakable run is hard-cut, not dropped',
  rejoin(wall, hard) === wall && hard.every((p) => p.to - p.from <= 100), `${hard.length} кусков`)
check('text shorter than the limit stays one chunk', chunkText('Коротко.', 1000).length === 1)
check('a limit of exactly the length stays one chunk', chunkText('abcde', 5).length === 1)
let threw = false
try { chunkText('abc', 0) } catch { threw = true }
check('a nonsensical limit throws instead of looping forever', threw)

// --- sentence ends ----------------------------------------------------------
const seText = 'Раз. Два! Три? Четыре… Пять.\n'
const se = sentenceEnds(seText)
// five, not four: the closing newline ends the last sentence just as a space
// ends the others, and the trailing pause that produces is wanted
check('sentence ends are found after . ! ? …', se.length === 5, JSON.stringify(se))
check('the last one closes the text', se[se.length - 1] === seText.length)
check('no sentence end is reported past the text', se.every((i) => i <= seText.length))
check('an unterminated last sentence yields no trailing end',
  sentenceEnds('Раз. Два без точки').length === 1)

console.log(fails ? `\n${fails} проверок не прошло` : '\nвсе проверки пройдены')
process.exit(fails ? 1 : 0)
