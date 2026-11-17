# SuperSpellCheck API (accounts and billing)

All checking, including the AI deep check, runs on the user's device, so this server never receives user text. It holds accounts, API keys and Stripe subscriptions for future paid features such as team dictionaries, style guides and sync.

| Endpoint | Body | Returns |
|---|---|---|
| `GET /v1/health` | | `{ "ok": true }` |
| `GET /v1/account` | | `{ "plan": "pro", "usage": { "requests": n, "chars": n } }` for this month |
| `POST /v1/rotate-key` | | `{ "key": "ssc_..." }`; the old key stops working |
| `POST /billing/checkout` | `{ "email": "..." }` | `{ "url": "<Stripe Checkout>" }` |
| `POST /billing/webhook` | Stripe event | Signature-verified; activates and cancels accounts |
| `GET /billing/success?session_id=` | | Page that shows the new API key once |
| `POST /billing/portal` | (Bearer key) | `{ "url": "<Stripe customer portal>" }` |

`/v1` routes need `Authorization: Bearer <key>`.

## Run

```bash
npm ci
export SSC_API_KEYS="devkey:pro"        # optional static dev keys, comma-separated key:plan pairs
npm start                               # listens on :8787
npm test                                # Stripe calls are stubbed
```

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
