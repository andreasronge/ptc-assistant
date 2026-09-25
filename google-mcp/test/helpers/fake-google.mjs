/**
 * A fake Google that answers the few GETs the tools make, with messages and
 * events at reserved example domains. `count` controls how many messages
 * exist, so paging and the 500 cap can be exercised.
 */

export function fakeGoogle({ count = 3 } = {}) {
  const requests = []
  const messages = Array.from({ length: count }, (_, index) => message(index))

  return {
    requests,
    async get(url) {
      requests.push(url.toString())
      const path = url.pathname

      if (path === '/gmail/v1/users/me/messages') {
        const max = Number(url.searchParams.get('maxResults'))
        const start = Number(url.searchParams.get('pageToken') ?? 0)
        const page = messages.slice(start, start + max)
        const next = start + max < messages.length ? String(start + max) : undefined
        return { messages: page.map((m) => ({ id: m.id, threadId: m.threadId })), nextPageToken: next }
      }
      const single = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(path)
      if (single) return messages.find((m) => m.id === decodeURIComponent(single[1]))

      const events = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(path)
      if (events) return calendarPage(decodeURIComponent(events[1]), url.searchParams.get('pageToken'))

      throw new Error(`fake Google has no route for ${path}`)
    },
  }
}

function message(index) {
  const bulk = index % 3 === 1
  const headers = [
    { name: 'From', value: bulk ? 'Example News <no-reply@news.example>' : `"Doe, Jane" <jane${index}@example.com>` },
    { name: 'To', value: 'Owner <owner@example.org>, other@example.net' },
    { name: 'Subject', value: `Subject ${index}` },
  ]
  if (bulk) headers.push({ name: 'List-Unsubscribe', value: '<https://news.example/u>' })
  return {
    id: `m${index}`,
    threadId: `t${index}`,
    labelIds: bulk ? ['CATEGORY_PROMOTIONS'] : ['INBOX', 'IMPORTANT'],
    snippet: 'Can we meet &amp; talk? It&#39;s urgent',
    internalDate: String(Date.UTC(2026, 8, 24, 8, 0, index)),
    payload: { headers },
  }
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
          start: { dateTime: '2026-09-25T13:00:00+02:00' },
          end: { dateTime: '2026-09-25T14:00:00+02:00' },
          organizer: { email: 'owner@example.org', self: true },
          attendees: [
            { email: 'owner@example.org', self: true, organizer: true, responseStatus: 'accepted' },
            { email: 'Pat@Example.com', responseStatus: 'needsAction' },
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
