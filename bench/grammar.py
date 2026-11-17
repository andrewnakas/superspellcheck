#!/usr/bin/env python3
"""Sentence-level grammar/spelling test set: exact-fix rate on errors, false alarms on clean text."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run  # noqa: E402


def apply(text, issues):
    for i in sorted(issues, key=lambda i: -i["offset"]):
        if i["replacements"]:
            # offsets are UTF-16; all test sentences are BMP so they equal Python indices
            text = text[: i["offset"]] + i["replacements"][0] + text[i["offset"] + i["length"]:]
    return text


def main():
    rows = []
    for line in open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "grammar.tsv"), encoding="utf-8"):
        if line.startswith("#") or not line.strip():
            continue
        src, exp = line.rstrip("\n").split("\t")
        rows.append((src, exp))
    outs = run.ssc_jsonl([s for s, _ in rows])
    errs = [(s, e, o) for (s, e), o in zip(rows, outs) if s != e]
    clean = [(s, e, o) for (s, e), o in zip(rows, outs) if s == e]
    fixed = [x for x in errs if apply(x[0], x[2]) == x[1]]
    flagged = [x for x in errs if x[2]]
    fps = [x for x in clean if x[2]]
    verbose = "-v" in sys.argv
    if verbose:
        for s, e, o in errs:
            got = apply(s, o)
            if got != e:
                print(f"MISS  {s!r}\n   -> {got!r}\n want {e!r}")
        for s, e, o in fps:
            print(f"FALSE ALARM {s!r}: {[(i['text'], i['rule']) for i in o]}")
    res = {
        "errors": len(errs),
        "exact_fix": run.pct(len(fixed), len(errs)),
        "flagged": run.pct(len(flagged), len(errs)),
        "clean": len(clean),
        "clean_with_false_alarm": len(fps),
    }
    print(json.dumps(res))
    return res


if __name__ == "__main__":
    main()
