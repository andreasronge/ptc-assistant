# Local decision model spike (2026-09-30)

Question: can a small local model replace the OpenRouter Jev endpoint for the
digest's decision layer (no third party sees mail)? Synthetic data only:
`fixtures/decision/messages.json` (47 English-leaning, mixed Swedish subjects)
and `messages-sv.json` (24 Swedish). Input is metadata only: sender, subject,
label ids, unsubscribe flag. Scorer: `scripts/score-decision.mjs` (thresholds
0.3 / 0.7).

## Results

| Model | Set | Needs-action decided | Correct | Missed actions | Category correct |
| --- | --- | ---: | ---: | ---: | ---: |
| Jev 1.13 (OpenRouter) | 47 | 42 | 40 | 0 | 46 / 47 |
| Jev 1.13 (OpenRouter) | 24 sv | 21 | 20 | 0 | 24 / 24 |
| Laya multilingual, CPU | 47 | 29 to 36 | 25 | 4 to 9 | 32 / 47 |
| Laya multilingual, CPU | 24 sv | 17 to 18 | 10 to 12 | 4 to 5 | 13 / 24 |
| Laya english, CPU | 47 | 23 to 35 | 18 to 24 | 5 to 10 | 22 / 47 |

Ranges cover asking needs-action as `noul` yes/no versus an `act` / `no_action`
choice. Best settings: state is `From` and `Subject` text in a `body` field
only, and category options renamed to neutral codes (`P`, `F`, `O`, `N`, `T`).

What hurt Laya multilingual (category correct of 47):

| Input | Correct | Answered "newsletters" |
| --- | ---: | ---: |
| subject only | 25 | 6 |
| from + subject | 29 | 21 |
| from + subject + label ids + unsubscribe flag | 19 | 34 |
| from + subject, neutral option names | 32 | 19 |

Label ids and the unsubscribe flag pull it toward "newsletters", and the
option name itself biases it. Neither is a reason to give Laya those fields:
the digest rules already read them. It runs at about 123 ms per message on
CPU with 2.7 GB peak memory, so cost is not the problem; zero-shot accuracy on
metadata-only mail is. Calibration (`laya.fit_temperatures`) or fine-tuning on
labeled mail would be required, and the oracle only labels needs-action, not
categories.

## Against the real digest rules

The real `digest.rules/classify` (empty correspondents set, no thread data)
over all 71 messages: 50 bulk, 9 important, 12 unsettled.

| Group | Rules | Jev (English only) | Laya multilingual (choice) |
| --- | --- | --- | --- |
| 12 unsettled (SPEC: the only ones the model's answer is shown for) | 9 correct, 3 missed | 6 of 8 decided, all correct, 2 unsure | 9 correct of 10 decided, 1 missed, 2 unsure |
| 17 bulk-settled that really need action (bank invoices, parcel pickup, appointments) | all 17 missed | 11 of 11 found | 4 of 17 found, 9 unsure |

Two readings. Laya roughly matches the rules on the unsettled subset (tiny
sample), so it adds little there. The bigger effect is that the rules' bulk
check runs first and hides actionable mail with Gmail Updates labels, while
Jev finds it. Showing a model's answer only for unsettled messages would hide
this. The mix is my own synthetic choice; the real share needs the oracle.

## AnyJev (L0, Qwen3-4B BF16, MPS, `scripts/spikes/anyjev-probe.py`)

About 4.7 s per message for three questions on an M1 Pro; all messages went
through one `Decider` so the L0 batch prior accumulated.

| Question form | Set | Decided | Correct | Missed | False alarms | Category |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| act / no_action choice | 47 | 43 | 32 | 0 | 11 | 40 / 47 |
| noul yes/no | 47 | 43 | 20 | 0 | 23 | 40 / 47 |
| act / no_action choice | 24 sv | 23 | 14 | 0 | 9 | 19 / 24 |
| noul yes/no | 24 sv | 24 | 11 | 0 | 13 | 19 / 24 |

Probabilities saturate near 1.0, so the 0.3 / 0.7 thresholds over-call. The
ranking is good though (AUC, 1.0 perfect):

| Model | English AUC | Swedish AUC | Best single threshold (EN / SV, fitted on the test set) |
| --- | ---: | ---: | --- |
| Jev | 1.00 | 1.00 | 46/47 at 0.79 / 23/24 at 0.75 |
| AnyJev Qwen3-4B, choice | 0.92 | 0.94 | 42/47 / 21/24, threshold near 1.00 |
| AnyJev Qwen3-4B, noul | 0.74 | 0.82 | 33/47 / 19/24 |
| Laya multilingual, choice | 0.84 | 0.67 | 38/47 / 16/24 |

Qwen3-8B (same settings, about 12.4 s per message, 2.6 times slower than 4B):

| Question form | Set | Decided | Correct | Missed | False alarms | Category | AUC |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| act / no_action choice | 47 | 47 | 35 | 3 | 9 | 40 / 47 | 0.92 |
| noul yes/no | 47 | 44 | 33 | 2 | 9 | 40 / 47 | 0.91 |
| act / no_action choice | 24 sv | 23 | 20 | 0 | 3 | 21 / 24 | 1.00 |
| noul yes/no | 24 sv | 22 | 16 | 0 | 6 | 21 / 24 | 0.95 |

8B helps mostly on Swedish and on the yes/no form, and is no better than 4B on
English categories or English ranking. Its probabilities also saturate.

Reading: Qwen3-4B asked as an act / no_action choice finds every real action
and ranks well, but needs calibration (L1, 100 to 500 labels) before its
probabilities mean anything. The best-threshold figures are optimistic because
the threshold is chosen on the same 47 and 24 messages.

Not tested: Qwen3-1.7B, float16 and CPU comparison, L1/L2, message bodies, Laya's typed-decisions
checkpoint, Laya after calibration.

## Findings for ptc_runner

- Direct `ollama:` and `openai-compat:` aliases are refused for
  `json_schema` at `ptc doctor` / `ptc run`, so a local model cannot back the
  `chat` decision backend: andreasronge/ptc_runner#2121.
- `ptc validate` accepts that configuration; every `llm` installation
  requires a `credential`, even for a local server.

## Reproduce

```sh
python3 -m venv venv && venv/bin/pip install laya
venv/bin/python scripts/spikes/laya-probe.py fixtures/decision/messages.json /tmp/laya
node scripts/score-decision.mjs /tmp/laya.choice.json
```
