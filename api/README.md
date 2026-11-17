# SuperSpellCheck API (Pro tier)

The cloud half of the hybrid design. The extension does spelling and core grammar on-device. When a Pro user opts in, paragraphs are also sent here for an AI "deep check" (subtle grammar, wrong words, clarity) and rewrites.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /v1/check` | `{ "text": "..." }` (≤ 8,000 chars) | `{ "issues": [...] }`, the same shape the on-device engine produces (UTF-16 offsets) |
| `POST /v1/rewrite` | `{ "text": "...", "goal": "clearer" \| "shorter" \| "formal" \| "friendly" }` | `{ "rewrites": ["...", "..."] }` |
| `GET /v1/health` | | `{ "ok": true }` |

All `/v1` routes need `Authorization: Bearer <key>`.

## How it stays accurate

The model proposes edits as "replace X with Y after Z". The server finds `X` in the text itself, using `Z` to pick the right occurrence, and shrinks each edit to the words that actually change. It drops anything it can't find, rewrites longer than 12 words, and edits that overlap (`src/locate.ts`), so a hallucinated edit never reaches the user.

## Privacy

Text is never logged or stored; only counts and timings are logged. The text is wrapped in `<text>` tags, and the prompt tells the model to ignore instructions inside it.

## Run

```bash
npm ci
export ANTHROPIC_API_KEY=...            # or `ant auth login`
export SSC_API_KEYS="devkey:pro"        # comma-separated key:plan pairs
npm start                               # listens on :8787
npm test                                # unit tests use a fake model client; no API calls
```

| Variable | Default | Purpose |
|---|---|---|
| `SSC_MODEL` | `claude-opus-5-5` | Model used for checks and rewrites |
| `SSC_RATE_PER_MIN` | `60` | Requests per minute per account |
| `PORT` | `8787` | Listen port |

Requests use server-side refusal fallbacks (`fallbacks: "default"`), so a declined request is retried on another model automatically.

`EnvKeyStore` is a stand-in for a real account store. Production needs a database-backed `KeyStore` wired to Stripe subscriptions (Phase 4 in `PLAN.md`).
