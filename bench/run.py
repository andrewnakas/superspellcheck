#!/usr/bin/env python3
"""SuperSpellCheck benchmark.

Compares the ssc engine against Hunspell (the engine behind Chrome's spell
checker) and GNU Aspell on public spelling-error corpora.

Tasks
  word     isolated misspellings (Birkbeck corpora): detection, top-1, top-5
  context  the same misspellings placed inside real sentences: top-1
  realword correctly spelled but wrong words ("form" for "from"): recall/precision
  noise    false alarms per 1,000 words of clean, edited prose

Usage: bench/fetch.sh && python3 bench/run.py [--quick] [--json out.json]
"""
import argparse
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(ROOT, "bench", "data")
SSC = os.environ.get("SSC_BIN", os.path.join(ROOT, "target", "release", "ssc"))
LEX_DATA = os.path.join(ROOT, "data")
CORPORA = ["aspell.dat", "wikipedia.dat", "holbrook-missp.dat", "missp.dat"]


def load_pairs(name):
    pairs = []
    correct = None
    with open(os.path.join(DATA, name), encoding="latin-1") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            if line.startswith("$"):
                correct = line[1:].strip()
                continue
            wrong = line.split()[0]
            if correct and "_" not in correct and " " not in correct and wrong != correct and wrong.isalpha() and correct.replace("'", "").isalpha():
                pairs.append((wrong, correct))
    return sorted(set(pairs))


# ---------------------------------------------------------------- systems

def ssc_batch(items):
    """items: list of (word, prev, next). Returns list of (valid, [suggestions])."""
    inp = "\n".join("\t".join([w, p or "", n or ""]) for w, p, n in items) + "\n"
    out = subprocess.run([SSC, "batch", "--data", LEX_DATA], input=inp, capture_output=True, text=True, check=True).stdout
    res = []
    for line in out.splitlines():
        parts = line.split("\t")
        res.append((parts[1] == "ok", [s for s in parts[2].split(",") if s] if len(parts) > 2 else []))
    return res


def ssc_jsonl(texts, all_conf=False):
    inp = "\n".join(json.dumps(t) for t in texts) + "\n"
    args = [SSC, "jsonl", "--data", LEX_DATA] + (["--all"] if all_conf else [])
    out = subprocess.run(args, input=inp, capture_output=True, text=True, check=True).stdout
    return [json.loads(l) for l in out.splitlines()]


def ispell_batch(cmd, words):
    """Run an ispell-protocol checker (hunspell -a / aspell -a)."""
    inp = "\n".join("^" + w for w in words) + "\n"
    out = subprocess.run(cmd, input=inp, capture_output=True, text=True, encoding="latin-1").stdout
    lines = out.splitlines()[1:]  # skip version banner
    res = []
    i = 0
    for _ in words:
        block = []
        while i < len(lines) and lines[i] != "":
            block.append(lines[i])
            i += 1
        i += 1  # blank separator
        if not block or block[0][0] in "*+-":
            res.append((True, []))
        elif block[0][0] == "&":
            sugg = block[0].split(":", 1)[1].split(", ")
            res.append((False, [s.strip() for s in sugg]))
        else:
            res.append((False, []))
    return res


def hunspell(words):
    return ispell_batch(["hunspell", "-d", "en_US", "-a"], words)


def hunspell_valid(words):
    """Fast validity check (no suggestions): hunspell -l prints only misspelled words."""
    out = subprocess.run(["hunspell", "-d", "en_US", "-l"], input="\n".join(words) + "\n", capture_output=True, text=True, encoding="latin-1").stdout
    bad = set(out.split())
    return [w not in bad for w in words]


def aspell(words):
    return ispell_batch(["aspell", "-a", "--lang=en_US", "--sug-mode=normal"], words)


SYSTEMS = {"ssc": None, "hunspell": hunspell, "aspell": aspell}


def available(name):
    return name == "ssc" or shutil.which(name) is not None


# ---------------------------------------------------------------- tasks

def pct(a, b):
    return round(100.0 * a / b, 1) if b else 0.0


