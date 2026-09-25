import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { parseAddresses } from '../dist/index.js'
import { loadClient } from '../dist/config.js'
import { AccessTokens, runConsent } from '../dist/oauth.js'
import { readToken, withTokenLock, writeToken } from '../dist/token-store.js'
import { BINARY } from './helpers/harness.mjs'

const CLIENT = { clientId: 'client-id', clientSecret: 'client-secret' }
const SCOPES = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.readonly'

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'google-mcp-unit-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function storedToken(dir, refresh = 'refresh-1') {
  const file = join(dir, 'token.json')
  writeToken(file, { version: 1, refresh_token: refresh, scopes: SCOPES.split(' '), created_at: 'x' })
  return file
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

test('parseAddresses handles display names with commas, brackets, and bare addresses', () => {
  assert.deepEqual(parseAddresses('"Doe, Jane" <Jane@Example.com>, bob@example.org; Team: a@example.net;'), [
    'jane@example.com',
    'bob@example.org',
    'a@example.net',
  ])
  assert.deepEqual(parseAddresses(''), [])
  assert.deepEqual(parseAddresses('undisclosed-recipients:;'), [])
})

test('the token file is written owner-only and read back', (t) => {
  const file = storedToken(tempDir(t))
  assert.equal(statSync(file).mode & 0o777, 0o600)
  assert.equal(readToken(file).refresh_token, 'refresh-1')
})

test('a group-readable client or token file is refused', (t) => {
  const dir = tempDir(t)
  const client = join(dir, 'client.json')
  writeFileSync(client, JSON.stringify({ installed: { client_id: 'a', client_secret: 'b' } }), { mode: 0o640 })
  chmodSync(client, 0o640)
  assert.throws(() => loadClient(client), /owner only/)
  const token = storedToken(dir)
  chmodSync(token, 0o644)
  assert.throws(() => readToken(token), /owner only/)
})

test('a Web client is refused', (t) => {
  const client = join(tempDir(t), 'client.json')
  writeFileSync(client, JSON.stringify({ web: { client_id: 'a', client_secret: 'b' } }), { mode: 0o600 })
  assert.throws(() => loadClient(client), /Desktop app/)
})

test('the token lock serializes concurrent holders', async (t) => {
  const file = storedToken(tempDir(t))
  const order = []
  const hold = (name) =>
    withTokenLock(file, async () => {
      order.push(`${name}:in`)
      await new Promise((resolve) => setTimeout(resolve, 50))
      order.push(`${name}:out`)
    })
  await Promise.all([hold('a'), hold('b')])
  assert.deepEqual(order.slice(0, 2), ['a:in', 'a:out'])
})

test('access tokens are refreshed once and cached', async (t) => {
  const file = storedToken(tempDir(t))
  let refreshes = 0
  const tokens = new AccessTokens(CLIENT, file, async (_url, init) => {
    refreshes += 1
    assert.match(String(init.body), /grant_type=refresh_token/)
    return jsonResponse({ access_token: 'access-1', expires_in: 3600 })
  })
  assert.equal(await tokens.get(), 'access-1')
  assert.equal(await tokens.get(), 'access-1')
  assert.equal(refreshes, 1)
})

test('invalid_grant is terminal: no further refresh is attempted', async (t) => {
  const file = storedToken(tempDir(t))
  let refreshes = 0
  const tokens = new AccessTokens(CLIENT, file, async () => {
    refreshes += 1
    return jsonResponse({ error: 'invalid_grant' }, 400)
  })
  await assert.rejects(tokens.get(), /reconnect Google/)
  await assert.rejects(tokens.get(), /reconnect Google/)
  assert.equal(refreshes, 1)
})

test('a rotated refresh token is persisted', async (t) => {
  const file = storedToken(tempDir(t))
  const tokens = new AccessTokens(CLIENT, file, async () =>
    jsonResponse({ access_token: 'a', expires_in: 3600, refresh_token: 'refresh-2' }),
  )
  await tokens.get()
  assert.equal(readToken(file).refresh_token, 'refresh-2')
})

