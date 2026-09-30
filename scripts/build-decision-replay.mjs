#!/usr/bin/env node
// Turns a live decision-probe result into an offline replay fixture, so the
// probe and its scoring run without an API key.
//   node scripts/build-decision-replay.mjs RESULT.json > workflows/decision-probe/replay.ndjson
// The requests below must match workflows/decision-probe/workflow.clj; a
// mismatch shows up as `replay_fixture_missing` when the replay is run.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = new URL('..', import.meta.url).pathname
const fixture = JSON.parse(readFileSync(join(root, 'fixtures/decision/messages.json'), 'utf8'))
const result = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const batchSize = 10
const ptcRunner = process.env.PTC_RUNNER_BIN ?? join(root, 'releases/current/bin/ptc_runner')

const actionText = (id) =>
  `Does the owner need to act on message ${id} (reply, pay, confirm, decide, collect, or review something)? Judge from sender, subject, labels and flags only.`

const questions = (messages) =>
  Object.fromEntries(
    messages.flatMap((m) => [
      [`A_${m.id}`, {
        type: 'boolean',
        instructions: actionText(m.id),
        criteria: { true: 'The owner must do something about this message.', false: 'Informational, automated, or already handled; nothing to do.' },
      }],
      [`C_${m.id}`, { type: 'choice', instructions: `Which category is this message? Message id ${m.id}.`, criteria: fixture.categories }],
    ]),
  )

const dir = mkdtempSync(join(tmpdir(), 'decision-replay-'))
const lines = []
for (let i = 0; i * batchSize < fixture.messages.length; i++) {
  const batch = fixture.messages.slice(i * batchSize, (i + 1) * batchSize)
  const request = {
    state: { messages: batch.map(({ id, from_address, subject, label_ids, list_unsubscribe }) => ({ id, from_address, subject, label_ids, list_unsubscribe })) },
    questions: questions(batch),
  }
  const path = join(dir, `request-${i}.json`)
  writeFileSync(path, JSON.stringify(request))
  const out = execFileSync(ptcRunner, ['eval', `req = File.read!("${path}") |> :json.decode()\n{:ok, h} = PtcRunner.Kernel.LLMReplay.request_hash(req)\nIO.puts(h)`], { encoding: 'utf8' })
  const hash = out.trim().split('\n').pop()
  const answers = Object.fromEntries(Object.keys(request.questions).map((q) => [q, result.answers[q]]))
  const usage = result.usage[i]
  lines.push(JSON.stringify({ schema_version: 2, request_hash: hash, response: { model: result.models[0], answers, usage } }))
}
process.stdout.write(lines.join('\n') + '\n')
