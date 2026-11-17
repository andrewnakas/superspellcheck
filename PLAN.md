# SuperSpellCheck — Product & Technical Plan

## Context
Goal: a spelling + grammar checker that measurably beats Google (Chrome/Docs) and Grammarly, shipped as a cross-browser extension (Chrome, Edge, Firefox, Safari), English first, as a commercial product (free + paid tiers). Repo `andrewnakas/superspellcheck` is empty (README only) — greenfield.

**How we beat them (the thesis):**
1. **Accuracy you can prove** — a public benchmark harness (BEA-2019, CoNLL-2014, JFLEG, GitHub Typo Corpus, plus our own real-web corpus) run in CI; we only ship engine changes that move precision/recall (F0.5) up. Competitors don't publish numbers.
2. **Context-aware, not word-by-word** — Chrome's built-in checker is a dictionary + edit distance; we rank candidates with a language model over the full sentence (fixes real-word errors: "their/there", "form/from", "defiantly/definitely").
3. **Low false positives** — the #1 complaint about Grammarly is noise. Every suggestion carries a confidence score; we show only high-confidence ones by default and learn per-user (ignored suggestions suppress similar ones).
4. **Private by default + fast** — spelling and core grammar run on-device in WASM (<20 ms, offline, no text leaves the browser). Only ambiguous/rewrite cases escalate to the cloud LLM (opt-in, paid tier gets more).
5. **Works everywhere Grammarly breaks** — robust text-surface adapters for contenteditable, Google Docs (canvas), Gmail, Notion, Slack, Jira, CodeMirror/Monaco, shadow DOM, iframes.
6. **Domain smarts** — knows code identifiers, URLs, @mentions, product names, proper nouns pulled from the page/user context; personal + team dictionaries synced.

## Architecture (hybrid, 3 tiers)

```
Content script (per page)
  └─ Surface adapters → text extraction + offset mapping + underline overlay
        │ (debounced, paragraph-level diffs)
Background service worker / offscreen doc
  ├─ Tier 1  Spell engine (Rust→WASM): SymSpell + Hunspell-compatible dicts,
  │          keyboard-aware + phonetic edit model, n-gram LM reranker
  ├─ Tier 2  Local grammar: rule engine (Rust, LanguageTool-style rules
  │          ported/curated) + small ONNX GEC tagger (GECToR-style, quantized,
  │          onnxruntime-web WASM/WebGPU)
  ├─ Confidence fusion + per-user suppression + personal dictionary
  └─ Escalation queue → Tier 3
Cloud API (paid / opt-in)
  └─ Tier 3  LLM GEC + style/clarity/tone rewrites (Claude Haiku for checks,
             larger model for rewrites), structured JSON edits, zero retention
```

Escalation rule: a sentence goes to Tier 3 only if Tier 1/2 disagree, confidence is in the gray zone, or user requests "improve/rewrite". Keeps cost and latency low.

## Repo layout (monorepo, pnpm + Turborepo + Cargo workspace)
- `engine/` — Rust crate: tokenizer, SymSpell, edit model, n-gram LM, rule engine; built to WASM via `wasm-pack`. Same crate powers server + CLI.
- `models/` — training scripts (Python) for the GEC tagger and LM reranker; exports quantized ONNX.
- `extension/` — WXT framework (single codebase → Chrome/Edge/Firefox MV3 + Safari via Xcode converter). TypeScript + Preact UI.
  - `extension/src/adapters/` — textarea, contenteditable, Google Docs, Monaco/CodeMirror, Gmail, etc.
  - `extension/src/overlay/` — underline renderer (absolutely positioned layer, ResizeObserver/MutationObserver), suggestion card.
- `api/` — backend (TypeScript on Cloudflare Workers or Fastify): auth, billing (Stripe), LLM proxy, dictionary sync, rate limits.
- `bench/` — evaluation harness + datasets + competitor comparison scripts (Playwright drives Chrome spellcheck / Grammarly on same corpus).
- `web/` — marketing site + account dashboard.

## Phased roadmap

**Phase 0 – Foundations (wk 1–2)**: monorepo scaffold, CI, `bench/` harness with M2 scorer / ERRANT, baseline numbers for Hunspell, LanguageTool, Chrome, Grammarly (manual/Playwright). *This defines "better" before we write the engine.*

**Phase 1 – Spelling engine (wk 3–6)**: Rust SymSpell over a curated ~500k English wordlist (SCOWL + Wikipedia frequency), keyboard-adjacency + phonetic (Double Metaphone) error model, KenLM-style pruned n-gram LM (~20 MB) for context reranking and real-word errors. CLI + WASM build. Target: beat Chrome on top-1 correction accuracy by ≥10 pts.

**Phase 2 – Extension MVP (wk 5–10)**: WXT extension, textarea + contenteditable adapters, underline overlay, suggestion popover, accept/ignore/add-to-dictionary, keyboard shortcuts, settings page. Runs fully offline with Tier 1. Cross-browser builds in CI.

**Phase 3 – Local grammar (wk 9–14)**: rule engine (agreement, articles, commas, homophones, capitalization, repeated words) + quantized ONNX token-classification GEC model (~30–60 MB, lazy-downloaded, cached). Confidence fusion. Hard surfaces: Google Docs (annotated canvas / accessibility mode), Gmail, Notion, Slack, Monaco.

**Phase 4 – Cloud tier + accounts (wk 13–18)**: API, auth, Stripe billing, LLM escalation with structured edit output, rewrite/tone/clarity features, dictionary sync, team dictionaries. Strict privacy: TLS, no text retention, per-site disable, enterprise allowlist.

**Phase 5 – Polish & launch (wk 17–22)**: personalization (suppression learning), performance budgets, accessibility (screen reader announcements), store submissions (Chrome Web Store, Edge Add-ons, AMO, Safari App Store), public benchmark page.

## Commercial model
- **Free**: unlimited on-device spelling + core grammar, personal dictionary.
- **Pro (~$8–12/mo)**: cloud deep check, rewrites/tone, synced dictionaries, style guides.
- **Teams**: shared dictionaries/style guides, admin, SSO, data-residency.
On-device-first keeps marginal cost of free users near zero.

## Key risks
- Google Docs canvas rendering — needs a dedicated adapter; budget extra time.
- Safari extension limits (WASM size, background lifetime) — test early in Phase 2.
- Model size vs. load time — lazy download, quantize to int8, cache in IndexedDB.
- LLM false positives — constrain to minimal-edit JSON, verify with Tier 2 before showing.

## Verification
- `bench/` runs in CI on every engine PR: report P/R/F0.5 (ERRANT) per error type vs. stored baselines and competitors; fail on regression.
- Rust unit tests (`cargo test`), WASM tests in headless Chromium, extension E2E with Playwright loading the unpacked build against fixture pages (textarea, contenteditable, Gmail/Docs mocks) — assert underlines appear at correct offsets and accepting a fix edits text correctly.
- Latency budget tests: Tier 1 < 20 ms/paragraph, Tier 2 < 150 ms/paragraph on mid-range laptop.

## First implementation step after approval
Scaffold monorepo (`engine/`, `extension/`, `bench/`), build the benchmark harness with baselines, then the Rust SymSpell + WASM spike loaded in a minimal WXT extension on a textarea.
