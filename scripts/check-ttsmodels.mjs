// Node-side check of shared/ttsModels.ts — what each ElevenLabs model gets.
//
// Guards two things. The models that existed before v4 must be cut and asked
// EXACTLY as before (chunk = 90 % of the old per-request cap, every voice
// setting sent): a voice-over regenerated today has to match the file it
// patches. And Eleven v4 / v4 Turbo take stability and similarity only — the
// API drops style, speed and speaker boost silently (checked against the live
// API on 2026-10-20: the history item keeps the stability alone).
// Run: node scripts/check-ttsmodels.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'ttsModels.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { TTS_MODELS, ttsModel } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// the table this replaced (electron/tts.ts before v4), chunk = floor(cap * 0.9)
const OLD = { eleven_flash_v2_5: 40000, eleven_turbo_v2_5: 40000, eleven_multilingual_v2: 10000, eleven_monolingual_v1: 10000, eleven_v3: 3000 }
for (const [id, cap] of Object.entries(OLD)) {
  const m = ttsModel(id)
  check(`${id}: cut as before (${Math.floor(cap * 0.9)})`, m.chunkChars === Math.floor(cap * 0.9), String(m.chunkChars))
  check(`${id}: every voice setting still sent`, m.style && m.speed && m.speakerBoost)
}
for (const id of ['some_future_model', '', undefined, null, 42]) {
  const m = ttsModel(id)
  check(`unknown id ${JSON.stringify(id)}: the old conservative 10k, all settings`, m.chunkChars === 9000 && m.style && m.speed && m.speakerBoost)
}

for (const id of ['eleven_v4', 'eleven_v4_turbo']) {
  const m = ttsModel(id)
  check(`${id} is offered`, TTS_MODELS.some((x) => x.id === id))
  check(`${id}: stability and similarity only`, !m.style && !m.speed && !m.speakerBoost)
  check(`${id}: cut at 2000, under the API's 10 000`, m.chunkChars === 2000 && m.maxChars === 10000)
}
check('v4 Turbo costs what Flash v2.5 does, v4 twice that',
  ttsModel('eleven_v4_turbo').usdPer1k === ttsModel('eleven_flash_v2_5').usdPer1k &&
  ttsModel('eleven_v4').usdPer1k === 2 * ttsModel('eleven_v4_turbo').usdPer1k)
check('the deprecated Turbo v2.5 is no longer offered, but still known', !TTS_MODELS.some((x) => x.id === 'eleven_turbo_v2_5') && ttsModel('eleven_turbo_v2_5').name === 'Turbo v2.5')
check('every offered model fits its chunk under its cap', TTS_MODELS.every((m) => m.chunkChars > 0 && m.chunkChars <= m.maxChars))

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exit(fails ? 1 : 0)
