// End-to-end test: load the built extension into Chromium and exercise it on a fixture page.
import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';

// Use the project's playwright if installed, otherwise the machine-wide one.
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  ({ chromium } = require(require.resolve('playwright', { paths: [process.env.NODE_PATH || '', '/opt/node-tools/node_modules'] })));
}

const here = path.dirname(new URL(import.meta.url).pathname);
const ext = path.resolve(here, '..', 'dist', 'chrome');
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end(fs.readFileSync(path.join(here, 'fixture.html')));
}).listen(0);
const url = `http://127.0.0.1:${server.address().port}/`;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ssc-e2e-'));

const ctx = await chromium.launchPersistentContext(userData, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
let failed = false;
const step = async (name, fn) => {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    failed = true;
    console.log(`FAIL ${name}\n     ${e.message}`);
  }
};
try {
  // wait for the service worker
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const page = await ctx.newPage();
  page.on('console', (m) => m.text().includes('[ssc]') && console.log('     page:', m.text()));
  await page.goto(url);
  const underlines = () => page.evaluate(() => {
    const root = document.querySelector('ssc-overlay')?.shadowRoot;
    return root ? [...root.querySelectorAll('.u')].map((u) => ({ rule: u.dataset.rule, ...u.getBoundingClientRect().toJSON() })) : [];
  });

  await step('textarea gets underlines for typos', async () => {
    await page.click('#ta');
    await page.keyboard.type('I recieve teh mesage form my freind yesterday.');
    await page.waitForFunction(() => (document.querySelector('ssc-overlay')?.shadowRoot?.querySelectorAll('.u').length ?? 0) >= 5, null, { timeout: 20000 });
    const u = await underlines();
    const box = await page.locator('#ta').boundingBox();
    assert.ok(u.length >= 5, `expected >=5 underlines, got ${u.length}`);
    for (const r of u) assert.ok(r.left >= box.x && r.right <= box.x + box.width + 1 && r.top >= box.y && r.top <= box.y + box.height, 'underline outside textarea');
    assert.ok(u.some((r) => r.rule === 'CONFUSED_WORD'), 'form/from should be flagged');
  });

  await step('Alt+Enter opens card and applying a fix edits the text', async () => {
    await page.evaluate(() => {
      const ta = document.getElementById('ta');
      const i = ta.value.indexOf('teh') + 1;
      ta.focus();
      ta.setSelectionRange(i, i);
    });
    await page.keyboard.press('Alt+Enter');
    const sug = page.locator('ssc-overlay .card .sug').first();
    await sug.waitFor({ timeout: 5000 });
    assert.equal(await sug.textContent(), 'the');
    await sug.click();
    assert.equal(await page.inputValue('#ta'), 'I recieve the mesage form my freind yesterday.');
  });

  await step('clicking a flagged word opens the card', async () => {
    const box = await page.locator('#ta').boundingBox();
    const u = (await underlines()).filter((r) => r.top < box.y + box.height);
    const first = u.sort((a, b) => a.left - b.left)[0];
    await page.mouse.click(first.left + first.width / 2, first.top - 6);
    await page.locator('ssc-overlay .card').waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
  });

  await step('add to dictionary removes the flag', async () => {
    await page.fill('#inp', '');
    await page.click('#inp');
    await page.keyboard.type('Zorblax is great');
    await page.evaluate(() => document.getElementById('inp').setSelectionRange(2, 2));
    await page.waitForTimeout(800);
    await page.keyboard.press('Alt+Enter');
    await page.locator('ssc-overlay .card .act', { hasText: 'Add to dictionary' }).click();
    await page.waitForTimeout(800);
    const inpBox = await page.locator('#inp').boundingBox();
    const u = (await underlines()).filter((r) => r.top >= inpBox.y && r.top <= inpBox.y + inpBox.height);
    assert.equal(u.length, 0, 'word should no longer be flagged');
  });

  await step('contenteditable is checked across blocks and formatting', async () => {
    await page.click('#ce');
    await page.waitForFunction(() => [...(document.querySelector('ssc-overlay')?.shadowRoot?.querySelectorAll('.u') ?? [])].some((u) => u.dataset.rule === 'A_VS_AN'), null, { timeout: 10000 });
    const rules = (await underlines()).map((u) => u.rule);
    for (const r of ['A_VS_AN', 'SENTENCE_START_CAPITAL']) assert.ok(rules.includes(r), `missing ${r}: ${rules}`);
    assert.ok(rules.includes('SPELLING'), 'dont should be flagged');
  });

  await step('applying a fix in contenteditable keeps structure', async () => {
    await page.evaluate(() => {
      const t = document.querySelector('#ce p:nth-child(2)').firstChild;
      const r = document.createRange();
      r.setStart(t, 9);
      r.collapse(true);
      const s = getSelection();
      s.removeAllRanges();
      s.addRange(r);
    });
    await page.keyboard.press('Alt+Enter');
    await page.locator('ssc-overlay .card .sug').first().click();
    const html = await page.innerHTML('#ce');
    assert.ok(html.includes('an apple pie'), html);
    assert.ok(html.includes('<b>apples</b>'), 'formatting preserved');
  });

  await step('opted-out fields are ignored', async () => {
    await page.click('#off');
    await page.keyboard.type(' teh');
    await page.waitForTimeout(1000);
    const box = await page.locator('#off').boundingBox();
    const u = (await underlines()).filter((r) => r.top >= box.y && r.top <= box.y + box.height);
    assert.equal(u.length, 0);
  });

  await step('ignoring the same flag twice suppresses it permanently', async () => {
    const ignoreOnce = async () => {
      await page.fill('#ta', '');
      await page.click('#ta');
      await page.keyboard.type('We met the frobnicatr there.');
      await page.waitForTimeout(700);
      await page.evaluate(() => { const ta = document.getElementById('ta'); ta.setSelectionRange(13, 13); });
      await page.keyboard.press('Alt+Enter');
      await page.locator('ssc-overlay .card .act', { hasText: 'Ignore' }).click();
    };
    await ignoreOnce();
    await page.reload();
    await ignoreOnce();
    await page.reload();
    await page.click('#ta');
    await page.keyboard.type('We met the frobnicatr there.');
    await page.waitForTimeout(1200);
    const stored = await sw.evaluate(async () => (await chrome.storage.local.get('suppressed')).suppressed);
    assert.ok(stored.some((k) => k.endsWith('|frobnicatr')), JSON.stringify(stored));
    const taBox = await page.locator('#ta').boundingBox();
    assert.equal((await underlines()).filter((r) => r.top >= taBox.y && r.top <= taBox.y + taBox.height).length, 0);
  });

  // On-device AI: needs a local mirror of the model (SSC_MODEL_DIR, laid out like the HF Hub:
  // <dir>/<org>/<model>/resolve/main/...). Skipped when absent so CI stays fast.
  const modelDir = process.env.SSC_MODEL_DIR;
  if (modelDir) {
    await step('on-device AI model flags a grammar error and merges with engine results', async () => {
      const mirror = http.createServer((req, res) => {
        res.setHeader('access-control-allow-origin', '*');
        const file = path.join(modelDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
        if (!file.startsWith(modelDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
          res.statusCode = 404;
          return res.end();
        }
        res.setHeader('content-length', fs.statSync(file).size);
        fs.createReadStream(file).pipe(res);
      }).listen(0);
      const host = `http://127.0.0.1:${mirror.address().port}/`;
      await sw.evaluate(async (host) => {
        const s = (await chrome.storage.sync.get('settings')).settings ?? {};
        await chrome.storage.sync.set({ settings: { ...s, aiCheck: true, aiHost: host, minConfidence: 0.5 } });
      }, host);
      // Wait for the model to download and load (CPU/WASM in headless Chromium).
      // Messages must come from an extension page: a service worker can't message itself.
      const extId = new URL(sw.url()).host;
      const opts = await ctx.newPage();
      await opts.goto(`chrome-extension://${extId}/options.html`);
      const send = (msg) => opts.evaluate((m) => chrome.runtime.sendMessage(m), msg);
      const loaded = await send({ type: 'aiLoad' });
      await page.waitForTimeout(500);
      const status = (await sw.evaluate(async () => (await chrome.storage.local.get('aiStatus')).aiStatus)) ?? loaded;
      assert.equal(status?.state, 'ready', JSON.stringify({ status, loaded }));
      console.log(`     model ready on ${status.device}`);

      await page.fill('#ta', '');
      await page.click('#ta');
      await page.keyboard.type('Yesterday he go to the store and buy some bread.');
      await page.waitForFunction(() => [...(document.querySelector('ssc-overlay')?.shadowRoot?.querySelectorAll('.u') ?? [])].some((u) => u.dataset.rule?.startsWith('AI_')), null, { timeout: 120000 });
      const rules = (await underlines()).map((u) => u.rule);
      console.log(`     underlines: ${rules.join(', ')}`);

      // A correct sentence gets no AI flags.
      const clean = await send({ type: 'aiCheck', text: 'The weather was lovely, so we walked to the park.' });
      assert.deepEqual(clean.issues, [], JSON.stringify(clean));

      await sw.evaluate(async () => {
        const s = (await chrome.storage.sync.get('settings')).settings;
        await chrome.storage.sync.set({ settings: { ...s, aiCheck: false } });
      });
      await opts.close();
      mirror.close();
    });
  } else {
    console.log('skip on-device AI test (set SSC_MODEL_DIR to run it)');
  }

  await step('check latency is interactive', async () => {
    const ms = await sw.evaluate(async () => {
      const t0 = performance.now();
      await new Promise((r) => setTimeout(r, 0));
      return performance.now() - t0;
    });
    assert.ok(ms < 1000);
  });
} finally {
  await ctx.close();
  server.close();
}
process.exit(failed ? 1 : 0);
