// Check of shared/effectFile.ts, the parser of project-library effects
// (<project>/kadr-lib/effects/<name>.glsl): a good file becomes an effect with
// every declared param; each kind of mistake comes back as a readable reason
// instead of an effect.
//
// Pure node, no app.  Run: node scripts/check-effectfile.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const js = transformSync(readFileSync(join(root, 'shared', 'effectFile.ts'), 'utf8'), { loader: 'ts', format: 'esm' }).code
const { parseEffectFile, effectFileId } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const file = (head, body = 'vec4 effect(vec4 c, vec2 uv) { return c; }') =>
  `/* kadr-effect\n${typeof head === 'string' ? head : JSON.stringify(head)}\n*/\n${body}`

const good = parseEffectFile('sepia.glsl', file({
  name: { ru: 'Сепия', en: 'Sepia' }, group: 'color',
  params: {
    amount: { kind: 'number', default: 1, min: 0, max: 1, name: 'Amount' },
    tint: { kind: 'color', default: '#704214', name: 'Tint' },
    mode: { kind: 'select', default: 1, options: [{ value: 0, name: 'A' }, { value: 1, name: 'B' }], name: 'Mode' },
    on: { kind: 'toggle', default: true, name: 'On' }
  }
}, 'vec4 effect(vec4 c, vec2 uv) { return vec4(c.rgb * u_amount, c.a); }'))
check('a good file becomes an effect', good.id === 'lib:sepia' && !good.error && Object.keys(good.params).length === 4,
  JSON.stringify(good.error ?? good.id))
check('its body is the GLSL after the header', /^vec4 effect/.test(good.glsl ?? ''))
check('it does not move by itself unless it reads uTime', good.timeDependent === false)
check('reading uTime marks it as moving',
  parseEffectFile('t.glsl', file({}, 'vec4 effect(vec4 c, vec2 uv) { return c * uTime; }')).timeDependent === true)
check('group defaults to stylize', parseEffectFile('g.glsl', file({})).group === 'stylize')

const reasons = [
  ['bad name.glsl', file({}), /file name/],
  ['x.glsl', 'vec4 effect(vec4 c, vec2 uv) { return c; }', /header/],
  ['x.glsl', file('{ not json'), /not JSON/],
  ['x.glsl', file({}, 'void main() {}'), /vec4 effect/],
  ['x.glsl', file({ group: 'sound' }), /group/],
  ['x.glsl', file({ params: { '1bad': { kind: 'number', default: 0 } } }), /letters/],
  ['x.glsl', file({ params: { a: { kind: 'number', default: 'x' } } }), /numeric/],
  ['x.glsl', file({ params: { a: { kind: 'number', default: 0, min: 1, max: 0 } } }), /above/],
  ['x.glsl', file({ params: { a: { kind: 'color', default: 'red' } } }), /#rrggbb/],
  ['x.glsl', file({ params: { a: { kind: 'select', default: 5, options: [{ value: 0, name: 'A' }] } } }), /option values/],
  ['x.glsl', file({ params: { a: { kind: 'toggle', default: 1 } } }), /true\/false/],
  ['x.glsl', file({ params: { a: { kind: 'curve', default: 0 } } }), /kind/],
  ['x.glsl', file({}) + ' '.repeat(300 * 1024), /KB/]
]
for (const [name, text, re] of reasons) {
  const r = parseEffectFile(name, text)
  check(`refused with a reason: ${re}`, !!r.error && re.test(r.error), r.error ?? 'accepted')
}
check('ids come from file names', effectFileId('my-fx_1.glsl') === 'lib:my-fx_1' && effectFileId('../x.glsl') === null)

console.log(fails ? `\n${fails} FAILED` : '\nall passed')
process.exitCode = fails ? 1 : 0
