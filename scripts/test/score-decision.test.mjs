import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { score } from '../score-decision.mjs'

const fixture = {
  messages: [
    { id: 'a', subject: 'pay', needs_action: true, category: 'finance' },
    { id: 'b', subject: 'news', needs_action: false, category: 'newsletters' },
    { id: 'c', subject: 'maybe', needs_action: true, category: 'person' },
    { id: 'd', subject: 'nulls', needs_action: false, category: 'person' },
  ],
}
const answers = {
  A_a: { probability: 0.9 }, C_a: { choice: 'finance' },
  A_b: { probability: 0.8 }, C_b: { choice: 'newsletters' },
  A_c: { probability: 0.5 }, C_c: { choice: 'orders' },
  A_d: { probability: null }, C_d: { choice: 'person' },
}

test('thresholds live in the scorer: yes, false alarm, unsure, unknown', () => {
  const s = score({ answers, models: ['m'], usage: [{ cost: 0.5, input_tokens: 2, output_tokens: 3 }] }, fixture)
  assert.equal(s.needs_action_decided, 2)
  assert.equal(s.needs_action_correct, 1)
  assert.deepEqual(s.false_alarms, ['b'])
  assert.deepEqual(s.missed_actions, [])
  assert.equal(s.unsure, 1)
  assert.equal(s.category_correct, 3)
  assert.equal(s.tokens, 5)
})

test('committed replay scores the same as the live run it was recorded from', () => {
  const root = new URL('../../', import.meta.url)
  const messages = JSON.parse(readFileSync(new URL('fixtures/decision/messages.json', root), 'utf8'))
  const lines = readFileSync(new URL('workflows/decision-probe/replay.ndjson', root), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  const result = {
    models: [lines[0].response.model],
    usage: lines.map((l) => l.response.usage),
    answers: Object.assign({}, ...lines.map((l) => l.response.answers)),
  }
  const s = score(result, messages)
  assert.equal(s.messages, 47)
  assert.deepEqual(s.missed_actions, [])
  assert.ok(s.needs_action_correct >= 38)
  assert.ok(s.category_correct >= 45)
})
