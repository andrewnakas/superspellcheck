// Background (service worker on Chrome, event page on Firefox/Safari).
// Hosts the WASM engine once for all tabs; content scripts ask it to check text.
import init, { WasmEngine } from '../pkg/ssc_engine.js';
import { correctionToIssues, sentences } from './diff';
import { api, getDictionary, getSettings, setDictionary } from './storage';
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

// ---- On-device AI deep check (fine-tuned Qwen). Runs only if the user turned it on.
// Chrome hosts the model in an offscreen document (service workers can't run it);
// Firefox/Safari load offscreen.js into the background page itself.
const aiCache = new Map<string, Issue[]>(); // sentence -> sentence-relative issues
let aiCacheModel = '';
let creatingOffscreen: Promise<void> | null = null;

async function ensureOffscreen() {
  const off = (api as any).offscreen;
  if (!off) throw new Error('offscreen documents unsupported');
  if (await off.hasDocument?.()) return;
  creatingOffscreen ??= off
    .createDocument({ url: 'offscreen.html', reasons: ['WORKERS'], justification: 'Runs the on-device grammar model' })
    .finally(() => (creatingOffscreen = null));
  await creatingOffscreen;
}

async function ai(msg: object): Promise<any> {
  const hook = (globalThis as any).__sscAi;
  const full = { target: 'ssc-ai', ...msg };
  if (hook) return hook(full);
  await ensureOffscreen();
  return api.runtime.sendMessage(full);
}

async function aiLoad(s: Settings) {
  return ai({ type: 'load', model: s.aiModel, host: s.aiHost || undefined });
}

/** True if the model is ready; otherwise starts loading it in the background and returns false. */
async function aiReady(s: Settings): Promise<boolean> {
  const st = await ai({ type: 'status' });
  if (st?.state === 'ready' && st.model === s.aiModel) return true;
  if (st?.state !== 'loading') void aiLoad(s);
  return false;
}

const AI_MIN_WORDS = 3;
const AI_MAX_WORDS = 60;

async function aiCheck(text: string): Promise<Issue[]> {
  const s = await getSettings();
  if (!s.aiCheck || !(await aiReady(s))) return [];
  if (aiCacheModel !== s.aiModel) {
    aiCache.clear();
    aiCacheModel = s.aiModel;
  }
  const e = await engine();
  const sents = sentences(text).filter((x) => {
    const n = x.text.split(/\s+/).length;
    return n >= AI_MIN_WORDS && n <= AI_MAX_WORDS;
  });
  const todo = [...new Set(sents.map((x) => x.text).filter((t) => !aiCache.has(t)))];
  if (todo.length) {
    const res = await ai({ type: 'correct', sentences: todo });
    if (res?.error) throw new Error(res.error);
    todo.forEach((t, i) => {
      if (aiCache.size >= CACHE_MAX) aiCache.delete(aiCache.keys().next().value as string);
      aiCache.set(t, correctionToIssues(t, res.corrections[i] ?? t, (w) => e.isValid(w)));
    });
  }
  const minConf = s.minConfidence;
  return sents.flatMap((x) => (aiCache.get(x.text) ?? []).filter((i) => i.confidence >= minConf).map((i) => ({ ...i, offset: i.offset + x.offset })));
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
    case 'aiCheck': {
      const t0 = performance.now();
      try {
        return { issues: await aiCheck(msg.text), ms: performance.now() - t0 } satisfies CheckResponse;
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
    case 'ignore': {
      // Learn from dismissals: the second time the same flag is ignored, stop showing it for good.
      const { ignoreStats = {}, suppressed = [] } = await api.storage.local.get(['ignoreStats', 'suppressed']);
      ignoreStats[msg.key] = (ignoreStats[msg.key] ?? 0) + 1;
      const rule = msg.key.split('|')[0];
      ignoreStats[`rule:${rule}`] = (ignoreStats[`rule:${rule}`] ?? 0) + 1;
      if (ignoreStats[msg.key] >= 2 && !suppressed.includes(msg.key)) suppressed.push(msg.key);
      await api.storage.local.set({ ignoreStats, suppressed });
      return { ok: true };
    }
    case 'accepted': {
      const { acceptStats = {} } = await api.storage.local.get('acceptStats');
      acceptStats[msg.rule] = (acceptStats[msg.rule] ?? 0) + 1;
      await api.storage.local.set({ acceptStats });
      return { ok: true };
    }
    case 'aiLoad':
      return aiLoad(await getSettings());
    case 'aiStatus':
      await api.storage.local.set({ aiStatus: msg.status });
      return { ok: true };
    case 'getSettings':
      return getSettings();
    case 'ping':
      return { ok: true };
  }
}

api.runtime.onMessage.addListener((msg: Request, _sender, sendResponse) => {
  handle(msg).then(sendResponse, (err) => sendResponse({ error: String(err) }));
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
