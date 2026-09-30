#!/usr/bin/env node
// Scores a decision-probe result against the synthetic labels.
//   node scripts/score-decision.mjs RESULT.json [fixtures/decision/messages.json]
// Prints accuracy, the "not sure" band (0.3-0.7), and cost. Applies the
// threshold here, never in the provider.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const LOW = 0.3
export const HIGH = 0.7

export function score(result, fixture) {
  const rows = fixture.messages.map((m) => {
    const p = result.answers[`A_${m.id}`]?.probability ?? null
    const c = result.answers[`C_${m.id}`]?.choice ?? null
    const verdict = p === null ? 'unknown' : p >= HIGH ? 'yes' : p <= LOW ? 'no' : 'unsure'
    return { id: m.id, subject: m.subject, expected: m.needs_action, p, verdict, category: m.category, chosen: c }
  })
  const decided = rows.filter((r) => r.verdict === 'yes' || r.verdict === 'no')
  const right = decided.filter((r) => (r.verdict === 'yes') === r.expected)
  const cat = rows.filter((r) => r.chosen === r.category)
  const usage = result.usage ?? []
  return {
    messages: rows.length,
    needs_action_decided: decided.length,
    needs_action_correct: right.length,
    unsure: rows.filter((r) => r.verdict === 'unsure').length,
    missed_actions: decided.filter((r) => r.expected && r.verdict === 'no').map((r) => r.id),
    false_alarms: decided.filter((r) => !r.expected && r.verdict === 'yes').map((r) => r.id),
    category_correct: cat.length,
    models: result.models,
    calls: usage.length,
    cost_usd: usage.reduce((s, u) => s + (u.cost ?? 0), 0),
    tokens: usage.reduce((s, u) => s + u.input_tokens + u.output_tokens, 0),
    rows,
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [resultPath, fixturePath = new URL('../fixtures/decision/messages.json', import.meta.url)] = process.argv.slice(2)
  const s = score(JSON.parse(readFileSync(resultPath, 'utf8')), JSON.parse(readFileSync(fixturePath, 'utf8')))
  const { rows, ...summary } = s
  console.log(JSON.stringify(summary, null, 1))
  for (const r of rows.filter((r) => r.verdict === 'unsure' || (r.verdict === 'yes') !== r.expected || r.chosen !== r.category))
    console.log(`${r.id} want=${r.expected} p=${r.p} ${r.verdict} cat ${r.chosen}/${r.category}  ${r.subject}`)
}
