#!/usr/bin/env python3
"""LoRA fine-tune of Qwen3-0.6B into a minimal-edit sentence corrector.

Runs on a free Colab T4 or Kaggle 2xT4 (fp16; T4s have no bf16). Checkpoints every
--save-steps so a disconnected session can resume with the same command.

  python train/finetune.py --data train/data --out train/out            # Colab, 1 GPU
  accelerate launch --num_processes 2 train/finetune.py ...              # Kaggle, 2 GPUs
  python train/finetune.py --smoke                                       # CPU sanity check
"""
import argparse
import glob
import json
import os

import torch
from datasets import load_dataset
from peft import LoraConfig
from transformers import AutoModelForCausalLM, AutoTokenizer
from trl import SFTConfig, SFTTrainer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", default="Qwen/Qwen3-0.6B")
    ap.add_argument("--data", default=os.path.join(ROOT, "train", "data"))
    ap.add_argument("--out", default=os.path.join(ROOT, "train", "out"))
    ap.add_argument("--epochs", type=float, default=1.0)
    ap.add_argument("--lr", type=float, default=2e-4)
    ap.add_argument("--batch", type=int, default=16, help="per-device batch size")
    ap.add_argument("--grad-accum", type=int, default=2)
    ap.add_argument("--max-len", type=int, default=192)
    ap.add_argument("--lora-r", type=int, default=32)
    ap.add_argument("--save-steps", type=int, default=500)
    ap.add_argument("--smoke", action="store_true", help="20 tiny steps on CPU to check the pipeline")
    a = ap.parse_args()

    if a.smoke:
        a.batch, a.grad_accum, a.max_len, a.save_steps = 2, 1, 96, 10

    cuda = torch.cuda.is_available()
    bf16 = cuda and torch.cuda.is_bf16_supported()
    fp16 = cuda and not bf16

    tok = AutoTokenizer.from_pretrained(a.model)
    if tok.pad_token is None:
        tok.pad_token = tok.eos_token
    # T4s have no bf16: keep fp32 master weights (2.4 GB for 0.6B) and train with fp16 autocast;
    # fp16 weights would break AMP gradient unscaling for the LoRA adapters.
    model = AutoModelForCausalLM.from_pretrained(a.model, torch_dtype=torch.bfloat16 if bf16 else torch.float32)

    files = {"train": os.path.join(a.data, "train.jsonl"), "validation": os.path.join(a.data, "val.jsonl")}
    ds = load_dataset("json", data_files=files)
    ds = ds.select_columns(["prompt", "completion"])
    if a.smoke:
        ds["train"] = ds["train"].select(range(min(40, len(ds["train"]))))
        ds["validation"] = ds["validation"].select(range(min(8, len(ds["validation"]))))
    else:
        ds["validation"] = ds["validation"].select(range(min(500, len(ds["validation"]))))

    cfg = SFTConfig(
        output_dir=a.out,
        num_train_epochs=a.epochs,
        max_steps=20 if a.smoke else -1,
        per_device_train_batch_size=a.batch,
        per_device_eval_batch_size=a.batch,
        gradient_accumulation_steps=a.grad_accum,
        learning_rate=a.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        weight_decay=0.0,
        max_length=a.max_len,
        completion_only_loss=True,  # learn the corrected sentence, not the prompt
        fp16=fp16,
        bf16=bf16,
        gradient_checkpointing=cuda,
        gradient_checkpointing_kwargs={"use_reentrant": False},  # required for LoRA + checkpointing + DDP
        ddp_find_unused_parameters=False,
        logging_steps=5 if a.smoke else 50,
        eval_strategy="steps",
        eval_steps=10 if a.smoke else 1000,
        save_strategy="steps",
        save_steps=a.save_steps,
        save_total_limit=2,
        report_to="none",
        dataloader_num_workers=2 if cuda else 0,
        seed=13,
    )
    lora = LoraConfig(r=a.lora_r, lora_alpha=a.lora_r * 2, lora_dropout=0.05, target_modules="all-linear", task_type="CAUSAL_LM")
    trainer = SFTTrainer(model=model, args=cfg, train_dataset=ds["train"], eval_dataset=ds["validation"], processing_class=tok, peft_config=lora)

    resume = bool(glob.glob(os.path.join(a.out, "checkpoint-*")))
    trainer.train(resume_from_checkpoint=resume or None)

    if trainer.is_world_process_zero():
        merged_dir = os.path.join(a.out, "merged")
        merged = trainer.model.merge_and_unload()
        merged = merged.to(torch.float16 if cuda else torch.float32)
        merged.save_pretrained(merged_dir, safe_serialization=True)
        tok.save_pretrained(merged_dir)
        with open(os.path.join(merged_dir, "ssc_training.json"), "w") as f:
            json.dump({"base_model": a.model, "args": vars(a), "metrics": trainer.state.log_history[-5:]}, f, indent=1)
        print(f"merged model saved to {merged_dir}")


if __name__ == "__main__":
    main()
