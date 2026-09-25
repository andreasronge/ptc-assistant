/**
 * Authorized GETs against the Gmail and Calendar REST APIs. The tools take
 * this interface, so tests substitute a fake Google without a network.
 */

import { ToolError } from './errors.js'
import type { AccessTokens } from './oauth.js'

export const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me'
export const CALENDAR = 'https://www.googleapis.com/calendar/v3'

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
      if (!response.ok) throw new ToolError(`${apiName(url)} answered ${response.status}${await reason(response)}`)
      try {
        return await response.json()
      } catch {
        throw new ToolError(`${apiName(url)} answered without JSON`)
      }
    },
  }
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
