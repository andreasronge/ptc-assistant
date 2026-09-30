#!/usr/bin/env python3
"""Spike: run AnyJev (L0) on the synthetic decision fixtures and write results in
the shape scripts/score-decision.mjs reads. Synthetic data only.

  python scripts/spikes/anyjev-probe.py FIXTURE.json OUT_PREFIX MODEL [--device mps] [--dtype bfloat16]

Writes OUT_PREFIX.noul.json (needs-action as a noul yes/no) and
OUT_PREFIX.choice.json (needs-action as an act/no_action choice). All messages
go through one Decider so the L0 batch prior accumulates. `probability` is the
probability of "needs action".
"""
import argparse, json, resource, time

from anyjev import Decider, Question
from anyjev.backends.hf import HFBackend

ap = argparse.ArgumentParser()
ap.add_argument("fixture"); ap.add_argument("out"); ap.add_argument("model")
ap.add_argument("--device", default="mps"); ap.add_argument("--dtype", default="bfloat16")
ap.add_argument("--batch-size", type=int, default=4)
args = ap.parse_args()

fx = json.load(open(args.fixture))
cats = fx["categories"]
cat_text = "Which category is this email? " + "; ".join(f"{k} = {v}" for k, v in cats.items())
ACT = "the owner must reply, pay, confirm, decide, collect or review something"
questions = [
    Question.noul(f"Does the owner need to act on this email ({ACT})?", name="needs_action"),
    Question.choice(f"Does the owner need to act on this email? act = {ACT}; no_action = informational or automated, nothing to do.", ["act", "no_action"], name="act"),
    Question.choice(cat_text, list(cats), name="category"),
]
decider = Decider(HFBackend(args.model, device=args.device, dtype=args.dtype, batch_size=args.batch_size))
results = {"noul": {"answers": {}}, "choice": {"answers": {}}}
times = []
for m in fx["messages"]:
    state = f"From: {m['from_address']}\nSubject: {m['subject']}"
    t0 = time.perf_counter()
    d = decider.decide(state, questions)
    times.append(time.perf_counter() - t0)
    by = d.to_dict() if not isinstance(d, dict) else d
    got = {q.name: d[q.name] for q in questions}
    cat = got["category"]
    cat_answer = {"type": "choice", "choice": cat.answer, "probabilities": {}, "confidence": None}
    for variant, p in (("noul", got["needs_action"].p_true), ("choice", got["act"].distribution["act"])):
        results[variant]["answers"]["A_" + m["id"]] = {"type": "boolean", "probability": float(p), "confidence": None}
        results[variant]["answers"]["C_" + m["id"]] = cat_answer
for variant, r in results.items():
    r["models"] = [args.model]; r["usage"] = []
    json.dump(r, open(f"{args.out}.{variant}.json", "w"))
times.sort()
print(json.dumps({"model": args.model, "device": args.device, "dtype": args.dtype, "messages": len(times),
                  "ms_median": round(times[len(times) // 2] * 1000), "ms_max": round(times[-1] * 1000),
                  "peak_rss_mb": round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e6)}))
