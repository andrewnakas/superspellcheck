#!/usr/bin/env python3
"""Fail CI if accuracy regresses below the recorded floor, or if we stop beating Hunspell."""
import json
import sys

FLOOR = {
    ("context", "top1"): 65.0,
    ("realword", "recall"): 70.0,
}
MAX_NOISE = 9.0  # flags per 1000 words of clean prose

r = json.load(open(sys.argv[1]))
errors = []
for (task, metric), floor in FLOOR.items():
    v = r[task]["ssc"][metric]
    if v < floor:
        errors.append(f"{task}.{metric} = {v} < floor {floor}")
for corpus, row in r["word"].items():
    if "hunspell" in row and row["ssc"]["top1"] < row["hunspell"]["top1"]:
        errors.append(f"{corpus}: top1 {row['ssc']['top1']} below hunspell {row['hunspell']['top1']}")
noise = r["noise"]["ssc"]["flags_per_1000_words"]
if noise > MAX_NOISE:
    errors.append(f"noise {noise} > {MAX_NOISE}")
if "hunspell" in r["context"] and r["context"]["ssc"]["top1"] <= r["context"]["hunspell"]["top1"]:
    errors.append("context top1 no better than hunspell")
print("\n".join(errors) or "benchmark OK")
sys.exit(1 if errors else 0)
