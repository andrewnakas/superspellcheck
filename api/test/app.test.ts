import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, EnvKeyStore, RateLimiter } from '../src/app.ts';

const get = (app: any, path: string, key = 'k1') => app.request(path, { headers: { authorization: `Bearer ${key}` } });

test('rejects missing or wrong keys', async () => {
  const app = createApp({ keys: new EnvKeyStore('k1:pro') });
  assert.equal((await get(app, '/v1/account', 'nope')).status, 401);
  assert.equal((await get(app, '/v1/account')).status, 200);
});

test('no text-checking endpoints exist: checking is on-device', async () => {
  const app = createApp({ keys: new EnvKeyStore('k1:pro') });
  for (const path of ['/v1/check', '/v1/rewrite']) {
    const res = await app.request(path, { method: 'POST', headers: { authorization: 'Bearer k1' }, body: '{"text":"hi"}' });
    assert.equal(res.status, 404, path);
  }
});

test('rate limits per account', async () => {
  const app = createApp({ keys: new EnvKeyStore('k1:pro'), limiter: new RateLimiter(2) });
  assert.equal((await get(app, '/v1/account')).status, 200);
  assert.equal((await get(app, '/v1/account')).status, 200);
  assert.equal((await get(app, '/v1/account')).status, 429);
});
