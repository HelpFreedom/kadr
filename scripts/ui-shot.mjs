// Look at the running editor: run a snippet in the page, then save a PNG of
// the window. For UI work — a screenshot is the only honest check that a
// layout change did what it was meant to.
//
//   node scripts/ui-shot.mjs out.png                       # just the shot
//   node scripts/ui-shot.mjs out.png "<js>" [waitMs]       # act, then shoot
//   node scripts/ui-shot.mjs --eval "<js>"                 # act only, print result
//
// Needs the app started with `npx electron-vite dev -- --remote-debugging-port=9777`.
import WebSocket from 'ws'
import { writeFileSync } from 'node:fs'

const PORT = process.env.KADR_CDP_PORT || 9777
const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json())
const page = list.find((t) => t.type === 'page' && t.url.includes('localhost'))
if (!page) throw new Error('CDP target not found — is the app running with --remote-debugging-port?')

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.on('open', r); ws.on('error', j) })
let id = 0
const send = (method, params = {}) => new Promise((res, rej) => {
  const msgId = ++id
  const on = (raw) => {
    const m = JSON.parse(raw)
    if (m.id !== msgId) return
    ws.off('message', on)
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)
  }
  ws.on('message', on)
  ws.send(JSON.stringify({ id: msgId, method, params }))
})

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  }
  return r.result.value
}

if (process.argv[2] === '--eval') {
  console.log(JSON.stringify(await evalJs(process.argv[3]), null, 1))
} else {
  const [, , out, setup, wait] = process.argv
  if (setup) {
    await evalJs(setup)
    await new Promise((r) => setTimeout(r, Number(wait || 800)))
  }
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(out, Buffer.from(data, 'base64'))
  console.log('saved', out)
}
ws.close()