def task_word(quick):
    results = {}
    for corpus in CORPORA:
        pairs = load_pairs(corpus)
        if quick and len(pairs) > 2000:
            random.Random(1).shuffle(pairs)
            pairs = pairs[:2000]
        words = [w for w, _ in pairs]
        row = {"n": len(pairs)}
        for sys_name in SYSTEMS:
            if not available(sys_name):
                continue
            out = ssc_batch([(w, None, None) for w in words]) if sys_name == "ssc" else SYSTEMS[sys_name](words)
            det = top1 = top5 = 0
            for (wrong, right), (valid, sugg) in zip(pairs, out):
                if not valid:
                    det += 1
                low = [s.lower() for s in sugg]
                if low[:1] == [right.lower()]:
                    top1 += 1
                if right.lower() in low[:5]:
                    top5 += 1
            row[sys_name] = {"detect": pct(det, len(pairs)), "top1": pct(top1, len(pairs)), "top5": pct(top5, len(pairs))}
        results[corpus] = row
    return results


def clean_sentences(limit, seed=7):
    text = open(os.path.join(DATA, "big.txt"), encoding="utf-8", errors="ignore").read()
    paras = re.split(r"\n\s*\n", text)
    sents = []
    for p in paras:
        p = " ".join(p.split())
        for s in re.split(r"(?<=[.!?])\s+(?=[A-Z])", p):
            words = s.split()
            if 8 <= len(words) <= 30 and s[0].isupper() and s[-1] in ".!?" and all(ord(c) < 128 for c in s) and not re.search(r"[0-9_*\[\]{}<>|/@#]", s) and s.count('"') % 2 == 0:
                sents.append(s)
    rnd = random.Random(seed)
    rnd.shuffle(sents)
    return sents[:limit]


def task_context(quick):
    """Insert real human misspellings into real sentences; score top-1 fix of that token."""
    pairs = load_pairs("wikipedia.dat") + load_pairs("aspell.dat") + load_pairs("missp.dat")
    # Non-word errors only (real-word errors have their own task). Validity judged by Hunspell, a neutral third party.
    if available("hunspell"):
        valid = hunspell_valid([w for w, _ in pairs])
        pairs = [p for p, v in zip(pairs, valid) if not v]
    by_correct = {}
    for w, c in pairs:
        by_correct.setdefault(c.lower(), []).append(w)
    sents = clean_sentences(40000)
    rnd = random.Random(3)
    cases = []
    for s in sents:
        toks = list(re.finditer(r"[A-Za-z']+", s))
        cands = [t for t in toks if t.group().lower() in by_correct and t.start() > 0]
        if not cands:
            continue
        t = rnd.choice(cands)
        wrong = rnd.choice(by_correct[t.group().lower()])
        if t.group()[0].isupper():
            wrong = wrong[0].upper() + wrong[1:]
        text = s[: t.start()] + wrong + s[t.end():]
        cases.append((text, t.start(), wrong, t.group()))
        if len(cases) >= (1000 if quick else 3000):
            break
    res = {"n": len(cases)}
    # ssc with full sentence context
    outs = ssc_jsonl([c[0] for c in cases], all_conf=True)
    hit = det = 0
    for (text, off, wrong, right), issues in zip(cases, outs):
        for i in issues:
            if i["offset"] == off and i["length"] == len(wrong):
                det += 1
                if i["replacements"][:1] and i["replacements"][0].lower() == right.lower():
                    hit += 1
    res["ssc"] = {"detect": pct(det, len(cases)), "top1": pct(hit, len(cases))}
    for name in ("hunspell", "aspell"):
        if not available(name):
            continue
        out = SYSTEMS[name]([c[2] for c in cases])
        hit = sum(1 for c, (v, s) in zip(cases, out) if s[:1] and s[0].lower() == c[3].lower())
        det = sum(1 for v, _ in out if not v)
        res[name] = {"detect": pct(det, len(cases)), "top1": pct(hit, len(cases))}
    return res


