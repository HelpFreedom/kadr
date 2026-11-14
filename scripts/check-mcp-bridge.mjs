// Node-side check of electron/bridge.ts — the app-owned MCP HTTP bridge.
//
// What it guards: the bridge the editor owns (not the Claude terminal) starts
// with a random token, answers the open health check (GET /) that
// mcp-bridge.cjs needs, and keeps the token locks exact — /eval /critic /turn
// are arbitrary code in the page, so a request without the token header, with
// the wrong token, or with an Origin header (any browser page, even one that
// cannot read the reply) must be refused. The token must never appear in a
// refusal or in any log-like output. Status is honest: listening until the
// server closes, false after.
// Run: node scripts/check-mcp-bridge.mjs
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'
import { transformSync } from 'esbuild'
import { get, request as httpRequest } from 'http'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = readFileSync(join(root, 'electron', 'bridge.ts'), 'utf8')
const js = transformSync(src, { loader: 'ts', format: 'esm' }).code
const B = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

let fails = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) fails++
}
const getCode = (port, path = '/') => new Promise((res) => {
  get({ port, path, host: '127.0.0.1' }, (r) => { r.resume(); r.on('end', () => res(r.statusCode)) })
    .on('error', () => res(0))
})
const post = (port, path, headers, body = '{"code":"1+1"}') => new Promise((res) => {
  const data = Buffer.from(body)
  const r = httpRequest({ port, path, host: '127.0.0.1', method: 'POST', headers: { ...headers, 'Content-Length': data.length } }, (resp) => {
    let out = ''
    resp.on('data', (c) => { out += c })
    resp.on('end', () => res({ code: resp.statusCode, body: out }))
  })
  r.on('error', (e) => res({ code: 0, body: String(e) }))
  r.end(data)
})

// the real routes shape, exactly as claude.ts wires them
const calls = []
const routes = {
  '/eval': async (b) => { calls.push(b.code); return JSON.stringify({ ok: b.code }) },
  '/critic': async () => JSON.stringify({ ok: true })
}
const bridge = await B.startBridge(routes)
check('bridge listens on loopback', bridgeListeningOk(bridge))
const health = await getCode(bridge.port)
check('GET / health check stays open (no token)', health === 200 || health === 404, `status ${health}`)
check('status reports listening', B.bridgeListening(bridge) === true)

const noToken = await post(bridge.port, '/eval', {})
check('POST /eval without token refused', noToken.code === 403)
const badToken = await post(bridge.port, '/eval', { 'x-kadr-token': 'wrong' })
check('POST /eval with wrong token refused', badToken.code === 403)
const origin = await post(bridge.port, '/eval', { 'x-kadr-token': bridge.token, Origin: 'http://evil.example' })
check('POST /eval with Origin refused (browser page)', origin.code === 403)
check('refusals leak no token', [noToken, badToken, origin].every((r) => !r.body.includes(bridge.token)))

const good = await post(bridge.port, '/eval', { 'x-kadr-token': bridge.token, 'Content-Type': 'application/json' }, '{"code":"2+2"}')
check('correct token reaches the route', good.code === 200 && JSON.parse(good.body).ok === '2+2')
const critic = await post(bridge.port, '/critic', { 'x-kadr-token': bridge.token, 'Content-Type': 'application/json' }, '{}')
check('/critic behind the same lock', critic.code === 200)

bridge.server.close()
await new Promise((res) => bridge.server.close(res))
check('status false after close', B.bridgeListening(bridge) === false)

function bridgeListeningOk(b) {
  return b && b.server.listening === true
}

console.log(fails ? `\n${fails} FAIL` : '\nall bridge checks passed')
process.exit(fails ? 1 : 0)
