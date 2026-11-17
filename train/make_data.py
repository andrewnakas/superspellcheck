#!/usr/bin/env python3
"""Build the fine-tuning set for the on-device AI checker.

Writes JSONL with {"prompt", "completion", "src", "tgt", "kind"} rows:
  - c4       real-looking corrections from Google's C4_200M (CC BY 4.0), filtered to
             short single sentences with minimal edits
  - synth    clean sentences corrupted by our own error generator (typos, confused
             words, grammar-rule inversions, punctuation and capitalization slips)
  - identity correct sentences that must come back unchanged (keeps false alarms low)

If the `ssc` CLI is built (cargo build --release), it is used to drop C4 targets
that still contain errors, so the model never learns to keep mistakes.

Usage:
  python3 train/make_data.py --out train/data --n 300000
  python3 train/make_data.py --out /tmp/sample --n 1000 --sample   # quick look
"""
import argparse
import json
import os
import random
import re
import subprocess
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PROMPT = json.load(open(os.path.join(ROOT, "train", "prompt.json")))
C4_SHARDS = [
    "https://huggingface.co/datasets/liweili/c4_200m/resolve/refs%2Fconvert%2Fparquet/default/partial-train/{:04d}.parquet".format(i)
    for i in range(10)
]
SSC = os.path.join(ROOT, "target", "release", "ssc")

WORD = re.compile(r"[A-Za-z]+(?:'[A-Za-z]+)?")


def build_prompt(src):
    return PROMPT["template"].replace("{system}", PROMPT["system"]).replace("{src}", src)


# ------------------------------------------------------------------ tables shared with the engine

def rust_tables():
    """Read confusion sets and irregular verbs from the engine source so the generator stays in sync."""
    conf_src = open(os.path.join(ROOT, "engine", "src", "confusion.rs")).read()
    body = conf_src.split("pub const SETS")[1].split("];")[0]
    sets = [re.findall(r'"([^"]+)"', m) for m in re.findall(r"&\[([^\]]+)\]", body)]
    rules_src = open(os.path.join(ROOT, "engine", "src", "rules.rs")).read()
    irr = re.findall(r'\("(\w+)", "(\w+)", "(\w+)"\)', rules_src.split("const IRREGULAR")[1].split("];")[0])
    return [s for s in sets if len(s) > 1 and all(" " not in w for w in s)], irr


CONFUSION_SETS, IRREGULAR = rust_tables()
CONFUSE = {}
for s in CONFUSION_SETS:
    for w in s:
        CONFUSE.setdefault(w, set()).update(x for x in s if x != w)

QWERTY = ["qwertyuiop", "asdfghjkl", "zxcvbnm"]
# Same staggered-keyboard geometry as engine/src/errmodel.rs
KEYPOS = {ch: (r, c + r * 0.5) for r, row in enumerate(QWERTY) for c, ch in enumerate(row)}
ADJ = {
    a: "".join(b for b, (r2, c2) in KEYPOS.items() if b != a and abs(r1 - r2) <= 1 and abs(c1 - c2) <= 1)
    for a, (r1, c1) in KEYPOS.items()
}

COMMON_MISSPELLINGS = {
    "receive": "recieve", "definitely": "definately", "separate": "seperate", "occurred": "occured", "until": "untill",
    "necessary": "neccessary", "believe": "beleive", "weird": "wierd", "government": "goverment", "tomorrow": "tommorow",
    "because": "becuase", "which": "wich", "their": "thier", "accommodate": "accomodate", "beginning": "begining",
    "environment": "enviroment", "really": "realy", "different": "diffrent", "address": "adress", "embarrass": "embarass",
    "a lot": "alot", "argument": "arguement", "calendar": "calender", "existence": "existance", "friend": "freind",
    "independent": "independant", "knowledge": "knowlege", "occasion": "occassion", "publicly": "publically", "recommend": "reccomend",
}


