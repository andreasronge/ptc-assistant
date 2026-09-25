/**
 * google-mcp -- a read-only Gmail and Google Calendar MCP server over stdio.
 *
 * The binary is what ptc launches. The library entry exists so tests can
 * serve the same tools over a fake Google.
 */

import { createRequire } from 'node:module'

import type { ServerIdentity } from './tools.js'

const manifest = createRequire(import.meta.url)('../package.json') as { name: string; version: string }

/** This package's name and version, as the server reports them to a client. */
export const IDENTITY: ServerIdentity = { name: 'google-mcp', version: manifest.version }

export { createServer, PAGE_LIMIT, TOTAL_LIMIT } from './tools.js'
export type { ServerIdentity } from './tools.js'
export type { GoogleApi } from './google.js'
export { parseAddresses, decodeEntities, toRecord } from './mail.js'
export { toEventRecord } from './calendar.js'
export { ConfigError, ReconnectError, ToolError } from './errors.js'
