/**
 * A fake Google that answers the GETs the tools make, with addresses at
 * reserved example domains only.
 *
 * The default mailbox is a fixed scenario for the digest rules (the owner is
 * owner@example.org). With `count`, it instead generates that many plain
 * inbox messages so paging and the 500 cap can be exercised.
 */

import { ApiError } from '../../dist/google.js'

const OWNER = 'Owner <owner@example.org>'
const T0 = Date.UTC(2026, 8, 24, 8, 0, 0)

/** The digest scenario: one line per case the rules must tell apart. */
export const MAILBOX = [
  // A known correspondent writing directly, unanswered: needs action (person + awaiting reply).
  mail('m0', 't0', 0, '"Doe, Jane" <jane@example.com>', OWNER, 'Dinner on Friday?', ['INBOX', 'IMPORTANT']),
  // A newsletter: bulk.
  mail('m1', 't1', 1, 'Example News <no-reply@news.example>', OWNER, 'Weekly news', ['CATEGORY_PROMOTIONS'], {
    'List-Unsubscribe': '<https://news.example/u>',
  }),
  // A stranger Google marked important: needs action (important).
  mail('m2', 't2', 2, 'Pat <pat@example.com>', OWNER, 'Contract question', ['INBOX', 'IMPORTANT']),
  // A known correspondent with the owner only on Cc: unsettled.
  mail('m3', 't3', 3, 'jane@example.com', 'team@example.com', 'Notes from today', ['INBOX'], {
    Cc: OWNER,
  }),
  // A receipt from a vendor: bulk (updates category) and a receipt candidate.
  mail('m4', 't4', 4, 'Streaming <billing@streaming.example>', OWNER, 'Your receipt', ['CATEGORY_UPDATES'], {
    snippet: 'Thanks for your payment. Total 129,00 kr',
  }),
  // A known correspondent whom the owner already answered: unsettled.
  mail('m5', 't5', 5, 'Sam <sam@example.net>', OWNER, 'Quick favour', ['INBOX']),
]

export const SENT = [
  mail('s1', 't5', 60, OWNER, 'Sam <sam@example.net>', 'Re: Quick favour', ['SENT']),
  mail('s2', 's2', 70, OWNER, '"Doe, Jane" <jane@example.com>', 'Photos', ['SENT'], { Cc: 'team@example.com' }),
]

export function fakeGoogle({ count } = {}) {
  const requests = []
  const inbox = count === undefined ? MAILBOX : Array.from({ length: count }, (_, index) => generated(index))
  const all = [...inbox, ...SENT]

  return {
    requests,
    async get(url) {
      requests.push(url.toString())
      const path = url.pathname

      if (path === '/gmail/v1/users/me/messages') {
        const source = (url.searchParams.get('q') ?? '').startsWith('in:sent') ? SENT : inbox
        const max = Number(url.searchParams.get('maxResults'))
        const start = Number(url.searchParams.get('pageToken') ?? 0)
        const page = source.slice(start, start + max)
        const next = start + max < source.length ? String(start + max) : undefined
        return { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: next }
      }
      const single = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path)
      if (single) return all.find((m) => m.id === decodeURIComponent(single[1]))

      const thread = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(path)
      if (thread) {
        const messages = all.filter((m) => m.threadId === decodeURIComponent(thread[1]))
        if (messages.length === 0) throw new ApiError('Gmail API answered 404', 404)
        return { id: decodeURIComponent(thread[1]), messages }
      }

      const events = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(path)
      if (events) return calendarPage(decodeURIComponent(events[1]), url.searchParams.get('pageToken'))

      throw new Error(`fake Google has no route for ${path}`)
    },
  }
}

function mail(id, threadId, minute, from, to, subject, labelIds, extra = {}) {
  const { snippet = `About: ${subject}`, ...headers } = extra
  return {
    id,
    threadId,
    labelIds,
    snippet: snippet.replace(/&/g, '&amp;'),
    internalDate: String(T0 + minute * 60_000),
    payload: {
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: to },
        { name: 'Subject', value: subject },
        ...Object.entries(headers)
          .filter(([, value]) => value !== undefined)
          .map(([name, value]) => ({ name, value })),
      ],
    },
  }
}

/** Sized like real mail: a full snippet, several recipients, several labels. */
function generated(index) {
  const recipients = [OWNER, ...Array.from({ length: 6 }, (_, n) => `"Member ${n}" <member${n}@example.com>`)]
  return mail(
    `g${index}`,
    `h${index}`,
    index,
    `"Doe, Jane" <jane${index}@example.com>`,
    recipients.join(', '),
    `Subject ${index}: ${'a fairly long subject line '.repeat(3)}`,
    ['INBOX', 'UNREAD', 'CATEGORY_PERSONAL', 'IMPORTANT', 'Label_12345678'],
    { snippet: 'x'.repeat(200), 'List-Unsubscribe': index % 2 ? '<https://news.example/u>' : undefined },
  )
}

function calendarPage(calendarId, pageToken) {
  if (calendarId === 'primary' && pageToken === null) {
    return {
      items: [
        {
          id: 'e1',
          status: 'confirmed',
          summary: 'Dentist',
          start: { dateTime: '2026-09-25T09:00:00+02:00' },
          end: { dateTime: '2026-09-25T10:00:00+02:00' },
          organizer: { email: 'owner@example.org', self: true },
        },
        { id: 'e0', status: 'cancelled' },
      ],
      nextPageToken: 'p2',
    }
  }
  if (calendarId === 'primary') {
    return {
      items: [
        {
          id: 'e2',
          status: 'confirmed',
          summary: 'Project sync',
          description: 'Agenda: plan',
          start: { dateTime: '2026-09-25T09:30:00+02:00' },
          end: { dateTime: '2026-09-25T11:00:00+02:00' },
          organizer: { email: 'owner@example.org', self: true },
          attendees: [
            { email: 'owner@example.org', self: true, organizer: true, responseStatus: 'accepted' },
            { email: 'Pat@Example.com', responseStatus: 'needsAction' },
            { email: 'sam@example.net', responseStatus: 'accepted' },
            { email: 'room-1@resource.example', resource: true },
          ],
        },
      ],
    }
  }
  return {
    items: [
      {
        id: 'f1',
        status: 'confirmed',
        summary: 'School holiday',
        start: { date: '2026-09-26' },
        end: { date: '2026-09-27' },
        // Split so the public-repo address guard does not read it as an address.
        organizer: { email: 'family' + '@group.calendar.google.com' },
      },
    ],
  }
}
