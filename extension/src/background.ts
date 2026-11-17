// Background (service worker on Chrome, event page on Firefox/Safari).
// Hosts the WASM engine once for all tabs; content scripts ask it to check text.
import init, { WasmEngine } from '../pkg/ssc_engine.js';
import { api, getApiKey, getDictionary, getSettings, setDictionary } from './storage';
import type { CheckResponse, Issue, Request, Settings } from './types';

let enginePromise: Promise<WasmEngine> | null = null;

async function loadText(path: string): Promise<string> {
  const res = await fetch(api.runtime.getURL(path));
  if (!res.ok || !res.body) throw new Error(`failed to load ${path}`);
  const stream = path.endsWith('.gz') ? res.body.pipeThrough(new DecompressionStream('gzip')) : res.body;
  return new Response(stream).text();
}

function engine(): Promise<WasmEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const t0 = performance.now();
      await init({ module_or_path: api.runtime.getURL('ssc_engine_bg.wasm') });
      const [lex, uni, bi, variants] = await Promise.all([
        loadText('data/lexicon.txt.gz'),
        loadText('data/unigrams.txt.gz'),
        loadText('data/bigrams.txt.gz'),
        loadText('data/lexicon_variants.txt.gz'),
      ]);
      const e = new WasmEngine(lex, uni, bi, variants);
      for (const w of await getDictionary()) e.addWord(w);
      console.info(`[ssc] engine ready in ${Math.round(performance.now() - t0)} ms`);
      return e;
    })();
    enginePromise.catch(() => (enginePromise = null));
  }
  return enginePromise;
}

// Per-paragraph cache: editing one paragraph of a long document only re-checks that paragraph.
const cache = new Map<string, Issue[]>();
const CACHE_MAX = 2000;
let cacheKeyPrefix = '';

function optionsJson(s: Settings): string {
  return JSON.stringify({ minConfidence: s.minConfidence, disabledRules: s.disabledRules, maxSuggestions: 5 });
}

async function check(text: string): Promise<Issue[]> {
  const [e, settings] = await Promise.all([engine(), getSettings()]);
  const opts = optionsJson(settings);
  if (opts !== cacheKeyPrefix) {
    cache.clear();
    cacheKeyPrefix = opts;
  }
  const out: Issue[] = [];
  // Split on line breaks, keeping offsets. Sentences never span paragraphs.
  const re = /[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const para = m[0];
    let issues = cache.get(para);
    if (!issues) {
      issues = JSON.parse(e.check(para, opts)) as Issue[];
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(para, issues);
    }
    for (const i of issues) out.push({ ...i, offset: i.offset + m.index });
  }
  return out;
}

// ---- Pro: AI deep check. Only runs when the user turned it on and has a key.
const deepCache = new Map<string, Issue[]>();
const MIN_WORDS = 4;

async function deepCheckParagraph(para: string, base: string, key: string): Promise<Issue[]> {
  const hit = deepCache.get(para);
  if (hit) return hit;
  const res = await fetch(`${base.replace(/\/$/, '')}/v1/check`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ text: para }),
  });
  if (!res.ok) throw new Error(`deep check failed: ${res.status}`);
  const issues = ((await res.json()).issues ?? []) as Issue[];
  if (deepCache.size >= CACHE_MAX) deepCache.delete(deepCache.keys().next().value as string);
  deepCache.set(para, issues);
  return issues;
}

async function deepCheck(text: string): Promise<Issue[]> {
  const [settings, key] = await Promise.all([getSettings(), getApiKey()]);
  if (!settings.deepCheck || !key) return [];
  const jobs: Array<Promise<Issue[]>> = [];
  const re = /[^\n]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const para = m[0];
    const index = m.index;
    if (para.trim().split(/\s+/).length < MIN_WORDS) continue;
    jobs.push(deepCheckParagraph(para, settings.apiBase, key).then((is) => is.map((i) => ({ ...i, offset: i.offset + index }))));
  }
  return (await Promise.all(jobs)).flat();
}

async function handle(msg: Request): Promise<unknown> {
  switch (msg.type) {
    case 'check': {
      const t0 = performance.now();
      try {
        const issues = await check(msg.text);
        return { issues, ms: performance.now() - t0 } satisfies CheckResponse;
      } catch (err) {
        return { error: String(err) } satisfies CheckResponse;
      }
    }
    case 'deepCheck': {
      const t0 = performance.now();
      try {
        return { issues: await deepCheck(msg.text), ms: performance.now() - t0 } satisfies CheckResponse;
      } catch (err) {
        return { error: String(err) } satisfies CheckResponse;
      }
    }
    case 'addWord': {
      const dict = await getDictionary();
      await setDictionary([...dict, msg.word]);
      (await engine()).addWord(msg.word);
      cache.clear();
      return { ok: true };
    }
    case 'removeWord': {
      const dict = await getDictionary();
      await setDictionary(dict.filter((w) => w.toLowerCase() !== msg.word.toLowerCase()));
      (await engine()).removeWord(msg.word);
      cache.clear();
      return { ok: true };
    }
    case 'getSettings':
      return getSettings();
    case 'ping':
      return { ok: true };
  }
}

api.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  handle(msg).then(sendResponse);
  return true; // async response
});

// Keep the engine in sync with dictionary edits made on the options page.
api.storage.onChanged.addListener(async (changes) => {
  if (changes.dictionary && enginePromise) {
    const e = await engine();
    const before: string[] = changes.dictionary.oldValue ?? [];
    const after: string[] = changes.dictionary.newValue ?? [];
    for (const w of before) if (!after.includes(w)) e.removeWord(w);
    for (const w of after) e.addWord(w);
    cache.clear();
  }
});

// Warm up on install/startup so the first check is fast.
api.runtime.onInstalled?.addListener(() => void engine());
api.runtime.onStartup?.addListener(() => void engine());
