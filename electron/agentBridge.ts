import { nativeImage, type BrowserWindow } from 'electron'
import { createServer } from 'http'
import { randomBytes } from 'crypto'
import { criticOp, criticTurn } from './critic'

export interface EditorBridge {
  port: number
  token: string
  criticToken?: string
  close(): void
}

/** JS evaluated in the page (async function body) → JSON result. */
async function evalInPage(win: BrowserWindow, code: string): Promise<string> {
  const wrapped = `(async () => {
    try {
      const r = await (async () => { ${code}\n })()
      return JSON.stringify({ ok: r === undefined ? null : r })
    } catch (e) {
      return JSON.stringify({ error: String((e && (e.stack || e.message)) || e) })
    }
  })()`
  return win.webContents.executeJavaScript(wrapped, true)
}

/** The Codex critic gets named read operations rather than renderer eval. */
async function reviewQuery(win: BrowserWindow, body: Record<string, unknown>): Promise<string> {
  switch (body.op) {
    case 'state':
      return evalInPage(win, `
        const s = window.kadrEditor.useEditor.getState()
        const assets = s.project.assets.map(({ waveform, thumbnail, thumbnailEnd, ...asset }) => asset)
        return { project: { ...s.project, assets }, projectPath: s.projectPath, playhead: s.playhead }`)
    case 'context':
      return evalInPage(win, 'return window.kadrEditor.criticContext()')
    case 'plan':
      return evalInPage(win, `return await window.kadrEditor.criticPlan(${JSON.stringify(body.options)})`)
    case 'check':
      return evalInPage(win, `
        const r = await window.kadrEditor.runChecks(${JSON.stringify(body.options)})
        return { checked: r.checked, warnings: r.issues.filter(i => i.level === 'warn'),
          notes: r.issues.filter(i => i.level === 'info').slice(0, 80), events: r.events.length }`)
    case 'sheet': {
      const review = await criticOp({ op: 'get', id: body.id }) as { ok: boolean; dir?: string }
      if (!review.ok) throw new Error('No matching Kadr review')
      const options = { times: body.times, cols: body.cols, width: body.width, dir: review.dir || undefined }
      const result = JSON.parse(await evalInPage(win, `
        const r = await window.kadrEditor.contactSheet(${JSON.stringify(options)})
        return { path: r.path, frames: r.frames.map(f => ({ t: f.t, label: f.label })) }`))
      if (result.ok) {
        // Keep the full PNG in the report and send a compact image to the model.
        const sheet = nativeImage.createFromPath(result.ok.path)
        if (sheet.isEmpty()) throw new Error('Kadr could not open the contact sheet')
        result.ok.image = sheet.toJPEG(85).toString('base64')
      }
      return JSON.stringify(result)
    }
    default:
      throw new Error('Unknown Kadr review operation')
  }
}

/**
 * Local bridge: POST /eval {code} from mcp-bridge.cjs into the renderer.
 *
 * /eval is arbitrary JS in the page, and the page holds window.kadr (file
 * writes, pty spawn) — so the socket needs a door, not just an address.
 * Anything running on this machine can reach 127.0.0.1, and a WEB PAGE can
 * too: a fetch() with a simple content type is sent cross-origin without the
 * browser asking permission first, and the reply being unreadable does not
 * stop the code from running. A fragment previewed from the workspace vite
 * server is such a page. Two cheap locks close that:
 *   • a per-session secret in a custom header — a custom header forces the
 *     browser to ask permission first (preflight), which this server answers
 *     with 404, so a page cannot even send the request;
 *   • rejecting anything that carries an Origin at all — only browsers set
 *     it, and the only legitimate client here is a node process.
 * The health check (GET /) stays open: mcp-bridge only needs *a* reply.
 * Behind the same two locks: POST /critic (the critic's ledger, from the
 * kadr_review_* tools) and POST /turn (the UserPromptSubmit hook).
 */
export function startBridge(win: BrowserWindow, withCodexCritic = false): Promise<EditorBridge> {
  const token = randomBytes(24).toString('hex')
  const criticToken = withCodexCritic ? randomBytes(24).toString('hex') : undefined
  const routes: Record<string, (body: Record<string, unknown>) => Promise<string>> = {
    '/eval': (b) => evalInPage(win, String(b.code)),
    '/critic': async (b) => JSON.stringify({ ok: await criticOp(b) }),
    '/turn': async (b) => JSON.stringify({ ok: criticTurn(b) })
  }
  if (criticToken) routes['/review-query'] = (b) => reviewQuery(win, b)
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const path = req.url ?? ''
      const route = req.method === 'POST' ? routes[path] : undefined
      if (!route) {
        res.writeHead(404).end()
        return
      }
      const expected = criticToken && (path === '/critic' || path === '/review-query') ? criticToken : token
      if (req.headers.origin !== undefined || req.headers['x-kadr-token'] !== expected) {
        res.writeHead(403).end()
        return
      }
      let body = ''
      req.on('data', (c) => { body += c })
      req.on('end', async () => {
        try {
          const out = await route(JSON.parse(body))
          res.writeHead(200, { 'Content-Type': 'application/json' }).end(out)
        } catch (err) {
          res
            .writeHead(200, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: String(err) }))
        }
      })
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        resolve({ port: addr.port, token, criticToken, close: () => server.close() })
      } else {
        server.close()
        reject(new Error('bridge listen failed'))
      }
    })
  })
}