def typo(word, rnd):
    w = word.lower()
    if len(w) < 3:
        return word
    i = rnd.randrange(len(w))
    op = rnd.random()
    if op < 0.3 and w[i] in ADJ:
        w = w[:i] + rnd.choice(ADJ[w[i]]) + w[i + 1:]
    elif op < 0.5 and i < len(w) - 1:
        w = w[:i] + w[i + 1] + w[i] + w[i + 2:]
    elif op < 0.7:
        w = w[:i] + w[i + 1:]
    elif op < 0.85:
        w = w[:i] + w[i] + w[i:]
    else:
        w = w[:i] + rnd.choice("aeiou") + w[i + 1:]
    return w.capitalize() if word[0].isupper() else w


def corrupt(sentence, rnd):
    """Introduce 1-2 realistic errors. Returns None if nothing applicable."""
    s = sentence
    applied = 0
    for _ in range(rnd.choice([1, 1, 1, 2])):
        kind = rnd.random()
        words = list(WORD.finditer(s))
        if not words:
            break
        before = s
        if kind < 0.25:  # typo
            cands = [m for m in words if len(m.group()) >= 4 and not m.group()[0].isupper()]
            if cands:
                m = rnd.choice(cands)
                s = s[: m.start()] + typo(m.group(), rnd) + s[m.end():]
        elif kind < 0.35:  # known misspelling
            for right, wrong in rnd.sample(list(COMMON_MISSPELLINGS.items()), len(COMMON_MISSPELLINGS)):
                m = re.search(r"\b%s\b" % re.escape(right), s)
                if m:
                    s = s[: m.start()] + wrong + s[m.end():]
                    break
        elif kind < 0.55:  # confused word
            cands = [m for m in words if m.group().lower() in CONFUSE]
            if cands:
                m = rnd.choice(cands)
                alt = rnd.choice(sorted(CONFUSE[m.group().lower()]))
                alt = alt.capitalize() if m.group()[0].isupper() else alt
                s = s[: m.start()] + alt + s[m.end():]
        elif kind < 0.75:  # grammar rule inversions
            rules = [
                (r"\ban (?=[aeiouAEIOU])", "a "), (r"\ba (?=[bcdfgjklmnpqrstvwxyz])", "an "),
                (r"\b(he|she|it) (doesn't)\b", r"\1 don't"), (r"\b(he|she|it) has\b", r"\1 have"),
                (r"\b(they|we|you) are\b", r"\1 is"), (r"\b(they|we|you) were\b", r"\1 was"),
                (r"\bit's\b", "its"), (r"\bthan\b", "then"), (r"\byou're\b", "your"),
                (r"\b(could|should|would|must) have\b", r"\1 of"), (r"\bfewer\b", "less"),
                (r"\b(\w+) (\w+)\b", r"\1 \1 \2"),  # repeated word
            ]
            for v_past, v_pp, v_base in IRREGULAR:
                rules.append((r"\b(have|has|had) %s\b" % v_pp, r"\1 %s" % v_past))
                rules.append((r"\b(didn't|don't|can't|will|to) %s\b" % v_base, r"\1 %s" % v_past))
            rnd.shuffle(rules)
            for pat, rep in rules:
                if re.search(pat, s):
                    s = re.sub(pat, rep, s, count=1)
                    break
        elif kind < 0.88:  # punctuation slips
            if "," in s and rnd.random() < 0.6:
                idx = [m.start() for m in re.finditer(",", s)]
                i = rnd.choice(idx)
                s = s[:i] + s[i + 1:]
            elif s[-1:] in ".!?":
                s = s[:-1]
        else:  # capitalization slips
            if s[:1].isupper():
                s = s[0].lower() + s[1:]
            elif " I " in s:
                s = s.replace(" I ", " i ", 1)
        if s != before:
            applied += 1
    return s if applied and s != sentence else None


# ------------------------------------------------------------------ C4 filtering

def word_tokens(s):
    return re.findall(r"\w+|[^\w\s]", s)


def edit_size(a, b):
    """Number of changed tokens (LCS-based)."""
    x, y = word_tokens(a), word_tokens(b)
    n, m = len(x), len(y)
    if n * m > 4000:
        return 99
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if x[i] == y[j] else max(dp[i + 1][j], dp[i][j + 1])
    return max(n, m) - dp[0][0]


FUNCTION_WORDS = set("""
a an the this that these those my your his her its our their some any no every each
of in on at to for from by with about into onto over under after before between through during without within
and or but so nor if as than then because although while when where which who whom whose what
is are was were be been being am do does did have has had will would can could shall should may might must
i you he she it we they me him us them not there here very too also just""".split())


