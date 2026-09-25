/**
 * Authorized GETs against the Gmail and Calendar REST APIs. The tools take
 * this interface, so tests substitute a fake Google without a network.
 */

import { setTimeout as sleep } from 'node:timers/promises'

import { ToolError } from './errors.js'
import type { AccessTokens } from './oauth.js'

export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const CALENDAR = 'https://www.googleapis.com/calendar/v3'

/** A non-success answer from Google, with its status for callers that handle one. */
export class ApiError extends ToolError {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message)
  }
}

const RETRIES = 3

export interface GoogleApi {
  /** GETs a JSON document. Failures are ToolErrors that quote no response body. */
  get(url: URL): Promise<unknown>
}

export function googleApi(tokens: AccessTokens, fetchImpl: typeof fetch = fetch): GoogleApi {
  return {
    async get(url: URL): Promise<unknown> {
      let response = await send(fetchImpl, url, await tokens.get())
      if (response.status === 401) {
        tokens.invalidate()
        response = await send(fetchImpl, url, await tokens.get())
      }
      // Rate limits and server errors are transient; back off a bounded number of times.
      for (let attempt = 1; attempt <= RETRIES && retryable(response.status); attempt += 1) {
        await sleep(backoffMs(response, attempt))
        response = await send(fetchImpl, url, await tokens.get())
      }
      if (!response.ok) {
        throw new ApiError(`${apiName(url)} answered ${response.status}${await reason(response)}`, response.status)
      }
      try {
        return await response.json()
      } catch {
        throw new ToolError(`${apiName(url)} answered without JSON`)
      }
    },
  }
}

function retryable(status: number): boolean {
  return status === 429 || status >= 500
}

/** Retry-After when Google sends one (capped at 10 s), else 1 s, 2 s, 4 s. */
function backoffMs(response: Response, attempt: number): number {
  const header = Number(response.headers.get('retry-after'))
  if (Number.isFinite(header) && header > 0) return Math.min(header, 10) * 1000
  return 1000 * 2 ** (attempt - 1)
}

async function send(fetchImpl: typeof fetch, url: URL, token: string): Promise<Response> {
  try {
    return await fetchImpl(url, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    throw new ToolError(`cannot reach ${apiName(url)}`)
  }
}

function apiName(url: URL): string {
  return url.hostname === 'gmail.googleapis.com' ? 'Gmail API' : 'Calendar API'
}

/** Google's machine-readable reason, e.g. `rateLimitExceeded`; never the message. */
async function reason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { errors?: { reason?: unknown }[]; status?: unknown } }
    const code = body.error?.errors?.[0]?.reason ?? body.error?.status
    return typeof code === 'string' && /^[A-Za-z_]{1,64}$/.test(code) ? ` (${code})` : ''
  } catch {
    return ''
  }
}
