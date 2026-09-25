#!/usr/bin/env node
/**
 * Serves the real tools over real stdio, backed by a fake Google that answers
 * from `test/helpers/fake-google.mjs`. Used by the protocol tests and by the
 * offline ptc probe; it never touches the network or a credential.
 */

import { serveStdio } from '@modelcontextprotocol/server/stdio'

import { createServer, IDENTITY } from '../../dist/index.js'
import { fakeGoogle } from './fake-google.mjs'

const google = fakeGoogle({ count: Number(process.env.FAKE_GOOGLE_COUNT ?? 3) })
serveStdio(() => createServer(google, IDENTITY), { legacy: 'reject' })
