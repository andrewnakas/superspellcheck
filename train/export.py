#!/usr/bin/env python3
"""Export the merged fine-tuned model to a transformers.js-ready 4-bit ONNX folder.

Uses onnxruntime-genai's model builder (the same tool behind onnx-community's
Qwen3 ONNX exports): int4 MatMulNBits weights, fp16 activations, fused
GroupQueryAttention, targeting WebGPU. Output layout matches what the extension loads:

  <out>/config.json            (+ transformers.js_config)
  <out>/generation_config.json, tokenizer files
  <out>/onnx/model_q4f16.onnx  (single file, about 570 MB for Qwen3-0.6B)

  python train/export.py --merged train/out/merged --out train/out/onnx-model
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile

import onnx

TOKENIZER_FILES = ["tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "added_tokens.json", "vocab.json", "merges.txt", "chat_template.jinja", "generation_config.json"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--merged", required=True, help="directory written by finetune.py (merged/)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--block-size", type=int, default=32)
    a = ap.parse_args()

    os.makedirs(os.path.join(a.out, "onnx"), exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        build = os.path.join(tmp, "build")
        cmd = [
            sys.executable, "-m", "onnxruntime_genai.models.builder",
            "-i", a.merged, "-o", build, "-p", "int4", "-e", "webgpu", "-c", os.path.join(tmp, "cache"),
            "--extra_options", f"int4_block_size={a.block_size}", "int4_accuracy_level=4",
        ]
        print(" ".join(cmd))
        subprocess.run(cmd, check=True)
        # Re-save as one file: transformers.js expects onnx/model_q4f16.onnx (no external data for < 2 GB).
        model = onnx.load(os.path.join(build, "model.onnx"), load_external_data=True)
        onnx.save_model(model, os.path.join(a.out, "onnx", "model_q4f16.onnx"), save_as_external_data=False)

    for f in TOKENIZER_FILES:
        src = os.path.join(a.merged, f)
        if os.path.exists(src):
            shutil.copy(src, os.path.join(a.out, f))
    cfg = json.load(open(os.path.join(a.merged, "config.json")))
    cfg["transformers.js_config"] = {"kv_cache_dtype": {"q4f16": "float16", "fp16": "float16"}}
    cfg.pop("torch_dtype", None)
    cfg.pop("dtype", None)
    json.dump(cfg, open(os.path.join(a.out, "config.json"), "w"), indent=2)
    size = os.path.getsize(os.path.join(a.out, "onnx", "model_q4f16.onnx")) / 1e6
    print(f"exported {a.out} (model_q4f16.onnx {size:.0f} MB)")


if __name__ == "__main__":
    main()
