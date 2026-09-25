import assert from 'node:assert/strict'
import test from 'node:test'

import { render } from '../render-digest.mjs'

const hostile = '<script>alert(1)</script>"\'&'

const digest = {
  date: '2026-09-25',
  generated_at: '2026-09-25T06:45:00+02:00',
  window: { after: 0, skipped_days: 2, clamped: true },
  warnings: ['mail window held more than 500 messages'],
  counts: { messages: 2, needs_action: 1, unsettled: 1, bulk: 1, events: 2 },
  calendar: {
    days: [
      {
        date: '2026-09-25',
        events: [
          { id: 'e1', start: '2026-09-25T09:00:00+02:00', end: '2026-09-25T10:00:00+02:00', title: hostile },
          {
            id: 'e2',
            start: '2026-09-25T09:30:00+02:00',
            end: '2026-09-25T11:00:00+02:00',
            title: 'Sync',
            with_others: true,
            has_agenda: false,
            new_people: ['pat@example.com'],
          },
        ],
      },
      { date: '2026-09-26', events: [] },
    ],
    overlaps: [['e1', 'e2']],
  },
  needs_action: [
    {
      id: 'm0',
      thread_id: 't0"><img',
      date: '2026-09-24T08:00:00.000Z',
      from: '"Doe, Jane" <jane@example.com>',
      subject: hostile,
      snippet: hostile,
      rule: 'person_awaiting_reply',
    },
  ],
  unsettled: [],
  receipts: [{ from: 'Shop <billing@shop.example>', subject: 'Receipt', receipt: { vendor: null, amount: null } }],
  bulk: [{ sender: 'no-reply@news.example', name: 'Example News <no-reply@news.example>', count: 3 }],
}

test('every mail and calendar value is escaped', () => {
  const html = render(digest)
  assert.equal(html.includes('<script>'), false)
  assert.equal(html.includes('<img'), false)
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&quot;&#39;&amp;/)
  assert.match(html, /href="https:\/\/mail\.google\.com\/mail\/u\/0\/#all\/t0%22%3E%3Cimg"/)
})

test('the page shows what the digest decided', () => {
  const html = render(digest)
  assert.match(html, /Skipped 2 days since the last digest; mail older than 7 days is not included\./)
  assert.match(html, /more than 500 messages/)
  assert.match(html, /Doe, Jane/)
  assert.match(html, /awaiting your reply/)
  assert.match(html, /class="tag warn">overlap/)
  assert.match(html, /no agenda/)
  assert.match(html, /New: pat@example\.com/)
  assert.match(html, /unparsed/)
  assert.match(html, /Example News<\/td><td class="num">3/)
  assert.match(html, /Nothing unsettled\./)
  assert.equal(/https?:\/\/(?!mail\.google\.com)/.test(html), false, 'the page loads nothing from the network')
})
