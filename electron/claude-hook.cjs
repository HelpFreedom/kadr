#!/usr/bin/env node
// UserPromptSubmit hook of the embedded Claude session (wired by claude.ts
// through --settings). It tells the editor that a prompt was submitted, so the
// critic's limits (shared/critic.ts) open a new turn — the editor decides
// whether the prompt was the user's: the CLI submits prompts of its own too
// (a background agent finishing arrives as a <task-notification>).
//
// It must never get in the way of the prompt: it prints NOTHING (a hook's
// stdout is added to the conversation), always exits 0, and gives up after
// 2 s. Only the two ends of the prompt are sent — enough to recognise a
// machine-made one, and a prompt can be megabytes of paste.
const http = require('http')

const PORT = Number(process.argv[2])
const TOKEN = process.argv[3] || ''
const END = 256

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => { if (raw.length < 4_000_000) raw += c })
process.stdin.on('end', send)
setTimeout(() => process.exit(0), 2000).unref()

function send() {
  let prompt = ''
  try { prompt = String(JSON.parse(raw).prompt ?? '') } catch { /* not ours to judge */ }
  const body = JSON.stringify({ head: prompt.slice(0, END), tail: prompt.slice(-END) })
  if (!PORT) return
  const req = http.request(
    { host: '127.0.0.1', port: PORT, path: '/turn', method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-kadr-token': TOKEN } },
    (res) => { res.resume(); res.on('end', () => process.exit(0)) }
  )
  req.on('error', () => process.exit(0))
  req.on('timeout', () => { req.destroy(); process.exit(0) })
  req.end(body)
}
