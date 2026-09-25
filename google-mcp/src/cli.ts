#!/usr/bin/env node
/**
 * The binary. With no command it serves MCP over stdio for ptc; `auth` runs
 * the one-time loopback consent on the box.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { CLIENT_FILE_ENV, loadClient, pathsFromEnvironment, TOKEN_FILE_ENV } from './config.js'
import { ConfigError, ReconnectError } from './errors.js'
import { googleApi } from './google.js'
import { createServer, IDENTITY } from './index.js'
import { AccessTokens, runConsent } from './oauth.js'

const DEFAULT_PORT = 8765
const RECONNECT_EXIT = 3

const USAGE = `google-mcp ${IDENTITY.version} -- read-only Gmail and Calendar MCP server over stdio

Usage:
  google-mcp                 Serve MCP 2026-07-28 over stdio.
  google-mcp auth [--port N] Run the loopback consent and store a refresh token.
                             Default port ${DEFAULT_PORT}; reach it through an SSH tunnel.
  google-mcp check           Refresh an access token once. Exit 0 when Google
                             accepts the stored token, ${RECONNECT_EXIT} when it must be
                             reconnected, 1 on any other failure.
  google-mcp --help | --version

Environment:
  ${CLIENT_FILE_ENV}  Desktop OAuth client JSON (mode 0600).
  ${TOKEN_FILE_ENV}   Refresh-token file (mode 0600), written by \`auth\`.

Requests only gmail.readonly and calendar.readonly. Protocol messages go to
stdout, diagnostics to stderr. Nothing logs codes, tokens, or the client secret.`

async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes('--help')) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  if (argv.includes('--version')) {
    process.stdout.write(`${IDENTITY.version}\n`)
    return
  }

  const paths = pathsFromEnvironment()
  const client = loadClient(paths.clientFile)

  if (argv[0] === 'auth') {
    const port = parsePort(argv.slice(1))
    await runConsent({
      client,
      tokenFile: paths.tokenFile,
      port,
      say: (line) => process.stderr.write(`${line}\n`),
    })
    return
  }
  if (argv[0] === 'check' && argv.length === 1) {
    try {
      await new AccessTokens(client, paths.tokenFile).get()
      process.stderr.write('google-mcp: Google accepts the stored token\n')
    } catch (error) {
      process.stderr.write(`google-mcp: ${error instanceof Error ? error.message : 'check failed'}\n`)
      process.exitCode = error instanceof ReconnectError ? RECONNECT_EXIT : 1
    }
    return
  }
  if (argv.length > 0) throw new ConfigError(`unknown arguments: ${argv.join(' ')}`)

  // A missing or revoked token is not a startup failure: every call then
  // answers "reconnect Google", which the workflow and cron script report.
  const api = googleApi(new AccessTokens(client, paths.tokenFile))
  const transport = serveStdio(() => createServer(api, IDENTITY), {
    legacy: 'reject',
    onerror: () => process.stderr.write('google-mcp transport error\n'),
  })
  const shutdown = (): void => {
    void Promise.resolve()
      .then(() => transport.close())
      .finally(() => process.exit(0))
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

function parsePort(argv: readonly string[]): number {
  if (argv.length === 0) return DEFAULT_PORT
  if (argv.length !== 2 || argv[0] !== '--port' || !/^[1-9][0-9]{0,4}$/.test(argv[1]!) || Number(argv[1]) > 65535) {
    throw new ConfigError('usage: google-mcp auth [--port N]')
  }
  return Number(argv[1])
}

main(process.argv.slice(2)).catch((error: unknown) => {
  const known = error instanceof Error && ['ConfigError', 'ToolError', 'ReconnectError'].includes(error.name)
  process.stderr.write(`google-mcp: ${known ? (error as Error).message : 'failed'}\n`)
  process.exit(64)
})
