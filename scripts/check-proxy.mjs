// Node-side check of shared/proxy.ts — which proxy the ElevenLabs calls use and
// how it is spelled for Chromium. No app, no network.
//
// The bug this guards: net.fetch() uses Electron's DEFAULT session, and Chromium
// picked HTTP_PROXY (privoxy, which answers 503 to CONNECT api.elevenlabs.io)
// instead of HTTPS_PROXY. The HTML error page then arrived where JSON was
// expected: «Unexpected token '<'».
// Run: node scripts/check-proxy.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'shared', 'proxy.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const { apiProxy, proxyRules } = await import(
  'data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}

// --- which proxy is chosen ---------------------------------------------------
const both = { HTTP_PROXY: 'http://127.0.0.1:3128', HTTPS_PROXY: 'http://127.0.0.1:1080' }
check('the HTTPS proxy is used, never the HTTP one',
  apiProxy('', both) === 'http://127.0.0.1:1080', apiProxy('', both))
check('the setting wins over the environment',
  apiProxy('http://127.0.0.1:9999', both) === 'http://127.0.0.1:9999')
check('whitespace in the setting does not count as a value',
  apiProxy('   ', both) === 'http://127.0.0.1:1080')
check('lowercase https_proxy is honoured too',
  apiProxy('', { https_proxy: 'http://p:1' }) === 'http://p:1')
check('no proxy anywhere means no proxy', apiProxy('', {}) === '')
check('HTTP_PROXY alone is NOT used for the API',
  apiProxy('', { HTTP_PROXY: 'http://127.0.0.1:3128' }) === '',
  'иначе запрос уйдёт в privoxy, который на этот адрес отвечает 503')

// --- how it is spelled for Chromium -----------------------------------------
check('an http proxy becomes a rule for both schemes',
  proxyRules('http://127.0.0.1:1080') === 'https=127.0.0.1:1080;http=127.0.0.1:1080',
  proxyRules('http://127.0.0.1:1080'))
check('a bare host:port means the same',
  proxyRules('127.0.0.1:1080') === 'https=127.0.0.1:1080;http=127.0.0.1:1080')
check('a trailing slash is ignored',
  proxyRules('http://127.0.0.1:1080/') === 'https=127.0.0.1:1080;http=127.0.0.1:1080')
check('socks keeps its scheme — it is a different protocol, not a port',
  proxyRules('socks5://127.0.0.1:1080') === 'socks5://127.0.0.1:1080',
  proxyRules('socks5://127.0.0.1:1080'))
check('socks5h too', proxyRules('socks5h://h:1') === 'socks5h://h:1')
check('a host name works as well as an address',
  proxyRules('http://proxy.local:3128') === 'https=proxy.local:3128;http=proxy.local:3128')
check('surrounding spaces are trimmed',
  proxyRules('  http://127.0.0.1:1080  ') === 'https=127.0.0.1:1080;http=127.0.0.1:1080')

console.log(fails ? `\n${fails} проверок не прошло` : '\nвсе проверки пройдены')
process.exit(fails ? 1 : 0)
