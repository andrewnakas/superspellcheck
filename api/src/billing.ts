// Stripe billing: Checkout for new subscriptions, a signed webhook that keeps
// account status in sync, a one-time key reveal after payment, and the customer portal.
import { Hono } from 'hono';
import Stripe from 'stripe';
import type { AccountStore } from './db.ts';

export interface BillingConfig {
  stripe: Stripe;
  webhookSecret: string;
  pricePro: string;
  publicUrl: string;
}

export function billingConfigFromEnv(): BillingConfig | null {
  const { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_PRO, PUBLIC_URL } = process.env;
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET || !STRIPE_PRICE_PRO) return null;
  return { stripe: new Stripe(STRIPE_SECRET_KEY), webhookSecret: STRIPE_WEBHOOK_SECRET, pricePro: STRIPE_PRICE_PRO, publicUrl: PUBLIC_URL ?? 'http://localhost:8787' };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:48px auto;padding:0 16px;color:#1c2024;background:#fcfcfd}
code{display:block;padding:12px;background:#f0f0f3;border-radius:8px;word-break:break-all;font-size:15px}
@media (prefers-color-scheme:dark){body{background:#111113;color:#edeef0}code{background:#2e3135}}</style></head><body>${body}</body></html>`;

export function billingRoutes(store: AccountStore, cfg: BillingConfig | null) {
  const app = new Hono();

  app.use('*', async (c, next) => {
    if (!cfg) return c.json({ error: 'billing_not_configured' }, 503);
    await next();
  });

  // Start a subscription: returns a Stripe Checkout URL.
  app.post('/checkout', async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const email = String(body.email ?? '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'valid_email_required' }, 400);
    const acct = store.createPending(email);
    const session = await cfg!.stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: cfg!.pricePro, quantity: 1 }],
      customer_email: email,
      client_reference_id: acct.id,
      success_url: `${cfg!.publicUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${cfg!.publicUrl}/billing/canceled`,
    });
    return c.json({ url: session.url });
  });

  // Stripe -> us. Signature-verified; idempotent.
  app.post('/webhook', async (c) => {
    const sig = c.req.header('stripe-signature') ?? '';
    const raw = await c.req.text();
    let event: Stripe.Event;
    try {
      event = await cfg!.stripe.webhooks.constructEventAsync(raw, sig, cfg!.webhookSecret);
    } catch {
      return c.json({ error: 'bad_signature' }, 400);
    }
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        if (s.client_reference_id && s.payment_status !== 'unpaid') {
          store.activate(s.client_reference_id, typeof s.customer === 'string' ? s.customer : s.customer?.id ?? null, typeof s.subscription === 'string' ? s.subscription : s.subscription?.id ?? null);
        }
        break;
      }
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        store.setSubscriptionStatus(sub.id, event.type === 'customer.subscription.updated' && ['active', 'trialing', 'past_due'].includes(sub.status));
        break;
      }
    }
    return c.json({ received: true });
  });

  // After Checkout: show the API key once.
  app.get('/success', async (c) => {
    const id = c.req.query('session_id') ?? '';
    let s: Stripe.Checkout.Session;
    try {
      s = await cfg!.stripe.checkout.sessions.retrieve(id);
    } catch {
      return c.html(page('Not found', '<h1>We couldn’t find that checkout.</h1>'), 404);
    }
    const acctId = s.client_reference_id ?? '';
    if (s.status === 'complete' && s.payment_status !== 'unpaid' && store.get(acctId)?.status === 'pending') {
      // the webhook may not have arrived yet
      store.activate(acctId, typeof s.customer === 'string' ? s.customer : null, typeof s.subscription === 'string' ? s.subscription : null);
    }
    const key = store.issueFirstKey(acctId);
    if (!key) return c.html(page('Welcome to Pro', '<h1>You’re on Pro.</h1><p>Your API key was already shown. Lost it? Rotate it from the extension’s settings.</p>'));
    return c.html(
      page(
        'Your API key',
        `<h1>Welcome to SuperSpellCheck Pro</h1><p>Copy this key into the extension’s settings under <b>AI deep check</b>. It is shown only once.</p><code>${esc(key)}</code>`,
      ),
    );
  });

  app.get('/canceled', (c) => c.html(page('Checkout canceled', '<h1>No charge was made.</h1><p>You can upgrade any time from the extension’s settings.</p>')));

  // Manage or cancel the subscription.
  app.post('/portal', async (c) => {
    const auth = c.req.header('authorization') ?? '';
    const acct = store.accountForKey(auth.replace(/^Bearer\s+/, ''));
    if (!acct?.stripe_customer) return c.json({ error: 'invalid_api_key' }, 401);
    const portal = await cfg!.stripe.billingPortal.sessions.create({ customer: acct.stripe_customer, return_url: cfg!.publicUrl });
    return c.json({ url: portal.url });
  });

  return app;
}
