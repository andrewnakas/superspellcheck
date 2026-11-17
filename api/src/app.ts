// Account and billing API. Checking itself runs entirely on the user's device
// (Rust engine + on-device Qwen model); no user text is ever sent here.
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { billingConfigFromEnv, billingRoutes, type BillingConfig } from './billing.ts';
import type { AccountStore } from './db.ts';

export interface Account {
  id: string;
  plan: 'pro' | 'team';
}

/** Resolves API keys to accounts. Swap for a database + Stripe-backed store in production. */
export interface KeyStore {
  lookup(key: string): Promise<Account | null>;
}

export class EnvKeyStore implements KeyStore {
  private keys = new Map<string, Account>();
  constructor(spec = process.env.SSC_API_KEYS ?? '') {
    // "key1:pro,key2:team"
    for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      const [key, plan = 'pro'] = part.split(':');
      this.keys.set(key, { id: `acct_${key.slice(-6)}`, plan: plan === 'team' ? 'team' : 'pro' });
    }
  }
  async lookup(key: string) {
    return this.keys.get(key) ?? null;
  }
}

/** Fixed-window limiter per account. */
export class RateLimiter {
  private windows = new Map<string, { start: number; n: number }>();
  private perMinute: number;
  private now: () => number;
  constructor(perMinute = 60, now = () => Date.now()) {
    this.perMinute = perMinute;
    this.now = now;
  }
  allow(id: string): boolean {
    const t = this.now();
    const w = this.windows.get(id);
    if (!w || t - w.start >= 60_000) {
      this.windows.set(id, { start: t, n: 1 });
      return true;
    }
    if (w.n >= this.perMinute) return false;
    w.n++;
    return true;
  }
}

export function createApp(opts: { keys?: KeyStore; limiter?: RateLimiter; accounts?: AccountStore; billing?: BillingConfig | null } = {}) {
  const accounts = opts.accounts;
  // Paid accounts (SQLite) first, then static dev keys from SSC_API_KEYS.
  const envKeys = new EnvKeyStore();
  const keys: KeyStore = opts.keys ?? { lookup: async (k) => (await accounts?.lookup(k)) ?? envKeys.lookup(k) };
  const limiter = opts.limiter ?? new RateLimiter(Number(process.env.SSC_RATE_PER_MIN ?? 60));
  const app = new Hono<{ Variables: { account: Account } }>();

  if (accounts) app.route('/billing', billingRoutes(accounts, opts.billing === undefined ? billingConfigFromEnv() : opts.billing));

  app.use('/v1/*', cors({ origin: '*', allowHeaders: ['authorization', 'content-type'], allowMethods: ['POST', 'GET'] }));
  app.get('/v1/health', (c) => c.json({ ok: true }));

  app.use('/v1/*', async (c, next) => {
    const auth = c.req.header('authorization') ?? '';
    const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const account = key ? await keys.lookup(key) : null;
    if (!account) return c.json({ error: 'invalid_api_key' }, 401);
    if (!limiter.allow(account.id)) return c.json({ error: 'rate_limited' }, 429);
    c.set('account', account);
    await next();
  });

  app.get('/v1/account', (c) => {
    const a = c.get('account');
    const usage = accounts?.usage(a.id);
    return c.json({ plan: a.plan, usage: usage ?? null });
  });

  app.post('/v1/rotate-key', (c) => {
    if (!accounts) return c.json({ error: 'not_supported' }, 404);
    const auth = c.req.header('authorization') ?? '';
    const key = accounts.rotateKey(auth.slice(7).trim());
    return key ? c.json({ key }) : c.json({ error: 'invalid_api_key' }, 401);
  });

  return app;
}
