# SuperSpellCheck

Context-aware spelling and grammar checking that runs on your device, packaged as a browser extension for Chrome, Edge, Firefox and Safari.

- **Private by default.** The engine is Rust compiled to WebAssembly and runs inside the extension. No text leaves the browser.
- **Reads the sentence, not just the word.** A noisy-channel model combines a keyboard- and sound-aware typo model with an n-gram language model. That lets it pick the right fix in context, and catch correctly spelled wrong words ("form" for "from"), which dictionary checkers can't see.
- **Low noise.** Every issue carries a confidence score, and likely names, code, URLs, @mentions and regional spellings are left alone.
- **Optional on-device AI.** A fine-tuned Qwen3-0.6B model catches subtler grammar mistakes. It runs in the browser on WebGPU (or the CPU), so it's free and private too. Users opt in, and the model (about 600 MB) downloads once. See [train/README.md](train/README.md).

See [PLAN.md](PLAN.md) for the full product and technical roadmap.

## Repository layout

| Path | What it is |
|---|---|
| `engine/` | Rust engine: tokenizer, SymSpell candidate index, error model, language model, real-word confusion detection, grammar rules, `ssc` CLI, WASM bindings |
| `data/` | Lexicon (SCOWL), regional variants, unigram/bigram frequencies (see `data/LICENSES.md`) |
| `extension/` | MV3 extension (TypeScript + esbuild): background engine host, content script, options page, popup, Playwright E2E test |
| `train/` | Data generation, fine-tuning (Colab/Kaggle notebook) and ONNX export for the on-device AI model |
| `bench/` | Benchmark against Hunspell (Chrome's spellchecker) and Aspell, plus `ai_eval.py` for the AI model |
| `api/` | Accounts and Stripe billing for future paid features. No user text is ever sent here. |
| `web/` | Landing page |

## Build and run

```bash
# engine + CLI
cargo test --release
./target/release/ssc check "I recieve teh mesage form my freind."

# extension (needs wasm-pack and Node 22)
cd extension
npm ci
npm run wasm        # compile the engine to extension/pkg
npm run build       # -> dist/chrome, dist/firefox
npm run test:unit   # diff/alignment tests for the AI model's output
npm run test:e2e    # loads dist/chrome into headless Chromium
# with a local model mirror: SSC_MODEL_DIR=<dir> npm run test:e2e
```

To try the extension, open `chrome://extensions`, turn on Developer mode, choose **Load unpacked** and pick `extension/dist/chrome`. In Firefox, use `about:debugging` → **Load Temporary Add-on** → `extension/dist/firefox/manifest.json`. For Safari, run `xcrun safari-web-extension-converter extension/dist/chrome` on a Mac.

Click an underlined word, or press **Alt+Enter** with the caret on it, to see suggestions.

## Benchmark

```bash
sudo apt-get install hunspell hunspell-en-us aspell aspell-en   # competitors
bench/fetch.sh
python3 bench/run.py --quick          # or omit --quick for the full run
```

Results from `bench/run.py --quick`. Top-1 means the first suggestion is the correct word.

| Task | SuperSpellCheck | Hunspell (Chrome) | Aspell |
|---|---|---|---|
| Typos in real sentences, top-1 fix | **71.5%** | 29.7% | 31.3% |
| Wikipedia misspellings, top-1 | **82.0%** | 75.3% | 80.7% |
| Birkbeck `missp`, top-1 | **40.2%** | 30.2% | 37.5% |
| Holbrook (children's writing), top-1 | **29.7%** | 15.4% | 23.0% |
| Real-word errors caught ("form" → "from") | **76%** | 0% | 0% |
| Real-word false alarms per 100 clean sentences | **0.3** | n/a | n/a |
| Grammar test set (`bench/grammar.tsv`), exact fix | **86.7%** | 0% | 0% |
| False alarms per 1,000 words of clean prose | **7.6** | 12.9 | 16.7 |

CI runs the quick benchmark on every push. `bench/check_regression.py` fails the build if accuracy drops below the recorded floors or falls behind Hunspell.
