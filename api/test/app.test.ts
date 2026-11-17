import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, EnvKeyStore, RateLimiter } from '../src/app.ts';

function fakeClient(edits: any[], seen: any[] = []) {
  return {
    beta: {
      messages: {
        parse: async (params: any) => {
          seen.push(params);
          const isRewrite = String(params.system).startsWith('You rewrite');
          return { stop_reason: 'end_turn', parsed_output: isRewrite ? { rewrites: ['A', 'B'] } : { edits } };
        },
      },
    },
  } as any;
}

const post = (app: any, path: string, body: unknown, key = 'k1') =>
  app.request(path, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('rejects missing or wrong keys', async () => {
  const app = createApp({ client: fakeClient([]), keys: new EnvKeyStore('k1:pro') });
  assert.equal((await post(app, '/v1/check', { text: 'hi' }, 'nope')).status, 401);
});

test('check returns located issues and sends the text inside tags', async () => {
  const seen: any[] = [];
  const app = createApp({ client: fakeClient([{ original: 'he go', replacement: 'he goes', before: '', category: 'grammar', explanation: 'Agreement.' }], seen), keys: new EnvKeyStore('k1:pro') });
  const res = await post(app, '/v1/check', { text: 'Every day he go home.' });
  assert.equal(res.status, 200);
  const { issues } = await res.json();
  assert.equal(issues.length, 1);
  assert.equal(issues[0].text, 'go');
  assert.equal(seen[0].messages[0].content, '<text>Every day he go home.</text>');
  assert.equal(seen[0].model, 'claude-opus-5-5');
  assert.equal(seen[0].fallbacks, 'default');
});

test('validates input', async () => {
  const app = createApp({ client: fakeClient([]), keys: new EnvKeyStore('k1:pro') });
  assert.equal((await post(app, '/v1/check', { text: '' })).status, 400);
  assert.equal((await post(app, '/v1/check', { text: 'x'.repeat(9000) })).status, 413);
  assert.equal((await post(app, '/v1/rewrite', { text: 'hi', goal: 'pirate' })).status, 400);
  const ok = await post(app, '/v1/rewrite', { text: 'hi there', goal: 'formal' });
  assert.deepEqual((await ok.json()).rewrites, ['A', 'B']);
});

test('rate limits per account', async () => {
  const app = createApp({ client: fakeClient([]), keys: new EnvKeyStore('k1:pro'), limiter: new RateLimiter(2) });
  assert.equal((await post(app, '/v1/check', { text: 'a' })).status, 200);
  assert.equal((await post(app, '/v1/check', { text: 'a' })).status, 200);
  assert.equal((await post(app, '/v1/check', { text: 'a' })).status, 429);
});
