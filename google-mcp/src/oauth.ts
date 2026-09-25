/**
 * Google OAuth for one Desktop client: the one-time loopback consent, and
 * refresh of short-lived access tokens from the stored refresh token.
 *
 * Nothing here logs the authorization code, an access token, the refresh
 * token, or the client secret.
 */

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'

import { AUTH_ENDPOINT, SCOPES, TOKEN_ENDPOINT, type OAuthClient } from './config.js'
import { ConfigError, ReconnectError, ToolError } from './errors.js'
import { readToken, withTokenLock, writeToken } from './token-store.js'

type Fetch = typeof fetch

interface TokenResponse {
  access_token?: string
  expires_in?: number
  refresh_token?: string
  scope?: string
  error?: string
}

const REFRESH_MARGIN_MS = 60_000
const CONSENT_TIMEOUT_MS = 10 * 60_000

/**
 * Hands out access tokens, refreshing under the token lock when the cached
 * one is near expiry. `invalid_grant` is terminal for the process lifetime.
 */
export class AccessTokens {
  #cached: { token: string; expiresAt: number } | undefined
  #revoked: string | undefined

  constructor(
    private readonly client: OAuthClient,
    private readonly tokenFile: string,
    private readonly fetchImpl: Fetch = fetch,
  ) {}

  async get(): Promise<string> {
    if (this.#revoked !== undefined) throw new ReconnectError(this.#revoked)
    if (this.#cached !== undefined && this.#cached.expiresAt - REFRESH_MARGIN_MS > Date.now()) {
      return this.#cached.token
    }
    return this.refresh()
  }

  /** Drops the cached access token, after Google answered 401 to it. */
  invalidate(): void {
    this.#cached = undefined
  }

  private async refresh(): Promise<string> {
    return withTokenLock(this.tokenFile, async () => {
      const stored = readToken(this.tokenFile)
      const body = await postForm(this.fetchImpl, {
        grant_type: 'refresh_token',
        refresh_token: stored.refresh_token,
        client_id: this.client.clientId,
        client_secret: this.client.clientSecret,
      })
      if (body.error === 'invalid_grant') {
        this.#revoked = 'Google revoked or expired the stored token'
        throw new ReconnectError(this.#revoked)
      }
      if (body.error !== undefined || typeof body.access_token !== 'string') {
        throw new ToolError(`Google token refresh failed${body.error ? ` (${body.error})` : ''}`)
      }
      // Google normally keeps the refresh token; if it ever rotates one, keep it.
      if (typeof body.refresh_token === 'string' && body.refresh_token !== stored.refresh_token) {
        writeToken(this.tokenFile, { ...stored, refresh_token: body.refresh_token })
      }
      this.#cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 }
      return body.access_token
    })
  }
}

export interface ConsentOptions {
  readonly client: OAuthClient
  readonly tokenFile: string
  readonly port: number
  /** Where the instructions and the consent URL go. Never a secret. */
  readonly say: (line: string) => void
  readonly fetchImpl?: Fetch
}

/**
 * Runs the loopback consent flow once and stores the refresh token.
 *
 * Asks for exactly the two read-only scopes with `prompt=consent`, so Google
 * issues a fresh refresh token; fails unless one came back with both scopes
 * granted and nothing more.
 */
export async function runConsent(options: ConsentOptions): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const verifier = randomBytes(32).toString('base64url')
  const state = randomBytes(16).toString('base64url')
  const redirectUri = `http://127.0.0.1:${options.port}`

  const url = new URL(AUTH_ENDPOINT)
  url.search = new URLSearchParams({
    client_id: options.client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPES.join(' '),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
  }).toString()

  options.say(`Listening on ${redirectUri} for Google's redirect.`)
  options.say(`From your laptop: ssh -L ${options.port}:127.0.0.1:${options.port} <box>`)
  options.say('Then open this URL in the laptop browser and grant both read-only scopes:')
  options.say(url.toString())

  const code = await awaitRedirect(options.port, state)
  const body = await postForm(fetchImpl, {
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri,
    client_id: options.client.clientId,
    client_secret: options.client.clientSecret,
  })
  if (body.error !== undefined) throw new ConfigError(`Google refused the code exchange (${body.error})`)
  if (typeof body.refresh_token !== 'string' || body.refresh_token === '') {
    throw new ConfigError('Google returned no refresh token; revoke the app at myaccount.google.com and retry')
  }
  const granted = (body.scope ?? '').split(' ').filter((scope) => scope !== '')
  const missing = SCOPES.filter((scope) => !granted.includes(scope))
  const extra = granted.filter((scope) => !(SCOPES as readonly string[]).includes(scope))
  if (missing.length > 0) throw new ConfigError(`consent did not grant: ${missing.join(', ')}`)
  if (extra.length > 0) throw new ConfigError(`consent granted unexpected scopes: ${extra.join(', ')}`)

  const refreshToken = body.refresh_token
  await withTokenLock(options.tokenFile, async () =>
    writeToken(options.tokenFile, {
      version: 1,
      refresh_token: refreshToken,
      scopes: granted,
      created_at: new Date().toISOString(),
    }),
  )
  options.say('Stored a new refresh token.')
}

/** Serves one redirect on loopback and resolves with its authorization code. */
function awaitRedirect(port: number, state: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let server: Server | undefined = undefined
    const finish = (error: Error | undefined, code?: string): void => {
      clearTimeout(timer)
      server?.close()
      if (error !== undefined) reject(error)
      else resolve(code!)
    }
    const timer = setTimeout(() => finish(new ConfigError('timed out waiting for consent')), CONSENT_TIMEOUT_MS)

    server = createServer((request, response) => {
      const params = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams
      if (!params.has('state') && !params.has('error')) {
        response.writeHead(404).end()
        return
      }
      const reply = (status: number, text: string): void => {
        response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' }).end(`${text}\n`)
      }
      if (params.get('state') !== state) {
        reply(400, 'State mismatch; start `google-mcp auth` again.')
        finish(new ConfigError('state mismatch in the redirect'))
        return
      }
      const error = params.get('error')
      const code = params.get('code')
      if (error !== null || code === null) {
        reply(400, 'Consent was not granted.')
        finish(new ConfigError(`consent was not granted (${error ?? 'no code'})`))
        return
      }
      reply(200, 'Done. You can close this tab.')
      finish(undefined, code)
    })
    server.on('error', () => finish(new ConfigError(`cannot listen on 127.0.0.1:${port}`)))
    server.listen(port, '127.0.0.1')
  })
}

async function postForm(fetchImpl: Fetch, form: Record<string, string>): Promise<TokenResponse> {
  let response: Response
  try {
    response = await fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    throw new ToolError('cannot reach the Google token endpoint')
  }
  try {
    return (await response.json()) as TokenResponse
  } catch {
    throw new ToolError(`Google token endpoint answered ${response.status} without JSON`)
  }
}
