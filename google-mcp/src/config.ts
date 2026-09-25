/**
 * Private runtime configuration. Both paths come from the environment and
 * point into `$PTC_ASSISTANT_DATA`; neither is ever a constant in source.
 */

import { readFileSync, statSync } from 'node:fs'

import { ConfigError } from './errors.js'

export const CLIENT_FILE_ENV = 'GOOGLE_MCP_CLIENT_FILE'
export const TOKEN_FILE_ENV = 'GOOGLE_MCP_TOKEN_FILE'

/** The only scopes this server ever requests. See docs/google-cloud-setup.md. */
export const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/calendar.readonly',
] as const

/** Fixed Google endpoints; the URIs inside the client JSON are not trusted. */
export const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'

export interface OAuthClient {
  readonly clientId: string
  readonly clientSecret: string
}

export interface Paths {
  readonly clientFile: string
  readonly tokenFile: string
}

export function pathsFromEnvironment(env: NodeJS.ProcessEnv = process.env): Paths {
  const clientFile = env[CLIENT_FILE_ENV]
  const tokenFile = env[TOKEN_FILE_ENV]
  if (!clientFile) throw new ConfigError(`${CLIENT_FILE_ENV} must name the Desktop OAuth client JSON`)
  if (!tokenFile) throw new ConfigError(`${TOKEN_FILE_ENV} must name the refresh-token file`)
  return { clientFile, tokenFile }
}

/** Refuses a secret file that anyone but the owner could read. */
export function assertOwnerOnly(path: string, what: string): void {
  let mode: number
  try {
    mode = statSync(path).mode
  } catch {
    throw new ConfigError(`${what} is missing or unreadable`)
  }
  if ((mode & 0o077) !== 0) throw new ConfigError(`${what} must be readable by its owner only (mode 0600)`)
}

/** Reads a Desktop ("installed") OAuth client. A Web client is refused. */
export function loadClient(path: string): OAuthClient {
  assertOwnerOnly(path, 'the OAuth client file')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ConfigError('the OAuth client file is not valid JSON')
  }
  const installed = (parsed as { installed?: Record<string, unknown> } | null)?.installed
  if (installed === undefined || installed === null || typeof installed !== 'object') {
    throw new ConfigError('the OAuth client file is not a Desktop app client (no "installed" section)')
  }
  const { client_id: clientId, client_secret: clientSecret } = installed
  if (typeof clientId !== 'string' || clientId === '' || typeof clientSecret !== 'string' || clientSecret === '') {
    throw new ConfigError('the OAuth client file lacks client_id or client_secret')
  }
  return { clientId, clientSecret }
}
