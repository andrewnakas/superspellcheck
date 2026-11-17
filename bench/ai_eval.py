#!/usr/bin/env python3
"""Evaluate a corrector model (merged HF checkpoint or Hub id) on the benchmark sets.

Reports, on bench/grammar.tsv:
  - model alone: exact-fix rate on errors, false alarms on clean sentences
  - engine + model: the engine's fixes, with the model filling in sentences the engine left alone
and the share of clean prose sentences (big.txt) the model changes (false-alarm rate).

  python bench/ai_eval.py --model train/out/merged
"""
import argparse
import json
import os
import sys

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import grammar  # noqa: E402
import run  # noqa: E402

PROMPT = json.load(open(os.path.join(os.path.dirname(HERE), "train", "prompt.json")))


class Corrector:
    def __init__(self, model_id):
        dev = "cuda" if torch.cuda.is_available() else "cpu"
        if dev == "cpu":
            # Don't take over a laptop: low priority, half the cores.
            try:
                os.nice(10)
            except OSError:
                pass
            torch.set_num_threads(max(1, (os.cpu_count() or 2) // 2))
        self.tok = AutoTokenizer.from_pretrained(model_id)
        self.tok.padding_side = "left"
        if self.tok.pad_token is None:
            self.tok.pad_token = self.tok.eos_token
        self.model = AutoModelForCausalLM.from_pretrained(model_id, torch_dtype=torch.float16 if dev == "cuda" else torch.float32).to(dev).eval()
        self.dev = dev
        self.stop = self.tok.convert_tokens_to_ids(PROMPT["stop"])

    @torch.no_grad()
    def correct(self, sentences, batch=16):
        out = []
        for i in range(0, len(sentences), batch):
            chunk = sentences[i : i + batch]
            prompts = [PROMPT["template"].replace("{system}", PROMPT["system"]).replace("{src}", s) for s in chunk]
            enc = self.tok(prompts, return_tensors="pt", padding=True, add_special_tokens=False).to(self.dev)
            longest = max(len(self.tok(s, add_special_tokens=False).input_ids) for s in chunk)
            gen = self.model.generate(**enc, max_new_tokens=int(longest * 1.5) + 8, do_sample=False, eos_token_id=self.stop, pad_token_id=self.tok.pad_token_id)
            for row in gen[:, enc.input_ids.shape[1]:]:
                out.append(self.tok.decode(row, skip_special_tokens=True).split(PROMPT["stop"])[0].strip())
        return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--clean", type=int, default=300, help="clean prose sentences for the false-alarm check")
    a = ap.parse_args()
    c = Corrector(a.model)

    rows = [l.rstrip("\n").split("\t") for l in open(os.path.join(HERE, "grammar.tsv"), encoding="utf-8") if l.strip() and not l.startswith("#")]
    srcs = [s for s, _ in rows]
    model_out = c.correct(srcs)
    errs = [(s, e, m) for (s, e), m in zip(rows, model_out) if s != e]
    clean = [(s, e, m) for (s, e), m in zip(rows, model_out) if s == e]
    res = {
        "model_exact_fix": run.pct(sum(m == e for _, e, m in errs), len(errs)),
        "model_clean_false_alarms": sum(m != s for s, _, m in clean),
    }
    if os.path.exists(run.SSC):
        engine_issues = run.ssc_jsonl(srcs)
        combined = []
        for (s, e), m, iss in zip(rows, model_out, engine_issues):
            fixed = grammar.apply(s, iss)
            combined.append(fixed if fixed != s else m)
        res["engine_plus_model_exact_fix"] = run.pct(sum(o == e for (s, e), o in zip(rows, combined) if s != e), len(errs))
        res["engine_plus_model_clean_false_alarms"] = sum(o != s for (s, e), o in zip(rows, combined) if s == e)
    if os.path.exists(os.path.join(HERE, "data", "big.txt")):
        prose = run.clean_sentences(a.clean, seed=31)
        changed = sum(o != s for s, o in zip(prose, c.correct(prose)))
        res["prose_sentences_changed_pct"] = run.pct(changed, len(prose))
    print(json.dumps(res, indent=1))


if __name__ == "__main__":
    main()
