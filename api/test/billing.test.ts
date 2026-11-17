import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { createApp, EnvKeyStore } from '../src/app.ts';
import { AccountStore, MONTHLY_CHAR_LIMIT } from '../src/db.ts';

const SECRET = 'whsec_test_secret';

function setup() {
  const stripe = new Stripe('sk_test_dummy');
  const sessions = new Map<string, any>();
  // Stub the two network calls; webhooks use the real SDK signature code.
  (stripe.checkout.sessions as any).create = async (p: any) => {
    const s = { id: `cs_${sessions.size}`, url: `https://checkout.test/${sessions.size}`, client_reference_id: p.client_reference_id, status: 'open', payment_status: 'unpaid', customer: null, subscription: null };
    sessions.set(s.id, s);
    return s;
  };
  (stripe.checkout.sessions as any).retrieve = async (id: string) => {
    if (!sessions.has(id)) throw new Error('no such session');
    return sessions.get(id);
  };
  const accounts = new AccountStore(':memory:');
  const app = createApp({ accounts, billing: { stripe, webhookSecret: SECRET, pricePro: 'price_123', publicUrl: 'https://ssc.test' } });
  const webhook = async (event: object) => {
    const payload = JSON.stringify(event);
    const header = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET });
    return app.request('/billing/webhook', { method: 'POST', headers: { 'stripe-signature': header }, body: payload });
  };
  return { app, accounts, sessions, webhook };
}

const json = (body: unknown, key?: string) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

test('checkout -> webhook -> one-time key -> API access -> cancellation', async () => {
  const { app, accounts, sessions, webhook } = setup();
  const res = await app.request('/billing/checkout', json({ email: 'a@b.co' }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).url, 'https://checkout.test/0');
  const s = sessions.get('cs_0');
  const acctId = s.client_reference_id;
  assert.equal(accounts.get(acctId)!.status, 'pending');

  // forged webhook is rejected
  const forged = await app.request('/billing/webhook', { method: 'POST', headers: { 'stripe-signature': 't=1,v1=bad' }, body: '{}' });
  assert.equal(forged.status, 400);

  Object.assign(s, { status: 'complete', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1' });
  const wh = await webhook({ id: 'evt_1', object: 'event', type: 'checkout.session.completed', data: { object: s } });
  assert.equal(wh.status, 200);
  assert.equal(accounts.get(acctId)!.status, 'active');

  const page1 = await (await app.request('/billing/success?session_id=cs_0')).text();
  const key = /<code>(ssc_[\w-]+)<\/code>/.exec(page1)?.[1];
  assert.ok(key, 'key shown');
  const page2 = await (await app.request('/billing/success?session_id=cs_0')).text();
  assert.ok(!page2.includes('<code>'), 'key shown only once');

  const acct = await (await app.request('/v1/account', { headers: { authorization: `Bearer ${key}` } })).json();
  assert.deepEqual(acct, { plan: 'pro', usage: { requests: 0, chars: 0 } });

  await webhook({ id: 'evt_2', object: 'event', type: 'customer.subscription.deleted', data: { object: { id: 'sub_1', object: 'subscription', status: 'canceled' } } });
  assert.equal((await app.request('/v1/account', { headers: { authorization: `Bearer ${key}` } })).status, 401);
});

test('monthly allowance is enforced', async () => {
  const { accounts } = setup();
  const a = accounts.createPending('x@y.co');
  accounts.activate(a.id, 'cus', 'sub_x');
  const acct = { id: a.id, plan: 'pro' as const };
  assert.ok(accounts.meter(acct, MONTHLY_CHAR_LIMIT.pro - 10));
  assert.ok(!accounts.meter(acct, 11));
  assert.ok(accounts.meter(acct, 11, new Date(Date.now() + 40 * 86400_000)), 'resets next month');
});

test('key rotation revokes the old key', async () => {
  const { app, accounts } = setup();
  const a = accounts.createPending('r@s.co');
  accounts.activate(a.id, 'cus', 'sub_r');
  const k1 = accounts.issueFirstKey(a.id)!;
  const res = await app.request('/v1/rotate-key', json({}, k1));
  const { key: k2 } = await res.json();
  assert.ok(k2 && k2 !== k1);
  assert.equal(await accounts.lookup(k1), null);
  assert.ok(await accounts.lookup(k2));
});

test('billing reports not configured without Stripe settings', async () => {
  const app = createApp({ accounts: new AccountStore(':memory:'), billing: null, keys: new EnvKeyStore('') });
  assert.equal((await app.request('/billing/checkout', json({ email: 'a@b.co' }))).status, 503);
});
