// HTTP API for the Pro tier. Privacy rules: text is never logged or stored;
// only counts and latencies are recorded.
import Anthropic from '@anthropic-ai/sdk';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { locate } from './locate.ts';
import { deepCheck, isGoal, RefusedError, rewrite, type Client } from './llm.ts';

export const MAX_CHARS = 8000;

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

export function createApp(opts: { client?: Client; keys?: KeyStore; limiter?: RateLimiter } = {}) {
  const client = opts.client ?? new Anthropic();
  const keys = opts.keys ?? new EnvKeyStore();
  const limiter = opts.limiter ?? new RateLimiter(Number(process.env.SSC_RATE_PER_MIN ?? 60));
  const app = new Hono<{ Variables: { account: Account } }>();

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

  const readText = async (c: any): Promise<{ text: string; body: any } | Response> => {
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const text = body?.text;
    if (typeof text !== 'string' || !text.trim()) return c.json({ error: 'text_required' }, 400);
    if (text.length > MAX_CHARS) return c.json({ error: 'text_too_long', max: MAX_CHARS }, 413);
    return { text, body };
  };

  const fail = (c: any, err: unknown) => {
    if (err instanceof RefusedError) return c.json({ error: 'declined' }, 422);
    if (err instanceof Anthropic.RateLimitError) return c.json({ error: 'upstream_busy' }, 503);
    if (err instanceof Anthropic.APIError) return c.json({ error: 'upstream_error', status: err.status }, 502);
    console.error('deep check failed:', err instanceof Error ? err.name : 'unknown');
    return c.json({ error: 'internal' }, 500);
  };

  app.post('/v1/check', async (c) => {
    const r = await readText(c);
    if (r instanceof Response) return r;
    const t0 = Date.now();
    try {
      const issues = locate(r.text, await deepCheck(client, r.text));
      console.log(JSON.stringify({ route: 'check', account: c.get('account').id, chars: r.text.length, issues: issues.length, ms: Date.now() - t0 }));
      return c.json({ issues });
    } catch (err) {
      return fail(c, err);
    }
  });

  app.post('/v1/rewrite', async (c) => {
    const r = await readText(c);
    if (r instanceof Response) return r;
    const goal = String(r.body.goal ?? 'clearer');
    if (!isGoal(goal)) return c.json({ error: 'invalid_goal' }, 400);
    try {
      return c.json({ rewrites: await rewrite(client, r.text, goal) });
    } catch (err) {
      return fail(c, err);
    }
  });

  return app;
}
