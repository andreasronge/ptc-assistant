/**
 * The refresh-token file: owner-only, written atomically, and guarded by an
 * exclusive lock so a manual run during cron cannot corrupt it.
 */

import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

import { assertOwnerOnly } from './config.js'
import { ConfigError, ReconnectError } from './errors.js'

export interface StoredToken {
  readonly version: 1
  readonly refresh_token: string
  readonly scopes: readonly string[]
  readonly created_at: string
}

const LOCK_WAIT_MS = 15_000
const LOCK_STALE_MS = 120_000
const LOCK_POLL_MS = 100

/** Reads the stored token. A missing file means consent never happened. */
export function readToken(path: string): StoredToken {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    throw new ReconnectError('no stored Google token')
  }
  assertOwnerOnly(path, 'the token file')
  let parsed: Partial<StoredToken>
  try {
    parsed = JSON.parse(text) as Partial<StoredToken>
  } catch {
    throw new ReconnectError('the stored Google token is unreadable')
  }
  if (parsed.version !== 1 || typeof parsed.refresh_token !== 'string' || !Array.isArray(parsed.scopes)) {
    throw new ReconnectError('the stored Google token is unreadable')
  }
  return parsed as StoredToken
}

/** Writes beside the target at mode 0600, syncs, then renames over it. */
export function writeToken(path: string, token: StoredToken): void {
  const temporary = `${path}.tmp-${process.pid}`
  const descriptor = openSync(temporary, 'w', 0o600)
  try {
    writeSync(descriptor, `${JSON.stringify(token, null, 2)}\n`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
}

/**
 * Runs `action` while holding `<path>.lock`, created exclusively. A lock older
 * than two minutes belongs to a crashed process and is taken over.
 */
export async function withTokenLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const lock = `${path}.lock`
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    try {
      closeSync(openSync(lock, 'wx', 0o600))
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new ConfigError('cannot create the token lock')
      if (isStale(lock)) {
        removeQuietly(lock)
        continue
      }
      if (Date.now() > deadline) throw new ConfigError('timed out waiting for the token lock')
      await sleep(LOCK_POLL_MS)
    }
  }
  try {
    return await action()
  } finally {
    removeQuietly(lock)
  }
}

function isStale(lock: string): boolean {
  try {
    return Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS
  } catch {
    return false
  }
}

function removeQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Already gone: another process took over a stale lock.
  }
}
