# SuperSpellCheck API (Pro tier)

The cloud half of the hybrid design. The extension does spelling and core grammar on-device. When a Pro user opts in, paragraphs are also sent here for an AI "deep check" (subtle grammar, wrong words, clarity) and rewrites.

| Endpoint | Body | Returns |
|---|---|---|
| `POST /v1/check` | `{ "text": "..." }` (≤ 8,000 chars) | `{ "issues": [...] }`, the same shape the on-device engine produces (UTF-16 offsets) |
| `POST /v1/rewrite` | `{ "text": "...", "goal": "clearer" \| "shorter" \| "formal" \| "friendly" }` | `{ "rewrites": ["...", "..."] }` |
| `GET /v1/health` | | `{ "ok": true }` |
| `GET /v1/account` | | `{ "plan": "pro", "usage": { "requests": n, "chars": n } }` for this month |
| `POST /v1/rotate-key` | | `{ "key": "ssc_..." }`; the old key stops working |
| `POST /billing/checkout` | `{ "email": "..." }` | `{ "url": "<Stripe Checkout>" }` |
| `POST /billing/webhook` | Stripe event | Signature-verified; activates and cancels accounts |
| `GET /billing/success?session_id=` | | Page that shows the new API key once |
| `POST /billing/portal` | (Bearer key) | `{ "url": "<Stripe customer portal>" }` |

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

## Accounts and billing

Accounts, API keys and monthly usage live in SQLite (`SSC_DB`, default `ssc.sqlite`, through `node:sqlite`). Only SHA-256 hashes of API keys are stored.

The flow:

1. `POST /billing/checkout` creates a pending account and a Stripe Checkout session.
2. Stripe's `checkout.session.completed` webhook activates the account. The success page does the same if the webhook hasn't arrived yet.
3. The success page shows the account's API key exactly once.
4. `customer.subscription.updated` and `customer.subscription.deleted` webhooks keep access in sync.

Monthly allowances are 2M characters for Pro and 10M for Team (`MONTHLY_CHAR_LIMIT`). Going over returns `402`.

| Variable | Purpose |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe API key |
| `STRIPE_WEBHOOK_SECRET` | Signing secret of the webhook endpoint pointed at `/billing/webhook` |
| `STRIPE_PRICE_PRO` | Price id of the Pro subscription |
| `PUBLIC_URL` | Public base URL, used for Checkout return links |

Billing routes return `503` until these are set. `SSC_API_KEYS` dev keys keep working alongside paid accounts.
