#!/usr/bin/env node
/**
 * Renders a stored digest JSON as one static, self-contained HTML page for the
 * tailnet. Every value from mail or calendar is escaped; the page loads
 * nothing from the network.
 *
 *   node scripts/render-digest.mjs digest/2026-09-25.json > www/2026-09-25.html
 */

import { readFileSync, realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const GMAIL_THREAD = 'https://mail.google.com/mail/u/0/#all/'

export function render(digest) {
  const counts = digest.counts ?? {}
  const sections = [
    notices(digest),
    section('Calendar', calendar(digest.calendar)),
    section(`Needs action (${counts.needs_action ?? 0})`, messages(digest.needs_action, 'Nothing needs action.')),
    section(`Not sure (${counts.unsettled ?? 0})`, messages(digest.unsettled, 'Nothing unsettled.')),
    section('Receipts', receipts(digest.receipts)),
    section(`Bulk (${counts.bulk ?? 0})`, bulk(digest.bulk)),
  ]
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Digest ${esc(digest.date)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
  <h1>Digest <span class="date">${esc(weekday(digest.date))} ${esc(digest.date)}</span></h1>
  <p class="meta">${counts.messages ?? 0} new messages · generated ${esc(clock(digest.generated_at))}</p>
</header>
${sections.join('\n')}
</main>
</body>
</html>
`
}

function notices(digest) {
  const lines = []
  const window = digest.window ?? {}
  if (window.skipped_days > 0) {
    lines.push(
      `Skipped ${window.skipped_days} day${window.skipped_days === 1 ? '' : 's'} since the last digest` +
        (window.clamped ? '; mail older than 7 days is not included.' : '; this digest covers them.'),
    )
  }
  for (const warning of digest.warnings ?? []) lines.push(warning)
  return lines.length === 0 ? '' : `<aside class="notice">${lines.map((line) => `<p>${esc(line)}</p>`).join('')}</aside>`
}

function section(title, body) {
  return `<section><h2>${esc(title)}</h2>${body}</section>`
}

function calendar(calendar = { days: [], overlaps: [] }) {
  const overlapping = new Set((calendar.overlaps ?? []).flat())
  return (calendar.days ?? [])
    .map((day, index) => {
      const heading = `<h3>${index === 0 ? 'Today' : index === 1 ? 'Tomorrow' : esc(day.date)}</h3>`
      if ((day.events ?? []).length === 0) return `${heading}<p class="empty">No events.</p>`
      return `${heading}<ul class="events">${day.events.map((event) => eventItem(event, overlapping)).join('')}</ul>`
    })
    .join('')
}

function eventItem(event, overlapping) {
  const time = event.all_day ? 'All day' : `${clock(event.start)}–${clock(event.end)}`
  const tags = []
  if (overlapping.has(event.id)) tags.push(tag('overlap', 'warn'))
  if (event.with_others) tags.push(tag('with others'))
  if (event.with_others && !event.has_agenda) tags.push(tag('no agenda', 'warn'))
  if (event.my_response === 'needsAction') tags.push(tag('not answered', 'warn'))
  if (event.my_response === 'declined') tags.push(tag('declined'))
  const people =
    (event.new_people ?? []).length > 0 ? `<div class="sub">New: ${esc(event.new_people.join(', '))}</div>` : ''
  const location = event.location ? `<div class="sub">${esc(event.location)}</div>` : ''
  return `<li><span class="time">${esc(time)}</span><div><div>${esc(event.title || '(no title)')} ${tags.join(
    ' ',
  )}</div>${location}${people}</div></li>`
}

function messages(list = [], empty) {
  if (list.length === 0) return `<p class="empty">${esc(empty)}</p>`
  return `<ul class="mail">${list
    .map((message) => {
      const why = { person_awaiting_reply: 'awaiting your reply', important: 'marked important' }[message.rule]
      return `<li><a href="${esc(GMAIL_THREAD + encodeURIComponent(message.thread_id))}">
<div class="from">${esc(sender(message))}<span class="when">${esc(shortDate(message.date))}</span></div>
<div class="subject">${esc(message.subject || '(no subject)')}</div>
<div class="snippet">${esc(message.snippet)}</div>
${why ? `<div class="why">${esc(why)}</div>` : ''}</a></li>`
    })
    .join('')}</ul>`
}

function receipts(list = []) {
  if (list.length === 0) return '<p class="empty">No receipt candidates.</p>'
  return `<table><tbody>${list
    .map((message) => {
      const receipt = message.receipt ?? {}
      const amount = receipt.amount ? `${receipt.amount} ${receipt.currency ?? ''}` : 'unparsed'
      return `<tr><td>${esc(receipt.vendor ?? sender(message))}<div class="sub">${esc(message.subject)}</div></td><td class="num">${esc(amount)}</td></tr>`
    })
    .join('')}</tbody></table>`
}

function bulk(list = []) {
  if (list.length === 0) return '<p class="empty">No bulk mail.</p>'
  return `<table><tbody>${list
    .map((row) => `<tr><td>${esc(displayName(row.name) || row.sender)}</td><td class="num">${row.count}</td></tr>`)
    .join('')}</tbody></table>`
}

function tag(text, kind = '') {
  return `<span class="tag ${kind}">${esc(text)}</span>`
}

function sender(message) {
  return displayName(message.from) || message.from_address || ''
}

/** "Doe, Jane" <jane@example.com> -> Doe, Jane */
function displayName(from = '') {
  const name = from.replace(/<[^>]*>/, '').trim().replace(/^"(.*)"$/, '$1')
  return name
}

/** HH:MM from an RFC 3339 string already in Stockholm time. */
function clock(stamp = '') {
  return /T(\d{2}:\d{2})/.exec(stamp)?.[1] ?? ''
}

function shortDate(iso) {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Stockholm',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso))
}

function weekday(date) {
  if (!date) return ''
  return new Intl.DateTimeFormat('en-GB', { weekday: 'long', timeZone: 'UTC' }).format(new Date(`${date}T12:00:00Z`))
}

function esc(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character],
  )
}

const STYLE = `
:root { --bg: #fbfaf8; --fg: #1d1c1a; --muted: #6b6760; --line: #e6e2dc; --card: #ffffff; --accent: #2f5d8a; --warn: #a1502a; --warn-bg: #fbeee6; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #161615; --fg: #ecebe8; --muted: #a09c95; --line: #2c2b29; --card: #1f1e1c; --accent: #8ab4de; --warn: #f0a57e; --warn-bg: #3a261c; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 680px; margin: 0 auto; padding: 16px 16px 48px; }
h1 { font-size: 1.4rem; margin: 8px 0 2px; }
h1 .date { color: var(--muted); font-weight: 400; }
h2 { font-size: 1.05rem; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
h3 { font-size: .85rem; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 14px 0 6px; }
.meta, .empty, .sub, .when, .snippet { color: var(--muted); }
.meta { margin: 0; font-size: .9rem; }
.empty { margin: 4px 0; }
.notice { background: var(--warn-bg); color: var(--warn); border-radius: 8px; padding: 8px 12px; margin-top: 16px; }
.notice p { margin: 4px 0; }
ul { list-style: none; margin: 0; padding: 0; }
.events li { display: flex; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--line); }
.time { flex: 0 0 104px; white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--muted); }
.sub { font-size: .9rem; }
.tag { display: inline-block; font-size: .75rem; padding: 0 6px; border-radius: 4px; border: 1px solid var(--line); color: var(--muted); }
.tag.warn { color: var(--warn); border-color: var(--warn); }
.mail li { background: var(--card); border: 1px solid var(--line); border-radius: 10px; margin: 8px 0; }
.mail a { display: block; padding: 10px 12px; color: inherit; text-decoration: none; }
.from { font-weight: 600; display: flex; justify-content: space-between; gap: 8px; }
.when { font-weight: 400; font-size: .85rem; white-space: nowrap; }
.subject { margin-top: 2px; }
.snippet { font-size: .9rem; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.why { font-size: .8rem; color: var(--accent); margin-top: 4px; }
table { width: 100%; border-collapse: collapse; }
td { padding: 6px 0; border-bottom: 1px solid var(--line); vertical-align: top; overflow-wrap: anywhere; }
td.num { text-align: right; white-space: nowrap; padding-left: 12px; font-variant-numeric: tabular-nums; }
`

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const path = process.argv[2]
  if (!path) {
    process.stderr.write('usage: render-digest.mjs DIGEST.json\n')
    process.exit(64)
  }
  process.stdout.write(render(JSON.parse(readFileSync(path, 'utf8'))))
}
