#!/usr/bin/env python3
"""Spike: run Laya on the synthetic decision fixtures and write results in the
shape scripts/score-decision.mjs reads. Synthetic data only.

  python scripts/spikes/laya-probe.py FIXTURE.json OUT_PREFIX [--model multilingual] [--device cpu]

Writes OUT_PREFIX.noul.json (needs-action asked as noul yes/no) and
OUT_PREFIX.choice.json (asked as an act/no_action choice), both with the same
category question. `probability` is the probability of "needs action".
"""
import argparse, json, resource, time

import laya

ap = argparse.ArgumentParser()
ap.add_argument("fixture")
ap.add_argument("out")
ap.add_argument("--model", default="multilingual")
ap.add_argument("--device", default="cpu")
args = ap.parse_args()

fx = json.load(open(args.fixture))
# Neutral option names and no label ids: both measurably reduce the bias toward
# "newsletters" (docs/local-decision-spike.md).
names = {"person": "P", "finance": "F", "orders": "O", "newsletters": "N", "notifications": "T"}
inverse = {v: k for k, v in names.items()}
codes = {names[k]: v for k, v in fx["categories"].items()}
questions = {
    "needs_action": {"type": "noul", "instructions": "Does the owner need to act on this email (reply, pay, confirm, decide, collect or review something)?"},
    "act": {"type": "choice", "instructions": "Does the owner need to act on this email?",
            "criteria": {"act": "the owner must reply, pay, confirm, decide, collect or review something",
                         "no_action": "informational or automated; nothing to do"}},
    "category": {"type": "choice", "instructions": "Which category is the email in `body`?", "criteria": codes},
}
results = {"noul": {"answers": {}}, "choice": {"answers": {}}}
times = []
with laya.Router(max_loaded=1, device=args.device) as router:
    router.predict({"body": "warmup"}, questions, model=args.model)
    for m in fx["messages"]:
        state = {"body": f"From: {m['from_address']}\nSubject: {m['subject']}"}
        t0 = time.perf_counter()
        out = router.predict(state, questions, model=args.model)
        times.append(time.perf_counter() - t0)
        a = out["answers"]
        cat = {"type": "choice", "choice": inverse[a["category"]["choice"]], "probabilities": {}, "confidence": a["category"]["confidence"]}
        for variant, p in (("noul", a["needs_action"]["noul"]), ("choice", a["act"]["probabilities"]["act"])):
            results[variant]["answers"]["A_" + m["id"]] = {"type": "boolean", "probability": p, "confidence": None}
            results[variant]["answers"]["C_" + m["id"]] = cat
for variant, r in results.items():
    r["models"] = ["laya-" + args.model]
    r["usage"] = [{"cost": 0, "input_tokens": 0, "output_tokens": 0}]
    json.dump(r, open(f"{args.out}.{variant}.json", "w"))
times.sort()
print(json.dumps({"messages": len(times), "ms_median": round(times[len(times) // 2] * 1000, 1),
                  "ms_p95": round(times[int(len(times) * .95)] * 1000, 1),
                  "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6, 0)}))
