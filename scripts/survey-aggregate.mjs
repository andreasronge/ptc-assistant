#!/usr/bin/env node
// Aggregates a survey result (workflows/survey) into counts only: no snippets,
// no addresses of individuals. Reads the private result file, prints a summary.
//   node scripts/survey-aggregate.mjs RESULT.json [--top 40]
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BULK_CATEGORIES = new Set(['CATEGORY_PROMOTIONS', 'CATEGORY_SOCIAL', 'CATEGORY_UPDATES', 'CATEGORY_FORUMS'])
const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'me.com', 'yahoo.com', 'telia.com', 'comhem.se'])
const SV_WORDS = /\b(och|att|för|din|ditt|dina|från|till|med|har|är|inte|faktura|beställning|bekräftelse|påminnelse|tack|hej|veckans|erbjudande)\b|[åäö]/i

const normalizeSubject = (s) =>
  s.replace(/^((re|sv|fw|fwd|vb)\s*:\s*)+/i, '').replace(/[\w.+-]+@[\w.-]+/g, '<addr>').replace(/\d[\d\s.,:/-]*/g, '#').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60)

const domainOf = (address) => (address && address.includes('@') ? address.split('@')[1] : '(none)')

export function aggregate(result, top = 40) {
  const messages = result.messages ?? []
  const labels = {}
  const domains = new Map()
  const words = new Map()
  let unsub = 0
  let swedish = 0
  const persons = new Set()
  for (const m of messages) {
    for (const l of m.label_ids ?? []) {
      const key = /^Label_/.test(l) ? 'user label (any)' : l
      labels[key] = (labels[key] ?? 0) + 1
    }
    if (m.list_unsubscribe) unsub++
    if (SV_WORDS.test(m.subject ?? '')) swedish++
    const d = domainOf(m.from_address)
    const bulk = m.list_unsubscribe || (m.label_ids ?? []).some((l) => BULK_CATEGORIES.has(l))
    if (!bulk && FREE_MAIL.has(d)) persons.add(m.from_address)
    const e = domains.get(d) ?? { n: 0, unsub: 0, categories: {}, subjects: new Map(), senders: new Set(), unread: 0 }
    e.n++
    if (m.list_unsubscribe) e.unsub++
    e.senders.add(m.from_address)
    if ((m.label_ids ?? []).includes('UNREAD')) e.unread++
    for (const l of m.label_ids ?? []) if (l.startsWith('CATEGORY_')) e.categories[l] = (e.categories[l] ?? 0) + 1
    const sub = normalizeSubject(m.subject ?? '')
    e.subjects.set(sub, (e.subjects.get(sub) ?? 0) + 1)
    domains.set(d, e)
    for (const w of (m.subject ?? '').toLowerCase().match(/[a-zåäöé]{5,}/g) ?? []) words.set(w, (words.get(w) ?? 0) + 1)
  }
  const sorted = [...domains.entries()].sort((a, b) => b[1].n - a[1].n)
  return {
    total: messages.length,
    windows_fetched: (result.windows ?? []).length,
    truncated_windows: (result.windows ?? []).filter((w) => w.truncated).length,
    labels,
    unsubscribe_share: messages.length ? +(unsub / messages.length).toFixed(2) : 0,
    swedish_subject_share: messages.length ? +(swedish / messages.length).toFixed(2) : 0,
    distinct_domains: domains.size,
    person_like_senders: persons.size,
    top_domains: sorted.slice(0, top).map(([d, e]) => ({
      domain: FREE_MAIL.has(d) ? `${d} (free mail, individuals)` : d,
      messages: e.n,
      senders: e.senders.size,
      unsubscribe: e.unsub,
      unread: e.unread,
      gmail_category: Object.entries(e.categories).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '-',
      subject_patterns: FREE_MAIL.has(d) ? [] : [...e.subjects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([s, n]) => `${n}x ${s}`),
    })),
    long_tail_domains: Math.max(0, sorted.length - top),
    long_tail_messages: sorted.slice(top).reduce((s, [, e]) => s + e.n, 0),
    top_subject_words: [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w, n]) => `${w}:${n}`),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const top = args.includes('--top') ? Number(args[args.indexOf('--top') + 1]) : 40
  console.log(JSON.stringify(aggregate(JSON.parse(readFileSync(args[0], 'utf8')), top), null, 1))
}
