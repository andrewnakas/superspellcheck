# Training the on-device AI checker

The extension's **AI deep check** is a small model that runs inside the user's browser: free, private and offline. It is **Qwen3-0.6B** (Apache-2.0), fine-tuned to read one sentence and return it corrected with as few changes as possible, or unchanged when it's already fine. The extension aligns the model's output against the original text (`extension/src/diff.ts`) and underlines only the words that changed. If the model rewrites the sentence instead of correcting it, the output is thrown away.

Until you publish a fine-tuned model, the extension uses the stock `onnx-community/Qwen3-0.6B-ONNX`.

## What's here

| File | What it does |
|---|---|
| `prompt.json` | The exact prompt format. Training, evaluation and the extension all read this file, so they always match. |
| `make_data.py` | Builds the training set (details below) |
| `finetune.py` | LoRA fine-tune using TRL. Resumes from the last checkpoint and saves `merged/` at the end. |
| `export.py` | Converts the merged model to a 4-bit ONNX file for the browser (`onnx/model_q4f16.onnx`, about 650 MB) |
| `finetune.ipynb` | Runs all of the above on Colab or Kaggle, then publishes the result to the Hugging Face Hub |
| `../bench/ai_eval.py` | Scores a model on the grammar test set and on clean prose |

### Training data (`make_data.py`)

Defaults to 300k pairs:

- **50% real corrections** from Google's [C4_200M](https://github.com/google-research-datasets/C4_200M-synthetic-dataset-for-grammatical-error-correction) (CC BY 4.0). It keeps only short single sentences whose edits look like proofreading: typos, inflections, punctuation, capitals and small function words. Content rewrites are thrown out.
- **20% synthetic errors**, made with the engine's own data: keyboard typos, words from the confusion sets, irregular verbs, and the grammar rules run in reverse.
- **30% unchanged correct sentences.** These teach the model to leave good text alone, which keeps false alarms down.
- **Two safeguards:**
  - If the Rust engine is built (`cargo build --release`), it checks the corrected side of every pair and drops pairs that still contain errors. The raw dataset has some, e.g. "This is is the latest...".
  - Sentences from `bench/` are excluded so test results stay honest.

## Run it on Colab (free T4)

1. Open https://colab.research.google.com, choose **File → Upload notebook**, and pick `train/finetune.ipynb`. You can also open it straight from GitHub.
2. Go to **Runtime → Change runtime type** and choose **T4 GPU**.
3. Add your secrets with the key icon in the left sidebar. Turn on notebook access for each one.
   - `HF_TOKEN`: a Hugging Face token with **write** access, from https://huggingface.co/settings/tokens
   - `GITHUB_TOKEN` (only if the repo is private): a fine-grained token with read access to this repo
4. In the first code cell, set `HF_REPO` to `<your-hf-username>/superspellcheck-qwen3-0.6b-gec-ONNX`.
5. Choose **Runtime → Run all**. When Google Drive asks for access, approve it: checkpoints are saved there.
6. **If Colab disconnects** (free sessions do), reconnect and choose **Run all** again. Training picks up from the last checkpoint, saved every 500 steps.

## Run it on Kaggle (free 2×T4, 30 GPU hours a week)

1. Go to https://www.kaggle.com/code, choose **New Notebook → File → Import Notebook**, and upload `train/finetune.ipynb`.
2. In the right panel, set **Session options → Accelerator** to **GPU T4 x2**. Under **Internet**, choose **On**. Kaggle requires a phone-verified account for internet access.
3. Go to **Add-ons → Secrets** and add `HF_TOKEN` (and `GITHUB_TOKEN` if the repo is private). Tick both for this notebook.
4. Set `HF_REPO` in the first code cell, then choose **Run All**. The notebook detects both GPUs and trains on them together.
5. To run in the background, choose **Save Version → Save & Run All (Commit)**. The run continues after you close the tab (up to 12 hours per session), and outputs stay in `/kaggle/working`.

**Expected time:**

| Step | Time |
|---|---|
| Data | ~5 min |
| Engine build | ~4 min |
| Training, 300k pairs | ~2–4 h on 1 T4, roughly half that on 2×T4 |
| Export | ~5 min |

## Use the model in the extension

1. In `extension/src/types.ts`, set `aiModel` in `DEFAULT_SETTINGS` to your `HF_REPO`.
2. Rebuild: `cd extension && npm run build`.
3. In the extension's settings, turn on **AI deep check**. It downloads the model once and caches it.
4. To test locally without publishing, download the model into a folder laid out like the Hub (`<dir>/<user>/<repo>/resolve/main/...`). Then run:
   ```bash
   SSC_MODEL_DIR=<dir> SSC_AI_MODEL=<user>/<repo> npm run test:e2e
   ```

## Check quality before shipping

```bash
python bench/ai_eval.py --model <path-or-hub-id-of-merged-model>
```

It reports:

- **`model_exact_fix`**: the model alone on `bench/grammar.tsv`.
- **`engine_plus_model_exact_fix`**: what users see. The engine's fixes come first, and the model fills in sentences the engine left alone.
- **`model_clean_false_alarms`** and **`prose_sentences_changed_pct`**: how often the model changes correct text. Lower is better.

**Ship rule:** `engine_plus_model_exact_fix` must beat the engine alone (86.7%) without raising the false alarms. If it doesn't, train on more data or with more `identity` examples before making it the default.

| Model | Model alone | Engine + model | Clean-sentence false alarms | Prose sentences changed |
|---|---|---|---|---|
| CPU smoke test (20 steps, 40 examples) | 33.3% | 88.3% | 0 | 6.7% |
| Full run (300k) | *to fill in* | | | |
