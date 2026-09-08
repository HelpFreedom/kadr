// Which proxy the ElevenLabs calls go through, and how to say it in Chromium's
// own syntax. Kept free of node/electron imports so it can be checked in plain
// node (scripts/check-proxy.mjs).
//
// Why this exists at all: net.fetch() always uses Electron's DEFAULT session,
// whose proxy Chromium resolves by itself — and it may well settle on HTTP_PROXY
// when only HTTPS_PROXY can reach the API. A plain HTTP proxy typically answers
// CONNECT api.elevenlabs.io:443 with a «503 Forwarding failure» PAGE, so an HTML
// document arrives where JSON was expected: «Unexpected token '<'». Guessing is
// not acceptable for a paid API, so the proxy is chosen here, explicitly.

export interface ProxyEnv {
  HTTPS_PROXY?: string
  https_proxy?: string
}

/** The setting wins; otherwise the environment's HTTPS proxy; otherwise none. */
export function apiProxy(explicit: string | undefined, env: ProxyEnv): string {
  const set = (explicit ?? '').trim()
  if (set) return set
  return (env.HTTPS_PROXY || env.https_proxy || '').trim()
}

/**
 * Proxy URL → Chromium proxyRules.
 *
 * A bare `host:port` in a rule means «HTTP proxy», which is exactly what an
 * `http://` proxy URL is; socks keeps its scheme because it is a different
 * protocol, not a different port.
 */
export function proxyRules(url: string): string {
  const m = /^(?:(\w+):\/\/)?([^/\s]+?)\/*$/.exec(url.trim())
  if (!m) return url.trim()
  const scheme = (m[1] || 'http').toLowerCase()
  const hostPort = m[2]
  if (scheme.startsWith('socks')) return `${scheme}://${hostPort}`
  return `https=${hostPort};http=${hostPort}`
}
