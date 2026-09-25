import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { BINARY, call, callFailing, collect, withServer } from './helpers/harness.mjs'

test('advertises exactly the read-only tools, all marked read-only', async () => {
  await withServer(async (server) => {
    const tools = (await server.request('tools/list')).result.tools
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [
      'get_threads',
      'list_events',
      'list_sent_recipients',
      'search_messages',
    ])
    for (const tool of tools) {
      assert.equal(tool.annotations.readOnlyHint, true)
      assert.equal(tool.annotations.destructiveHint, false)
    }
  })
})

test('advertises the 2026-07-28 profile only', async () => {
  await withServer(async (server) => {
    const result = (await server.request('server/discover')).result
    assert.deepEqual(result.supportedVersions, ['2026-07-28'])
    assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'google-mcp')
  })
})

test('search_messages returns trimmed metadata with parsed addresses and bulk flags', async () => {
  await withServer(async (server) => {
    const result = await call(server, 'search_messages', { query: 'newer_than:1d' })
    assert.equal(result.next_cursor, null)
    assert.equal(result.truncated, false)
    assert.equal(result.items.length, 6)

    const [person, bulk, , cc, receipt] = result.items
    assert.equal(person.id, 'm0')
    assert.equal(person.thread_id, 't0')
    assert.equal(person.from_address, 'jane@example.com')
    assert.deepEqual(person.to_addresses, ['owner@example.org'])
    assert.equal(person.list_unsubscribe, false)
    assert.equal(person.date, '2026-09-24T08:00:00.000Z')
    assert.deepEqual(person.label_ids, ['INBOX', 'IMPORTANT'])

    assert.equal(bulk.from_address, 'no-reply@news.example')
    assert.equal(bulk.list_unsubscribe, true)
    assert.equal('body' in bulk, false, 'no bodies in search results')
    assert.deepEqual(cc.cc_addresses, ['owner@example.org'])
    assert.equal(receipt.snippet, 'Thanks for your payment. Total 129,00 kr')
  })
})

test('get_threads returns messages oldest first and marks a missing thread', async () => {
  await withServer(async (server) => {
    const { items } = await call(server, 'get_threads', { thread_ids: ['t5', 't0', 'ffff'] })
    assert.deepEqual(
      items.map((thread) => [thread.thread_id, thread.missing, thread.messages.map((m) => m.id)]),
      [
        ['t5', false, ['m5', 's1']],
        ['t0', false, ['m0']],
        ['ffff', true, []],
      ],
    )
    assert.deepEqual(items[0].messages[1].label_ids, ['SENT'])
    const refused = await callFailing(server, 'get_threads', { thread_ids: ['not an id'] })
    assert.match(refused, /Gmail thread ids/)
  })
})

test('list_sent_recipients returns the distinct To and Cc addresses of sent mail', async () => {
  await withServer(async (server) => {
    const result = await call(server, 'list_sent_recipients', { after: 1758000000 })
    assert.deepEqual(result.addresses, ['jane@example.com', 'sam@example.net', 'team@example.com'])
    assert.equal(result.messages_scanned, 2)
    assert.equal(result.next_cursor, null)
    const reversed = await callFailing(server, 'list_sent_recipients', { after: 10, before: 5 })
    assert.match(reversed, /later than after/)
  })
})

test('search_messages pages at 100 and stops at 500 in total', async () => {
  await withServer(
    async (server) => {
      const { items, pages, truncated } = await collect(server, 'search_messages', { query: 'in:inbox' })
      assert.equal(items.length, 500)
      assert.equal(pages, 5)
      assert.equal(truncated, true)
      assert.equal(new Set(items.map((item) => item.id)).size, 500)
    },
    { env: { FAKE_GOOGLE_COUNT: '620' } },
  )
})

test('a cursor is refused for different arguments', async () => {
  await withServer(
    async (server) => {
      const first = await call(server, 'search_messages', { query: 'in:inbox', limit: 2 })
      assert.notEqual(first.next_cursor, null)
      const refused = await callFailing(server, 'search_messages', { query: 'in:sent', cursor: first.next_cursor })
      assert.match(refused, /different arguments/)
    },
    { env: { FAKE_GOOGLE_COUNT: '5' } },
  )
})

test('list_events walks calendars in order, drops cancelled events and resources', async () => {
  await withServer(async (server) => {
    const { items } = await collect(server, 'list_events', {
      time_min: '2026-09-25T00:00:00+02:00',
      time_max: '2026-09-27T00:00:00+02:00',
      calendar_ids: ['primary', 'family-id'],
    })
    assert.deepEqual(
      items.map((event) => event.id),
      ['e1', 'e2', 'f1'],
    )
    const [solo, meeting, holiday] = items
    assert.equal(solo.with_others, false)
    assert.equal(solo.has_agenda, false)
    assert.equal(meeting.with_others, true)
    assert.equal(meeting.has_agenda, true)
    assert.equal(meeting.my_response, 'accepted')
    assert.deepEqual(
      meeting.attendees.map((attendee) => attendee.email),
      ['owner@example.org', 'pat@example.com', 'sam@example.net'],
    )
    assert.equal(holiday.calendar_id, 'family-id')
    assert.equal(holiday.all_day, true)
    assert.equal(holiday.with_others, false, 'a shared calendar as organizer is not another person')
  })
})

test('list_events validates its window', async () => {
  await withServer(async (server) => {
    const reversed = await callFailing(server, 'list_events', {
      time_min: '2026-09-26T00:00:00Z',
      time_max: '2026-09-25T00:00:00Z',
    })
    assert.match(reversed, /before time_max/)
    const naive = await callFailing(server, 'list_events', {
      time_min: '2026-09-25T00:00:00',
      time_max: '2026-09-26T00:00:00Z',
    })
    assert.match(naive, /RFC 3339/)
  })
})

test('the real binary without a token answers every call with "reconnect Google"', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'google-mcp-test-'))
  try {
    const clientFile = join(dir, 'client.json')
    writeFileSync(clientFile, JSON.stringify({ installed: { client_id: 'id', client_secret: 'secret' } }), {
      mode: 0o600,
    })
    await withServer(
      async (server) => {
        const failure = await callFailing(server, 'search_messages', { query: 'in:inbox' })
        assert.match(failure, /reconnect Google/)
        assert.doesNotMatch(failure, /secret/)
      },
      {
        script: BINARY,
        env: { GOOGLE_MCP_CLIENT_FILE: clientFile, GOOGLE_MCP_TOKEN_FILE: join(dir, 'token.json') },
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