def char_dist(a, b):
    """Levenshtein distance (small strings)."""
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]


def hunks(a, b):
    """Changed token spans between a and b: list of (old_tokens, new_tokens)."""
    x, y = word_tokens(a), word_tokens(b)
    n, m = len(x), len(y)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        for j in range(m - 1, -1, -1):
            dp[i][j] = dp[i + 1][j + 1] + 1 if x[i] == y[j] else max(dp[i + 1][j], dp[i][j + 1])
    out, i, j = [], 0, 0
    while i < n or j < m:
        if i < n and j < m and x[i] == y[j]:
            i, j = i + 1, j + 1
            continue
        i0, j0 = i, j
        while (i < n or j < m) and not (i < n and j < m and x[i] == y[j]):
            if j < m and (i >= n or dp[i][j + 1] >= dp[i + 1][j]):
                j += 1
            else:
                i += 1
        out.append((x[i0:i], y[j0:j]))
    return out


VERB_FORMS = {}
for _forms in IRREGULAR:
    for _f in _forms:
        VERB_FORMS.setdefault(_f, set()).update(_forms)


def token_fix(o, w):
    """One token replaced by another: case, typo, inflection, irregular verb form or function word swap."""
    o, w = o.lower(), w.lower()
    if o == w or w in VERB_FORMS.get(o, ()):
        return True
    if o in FUNCTION_WORDS and w in FUNCTION_WORDS:
        return True
    if not o[0].isalnum() and not w[0].isalnum():
        return True
    return o[0].isalnum() and w[0].isalnum() and char_dist(o, w) <= max(2, len(w) // 3)


def is_minimal_fix(old, new):
    """A correction a proofreader would make: typo/inflection, punctuation, case, or function words."""
    content = lambda toks: [t for t in toks if t[0].isalnum() and t.lower() not in FUNCTION_WORDS]
    if not content(old) and not content(new):
        return True  # punctuation and function-word changes ("a"->"an", "in"->"on", added comma)
    if len(old) == len(new) and all(token_fix(o, w) for o, w in zip(old, new)):
        return True
    co, cn = content(old), content(new)
    if len(co) == len(cn) and all(char_dist(p.lower(), q.lower()) <= max(2, len(q) // 3) for p, q in zip(co, cn)):
        return True  # e.g. "are be manufactured" -> "is manufactured" with matching content words
    return False


SENT_OK = re.compile(r"^[A-Z\"'(].*[.!?\"')]$")


def good_sentence(s):
    n = len(s.split())
    return (
        5 <= n <= 40
        and SENT_OK.match(s)
        and len(re.findall(r"[.!?](?:\s|$)", s)) <= 1
        and not re.match(r"^\d+[.)]", s)
        and sum(ord(c) > 127 for c in s) <= 2
        and "http" not in s
        and not re.search(r"(.)\1{4,}", s)
    )


def c4_pairs(shard_paths, limit, rnd):
    import pyarrow.parquet as pq

    out = []
    for path in shard_paths:
        table = pq.read_table(path, columns=["input", "output"])
        rows = list(zip(table.column("input").to_pylist(), table.column("output").to_pylist()))
        rnd.shuffle(rows)
        for src, tgt in rows:
            src, tgt = (src or "").strip(), (tgt or "").strip()
            if not src or not tgt or not good_sentence(tgt):
                continue
            if src == tgt:
                out.append((src, tgt))
            else:
                n = len(tgt.split())
                if abs(len(src.split()) - n) > max(2, n * 0.25) or src.count(" ") * len(tgt) > 4000:
                    continue
                hs = hunks(src, tgt)
                if 1 <= len(hs) <= 3 and all(is_minimal_fix(o, w) for o, w in hs):
                    out.append((src, tgt))
            if len(out) >= limit:
                return out
    return out


def engine_clean(sentences):
    """Indexes of sentences the ssc engine finds no confident issue in (None if engine unavailable)."""
    if not os.path.exists(SSC):
        return None
    inp = "\n".join(json.dumps(s) for s in sentences) + "\n"
    res = subprocess.run([SSC, "jsonl", "--data", os.path.join(ROOT, "data")], input=inp, capture_output=True, text=True, check=True)
    ok = set()
    for i, line in enumerate(res.stdout.splitlines()):
        issues = json.loads(line)
        if not any(x["confidence"] >= 0.85 for x in issues):
            ok.add(i)
    return ok


def fetch(url, dest):
    if not os.path.exists(dest):
        print(f"downloading {url} -> {dest}", file=sys.stderr)
        tmp = dest + ".part"
        urllib.request.urlretrieve(url, tmp)
        os.replace(tmp, dest)
    return dest


def held_out():
    """Benchmark sentences must never appear in training data."""
    s = set()
    for line in open(os.path.join(ROOT, "bench", "grammar.tsv"), encoding="utf-8"):
        if not line.startswith("#") and "\t" in line:
            a, b = line.rstrip("\n").split("\t")
            s.update([a.strip(), b.strip()])
    return s


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "train", "data"))
    ap.add_argument("--n", type=int, default=300000)
    ap.add_argument("--val", type=int, default=2000)
    ap.add_argument("--shards", type=int, default=1, help="C4_200M parquet shards to read (1.8M rows each)")
    ap.add_argument("--cache", default=os.path.join(ROOT, "train", "cache"))
    ap.add_argument("--sample", action="store_true", help="print a few examples of each kind")
    ap.add_argument("--seed", type=int, default=13)
    a = ap.parse_args()
    rnd = random.Random(a.seed)
    os.makedirs(a.out, exist_ok=True)
    os.makedirs(a.cache, exist_ok=True)

    total = a.n + a.val
    n_c4, n_synth = int(total * 0.5), int(total * 0.2)
    n_id = total - n_c4 - n_synth

    shards = [fetch(u, os.path.join(a.cache, f"c4_{i:04d}.parquet")) for i, u in enumerate(C4_SHARDS[: a.shards])]
    # Over-sample, then filter with the engine.
    pool = c4_pairs(shards, int((n_c4 + n_synth + n_id) * 1.6), rnd)
    banned = held_out()
    pool = [(s, t) for s, t in pool if s not in banned and t not in banned]
    clean_idx = engine_clean([t for _, t in pool])
    if clean_idx is None:
        print("warning: ssc engine not built; skipping the target-quality filter", file=sys.stderr)
    else:
        before = len(pool)
        pool = [p for i, p in enumerate(pool) if i in clean_idx]
        print(f"engine filter kept {len(pool)}/{before} pairs", file=sys.stderr)

    corrections = [(s, t) for s, t in pool if s != t]
    clean = list({t for _, t in pool})
    rnd.shuffle(clean)

    rows = [{"src": s, "tgt": t, "kind": "c4"} for s, t in corrections[:n_c4]]
    used = set()
    for t in clean:
        if sum(r["kind"] == "synth" for r in rows) >= n_synth:
            break
        bad = corrupt(t, rnd)
        if bad:
            rows.append({"src": bad, "tgt": t, "kind": "synth"})
            used.add(t)
    for t in clean:
        if sum(r["kind"] == "identity" for r in rows) >= n_id:
            break
        if t not in used:
            rows.append({"src": t, "tgt": t, "kind": "identity"})
    rnd.shuffle(rows)
    for r in rows:
        r["prompt"] = build_prompt(r["src"])
        r["completion"] = r["tgt"] + PROMPT["stop"]

    val, train = rows[: a.val], rows[a.val:]
    for name, part in (("train", train), ("val", val)):
        with open(os.path.join(a.out, f"{name}.jsonl"), "w", encoding="utf-8") as f:
            for r in part:
                f.write(json.dumps(r, ensure_ascii=False) + "\n")
    kinds = {k: sum(r["kind"] == k for r in rows) for k in ("c4", "synth", "identity")}
    print(json.dumps({"train": len(train), "val": len(val), **kinds}))
    if a.sample:
        for k in ("c4", "synth", "identity"):
            print(f"\n--- {k}")
            for r in [r for r in rows if r["kind"] == k][:6]:
                print(f"  {r['src']}\n  -> {r['tgt']}")


if __name__ == "__main__":
    main()
