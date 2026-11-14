// App-lifetime local bridge between the editor's main process and the MCP
// stdio server (electron/mcp-bridge.cjs, spawned by the user's claude).
// Started ONCE with the editor — not with the Claude terminal — so the
// generated kadr-mcp.json exists before any session opens and closing the
// terminal panel never takes the bridge down.
//
// No electron imports here on purpose: the module is plain node so
// scripts/check-mcp-bridge.mjs can exercise the real server.
import { createServer, type Server } from 'http'
import { randomBytes } from 'crypto'

/** The slice of BrowserWindow the bridge needs (keeps this module testable). */
export interface PageLike {
  webContents: {
    executeJavaScript(code: string, userGesture: boolean): Promise<string>
  }
}

export interface Bridge {
  server: Server
  port: number
  token: string
}

/** Honest, token-free status: the listener is up, nothing about clients. */
export function bridgeListening(b: Bridge | null): boolean {
  return !!b && b.server.listening
}

/** JS evaluated in the page (async function body) → JSON result. */
export async function evalInPage(win: PageLike, code: string): Promise<string> {
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
 *   • a per-bridge secret in a custom header — a custom header forces the
 *     browser to ask permission first (preflight), which this server answers
 *     with 404, so a page cannot even send the request;
 *   • rejecting anything that carries an Origin at all — only browsers set
 *     it, and the only legitimate client here is a node process.
 * The health check (GET /) stays open: mcp-bridge only needs *a* reply.
 * Behind the same two locks: POST /critic (the critic's ledger, from the
 * kadr_review_* tools) and POST /turn (the UserPromptSubmit hook).
 * Routes are supplied by the caller so this module stays electron-free.
 */
export function startBridge(
  routes: Record<string, (body: Record<string, unknown>) => Promise<string>>
): Promise<Bridge> {
  const token = randomBytes(24).toString('hex')
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const route = req.method === 'POST' ? routes[req.url ?? ''] : undefined
      if (!route) {
        res.writeHead(404).end()
        return
      }
      if (req.headers.origin !== undefined || req.headers['x-kadr-token'] !== token) {
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
      if (addr && typeof addr === 'object') resolve({ server, port: addr.port, token })
      else reject(new Error('bridge listen failed'))
    })
  })
}
