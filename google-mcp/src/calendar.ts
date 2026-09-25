/** Pure shaping of Calendar events into the trimmed records the digest reads. */

/** Partial response filter: descriptions are fetched only to set has_agenda. */
export const EVENT_FIELDS =
  'nextPageToken,items(id,status,summary,location,description,start,end,' +
  'organizer(email,self),attendees(email,self,organizer,resource,responseStatus))'

export interface CalendarEvent {
  id?: string
  status?: string
  summary?: string
  location?: string
  description?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  organizer?: { email?: string; self?: boolean }
  attendees?: { email?: string; self?: boolean; organizer?: boolean; resource?: boolean; responseStatus?: string }[]
}

export interface Attendee {
  email: string
  self: boolean
  organizer: boolean
  response_status: string | null
}

export interface EventRecord {
  calendar_id: string
  id: string
  start: string | null
  end: string | null
  all_day: boolean
  title: string
  location: string | null
  organizer: string | null
  organizer_self: boolean
  my_response: string | null
  attendees: Attendee[]
  with_others: boolean
  has_agenda: boolean
}

export function toEventRecord(calendarId: string, event: CalendarEvent): EventRecord {
  // Rooms and other resources are not people.
  const attendees: Attendee[] = (event.attendees ?? [])
    .filter((attendee) => attendee.resource !== true && typeof attendee.email === 'string')
    .map((attendee) => ({
      email: attendee.email!.toLowerCase(),
      self: attendee.self === true,
      organizer: attendee.organizer === true,
      response_status: attendee.responseStatus ?? null,
    }))
  const organizerSelf = event.organizer?.self === true
  const organizer = event.organizer?.email?.toLowerCase() ?? null
  const withOthers =
    attendees.some((attendee) => !attendee.self) ||
    (organizer !== null && !organizerSelf && !organizer.endsWith('calendar.google.com'))
  return {
    calendar_id: calendarId,
    id: event.id ?? '',
    start: event.start?.dateTime ?? event.start?.date ?? null,
    end: event.end?.dateTime ?? event.end?.date ?? null,
    all_day: event.start?.dateTime === undefined && event.start?.date !== undefined,
    title: event.summary ?? '',
    location: event.location ?? null,
    organizer,
    organizer_self: organizerSelf,
    my_response: attendees.find((attendee) => attendee.self)?.response_status ?? null,
    attendees,
    with_others: withOthers,
    has_agenda: (event.description ?? '').trim() !== '',
  }
}
