/**
 * Test harness: real child processes over real stdio, the way ptc runs them.
 */

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

/** The built binary: what ships is what is tested. */
export const BINARY = join(here, '..', '..', 'dist', 'cli.js')

/** The real tools over a fake Google. */
export const FAKE_SERVER = join(here, 'fake-serve.mjs')

/** The only profile this server implements. */
export const PROTOCOL = '2026-07-28'

/** Spawns `script` and returns a minimal JSON-RPC client over its stdio. */
export function startServer(script = FAKE_SERVER, { args = [], env = {} } = {}) {
  const child = spawn(process.execPath, [script, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, ...env },
  })
  const waiters = new Map()
  let stdout = ''
  let stderr = ''

  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk) => {
    stdout += chunk
    for (let newline = stdout.indexOf('\n'); newline !== -1; newline = stdout.indexOf('\n')) {
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      if (line.trim() === '') continue
      const message = JSON.parse(line)
      const waiter = waiters.get(message.id)
      if (waiter) {
        waiters.delete(message.id)
        waiter(message)
      }
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk) => {
    stderr += chunk
  })

  let nextId = 0
  return {
    child,
    stderr: () => stderr,

    request(method, params = {}) {
      nextId += 1
      const id = nextId
      const payload = {
        jsonrpc: '2.0',
        id,
        method,
        params: {
          ...params,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': PROTOCOL,
            'io.modelcontextprotocol/clientInfo': { name: 'google-mcp-tests', version: '0' },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out awaiting ${method}`)), 20_000)
        waiters.set(id, (message) => {
          clearTimeout(timer)
          resolve(message)
        })
        child.stdin.write(`${JSON.stringify(payload)}\n`)
      })
    },

    async close() {
      child.stdin.end()
      if (child.exitCode === null) await new Promise((resolve) => child.once('exit', resolve))
    },
  }
}

export async function withServer(body, options = {}) {
  const server = startServer(options.script, options)
  try {
    await body(server)
  } finally {
    await server.close()
  }
}

/** Unwraps a successful tool result, failing loudly on any error. */
export async function call(server, name, args = {}) {
  const response = await server.request('tools/call', { name, arguments: args })
  assert.equal(response.error, undefined, JSON.stringify(response.error))
  assert.notEqual(response.result?.isError, true, JSON.stringify(response.result))
  return response.result.structuredContent
}

/** Calls a tool expecting failure, and returns what the client sees. */
export async function callFailing(server, name, args = {}) {
  const response = await server.request('tools/call', { name, arguments: args })
  assert.ok(response.error || response.result?.isError, `${name} must have failed: ${JSON.stringify(response)}`)
  return JSON.stringify(response.error ?? response.result)
}

/** Follows next_cursor to completion. */
export async function collect(server, name, args = {}) {
  const items = []
  let cursor
  let pages = 0
  let last
  do {
    last = await call(server, name, { ...args, ...(cursor === undefined ? {} : { cursor }) })
    items.push(...last.items)
    cursor = last.next_cursor ?? undefined
    pages += 1
    assert.ok(pages < 100, 'cursor traversal must make progress')
  } while (cursor !== undefined)
  return { items, pages, truncated: last.truncated }
}
