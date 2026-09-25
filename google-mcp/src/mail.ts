/** Pure shaping of Gmail metadata into the trimmed records the workflows read. */

/** Headers fetched per message: what the rules need, nothing more. */
export const METADATA_HEADERS = [
  'From',
  'To',
  'Cc',
  'Subject',
  'List-Unsubscribe',
  'Precedence',
  'Auto-Submitted',
] as const

export interface GmailMessage {
  id?: string
  threadId?: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: { headers?: { name?: string; value?: string }[] }
}

export interface MessageRecord {
  id: string
  thread_id: string
  date: string | null
  from: string
  from_address: string | null
  to_addresses: string[]
  cc_addresses: string[]
  subject: string
  snippet: string
  label_ids: string[]
  list_unsubscribe: boolean
  precedence: string | null
  auto_submitted: string | null
}

export function toRecord(message: GmailMessage): MessageRecord {
  const headers = new Map<string, string>()
  for (const header of message.payload?.headers ?? []) {
    if (typeof header.name === 'string' && typeof header.value === 'string') {
      const name = header.name.toLowerCase()
      if (!headers.has(name)) headers.set(name, header.value)
    }
  }
  const from = headers.get('from') ?? ''
  const millis = Number(message.internalDate)
  return {
    id: message.id ?? '',
    thread_id: message.threadId ?? '',
    date: Number.isFinite(millis) && millis > 0 ? new Date(millis).toISOString() : null,
    from,
    from_address: parseAddresses(from)[0] ?? null,
    to_addresses: parseAddresses(headers.get('to') ?? ''),
    cc_addresses: parseAddresses(headers.get('cc') ?? ''),
    subject: headers.get('subject') ?? '',
    snippet: decodeEntities(message.snippet ?? ''),
    label_ids: message.labelIds ?? [],
    list_unsubscribe: headers.has('list-unsubscribe'),
    precedence: headers.get('precedence')?.trim().toLowerCase() ?? null,
    auto_submitted: headers.get('auto-submitted')?.trim().toLowerCase() ?? null,
  }
}

/**
 * Lower-cased addresses from an RFC 5322 address-list header. Handles quoted
 * display names with commas, angle-bracket addresses, and bare addresses;
 * groups and comments are reduced to the addresses they contain.
 */
export function parseAddresses(header: string): string[] {
  const addresses: string[] = []
  let current = ''
  let quoted = false
  let angle = 0
  const flush = (): void => {
    const address = extractAddress(current)
    if (address !== null) addresses.push(address)
    current = ''
  }
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index]!
    if (character === '\\' && quoted) {
      current += character + (header[index + 1] ?? '')
      index += 1
      continue
    }
    if (character === '"') quoted = !quoted
    else if (!quoted && character === '<') angle += 1
    else if (!quoted && character === '>') angle = Math.max(0, angle - 1)
    if (!quoted && angle === 0 && (character === ',' || character === ';')) flush()
    else current += character
  }
  flush()
  return addresses
}

function extractAddress(part: string): string | null {
  const bracketed = /<([^<>\s]+@[^<>\s]+)>/.exec(part)
  if (bracketed) return bracketed[1]!.toLowerCase()
  const withoutQuotes = part.replace(/"(?:[^"\\]|\\.)*"/g, ' ').replace(/\([^()]*\)/g, ' ')
  const bare = /[^\s<>:,;"]+@[^\s<>:,;"]+/.exec(withoutQuotes)
  return bare ? bare[0].toLowerCase() : null
}

/** Gmail snippets arrive HTML-escaped. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity: string) => {
    const lower = entity.toLowerCase()
    if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16))
    if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10))
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }[lower] ?? ''
  })
}