REALWORD_SWAPS = [
    ("from", "form"), ("lose", "loose"), ("than", "then"), ("their", "there"), ("there", "their"),
    ("your", "you're"), ("it's", "its"), ("affect", "effect"), ("quiet", "quite"), ("whether", "weather"),
    ("piece", "peace"), ("break", "brake"), ("passed", "past"), ("advice", "advise"), ("breathe", "breath"),
    ("were", "where"), ("where", "were"), ("know", "now"), ("new", "knew"), ("hear", "here"), ("whose", "who's"),
    ("off", "of"), ("choose", "chose"), ("later", "latter"), ("through", "threw"), ("whole", "hole"), ("week", "weak"),
    ("principle", "principal"), ("accept", "except"), ("to", "too"), ("too", "to"), ("then", "than"),
]


def task_realword(quick):
    sents = clean_sentences(60000, seed=11)
    rnd = random.Random(5)
    cases, clean = [], []
    swap = dict()
    for a, b in REALWORD_SWAPS:
        swap.setdefault(a, []).append(b)
    for s in sents:
        toks = [t for t in re.finditer(r"[A-Za-z']+", s) if t.group().lower() in swap and t.start() > 0 and t.group().islower()]
        if not toks:
            continue
        if len(clean) < len(cases):
            clean.append(s)  # an unmodified sentence that contains confusable words (precision test)
            continue
        t = rnd.choice(toks)
        wrong = rnd.choice(swap[t.group()])
        cases.append((s[: t.start()] + wrong + s[t.end():], t.start(), wrong, t.group()))
        if len(cases) >= (300 if quick else 1000):
            break
    outs = ssc_jsonl([c[0] for c in cases] + clean)
    tp = fixed = 0
    for (text, off, wrong, right), issues in zip(cases, outs[: len(cases)]):
        for i in issues:
            if i["offset"] == off:
                tp += 1
                if i["replacements"][:1] == [right]:
                    fixed += 1
    fp = sum(1 for issues in outs[len(cases):] for i in issues if i["rule"] in ("CONFUSED_WORD", "ITS_ITS", "YOUR_YOURE", "THEN_THAN", "ITS_OWN"))
    res = {"n": len(cases), "n_clean": len(clean)}
    res["ssc"] = {"recall": pct(tp, len(cases)), "fixed": pct(fixed, len(cases)), "false_alarms_per_100_clean_sents": pct(fp, len(clean))}
    res["hunspell"] = {"recall": 0.0, "fixed": 0.0, "note": "dictionary checkers cannot detect real-word errors"}
    return res


def task_noise(quick):
    sents = clean_sentences(2000 if quick else 6000, seed=23)
    nwords = sum(len(re.findall(r"[A-Za-z']+", s)) for s in sents)
    outs = ssc_jsonl(sents)
    flags = sum(len(o) for o in outs)
    by_rule = {}
    for o in outs:
        for i in o:
            by_rule[i["rule"]] = by_rule.get(i["rule"], 0) + 1
    res = {"sentences": len(sents), "words": nwords, "ssc": {"flags_per_1000_words": round(1000 * flags / nwords, 2), "by_rule": by_rule}}
    for name in ("hunspell", "aspell"):
        if not available(name):
            continue
        words = [w for s in sents for w in re.findall(r"[A-Za-z]+(?:'[A-Za-z]+)?", s)]
        if name == "hunspell":
            bad = sum(1 for v in hunspell_valid(words) if not v)
        else:
            bad = sum(1 for v, _ in SYSTEMS[name](words) if not v)
        res[name] = {"flags_per_1000_words": round(1000 * bad / nwords, 2)}
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--quick", action="store_true")
    ap.add_argument("--json")
    ap.add_argument("--tasks", default="word,context,realword,noise")
    a = ap.parse_args()
    if not os.path.exists(SSC):
        sys.exit(f"missing {SSC}; run: cargo build --release")
    report = {}
    for task in a.tasks.split(","):
        t0 = time.time()
        report[task] = globals()["task_" + task](a.quick)
        print(f"== {task} ({time.time() - t0:.1f}s)")
        print(json.dumps(report[task], indent=1))
    if a.json:
        with open(a.json, "w") as f:
            json.dump(report, f, indent=1)


if __name__ == "__main__":
    main()