async function consent(t, tokenResponse, redirect = (state) => `?state=${state}&code=code-1`) {
  const dir = tempDir(t)
  const tokenFile = join(dir, 'token.json')
  const port = 20000 + Math.floor(Math.random() * 20000)
  let exchanged
  const lines = []
  const done = runConsent({
    client: CLIENT,
    tokenFile,
    port,
    say: (line) => {
      lines.push(line)
      if (line.startsWith('https://accounts.google.com/')) {
        const url = new URL(line)
        assert.equal(url.searchParams.get('scope'), SCOPES)
        assert.equal(url.searchParams.get('prompt'), 'consent')
        assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
        setImmediate(() => fetch(`http://127.0.0.1:${port}/${redirect(url.searchParams.get('state'))}`))
      }
    },
    fetchImpl: async (_url, init) => {
      exchanged = new URLSearchParams(String(init.body))
      return jsonResponse(tokenResponse)
    },
  })
  return { done, tokenFile, lines, exchanged: () => exchanged }
}

test('consent stores a refresh token when both scopes are granted', async (t) => {
  const run = await consent(t, { access_token: 'a', refresh_token: 'refresh-new', scope: SCOPES })
  await run.done
  assert.equal(readToken(run.tokenFile).refresh_token, 'refresh-new')
  assert.equal(run.exchanged().get('code'), 'code-1')
  assert.ok(run.exchanged().get('code_verifier'))
  assert.ok(run.lines.every((line) => !line.includes('refresh-new') && !line.includes('client-secret')))
})

test('consent fails without a refresh token or with a missing scope', async (t) => {
  const noRefresh = await consent(t, { access_token: 'a', scope: SCOPES })
  await assert.rejects(noRefresh.done, /no refresh token/)
  const narrow = await consent(t, {
    access_token: 'a',
    refresh_token: 'r',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
  })
  await assert.rejects(narrow.done, /did not grant/)
})

test('consent refuses a redirect with the wrong state', async (t) => {
  const run = await consent(t, { refresh_token: 'r', scope: SCOPES }, () => '?state=forged&code=x')
  await assert.rejects(run.done, /state mismatch/)
})

test('the binary refuses to start without its configuration', () => {
  const result = spawnSync(process.execPath, [BINARY], { env: { PATH: process.env.PATH }, encoding: 'utf8' })
  assert.equal(result.status, 64)
  assert.match(result.stderr, /GOOGLE_MCP_CLIENT_FILE/)
  assert.equal(result.stdout, '')
})

test('--help names both environment variables', () => {
  const result = spawnSync(process.execPath, [BINARY, '--help'], { encoding: 'utf8' })
  assert.match(result.stdout, /GOOGLE_MCP_TOKEN_FILE/)
  assert.equal(readFileSync(BINARY, 'utf8').startsWith('#!/usr/bin/env node'), true)
})

test('a rate-limited GET is retried after Retry-After, then succeeds', async () => {
  const { googleApi } = await import('../dist/google.js')
  const tokens = { get: async () => 'token', invalidate() {} }
  const statuses = [429, 200]
  const api = googleApi(tokens, async () =>
    statuses.shift() === 429
      ? new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
      : jsonResponse({ ok: true }),
  )
  assert.deepEqual(await api.get(new URL('https://gmail.googleapis.com/gmail/v1/users/me/labels')), { ok: true })
})

test('check exits 3 when the token must be reconnected', (t) => {
  const dir = tempDir(t)
  const client = join(dir, 'client.json')
  writeFileSync(client, JSON.stringify({ installed: { client_id: 'a', client_secret: 'b' } }), { mode: 0o600 })
  const result = spawnSync(process.execPath, [BINARY, 'check'], {
    env: { PATH: process.env.PATH, GOOGLE_MCP_CLIENT_FILE: client, GOOGLE_MCP_TOKEN_FILE: join(dir, 'token.json') },
    encoding: 'utf8',
  })
  assert.equal(result.status, 3)
  assert.match(result.stderr, /reconnect Google/)
})
