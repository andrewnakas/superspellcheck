// Hosts the AI model in a long-lived extension document. On Chrome this is an
// offscreen document; on Firefox/Safari this script runs inside the background page.
import { AiChecker, type AiStatus } from './ai';

const api: typeof chrome = (globalThis as any).browser ?? (globalThis as any).chrome;
const checker = new AiChecker();

export type AiRequest =
  | { target: 'ssc-ai'; type: 'load'; model: string; host?: string }
  | { target: 'ssc-ai'; type: 'correct'; sentences: string[] }
  | { target: 'ssc-ai'; type: 'status' };

// Offscreen documents can only use chrome.runtime, so status goes to the background,
// which stores it for the options page. In a background page we can write directly.
function publish(s: AiStatus) {
  if (api.storage?.local) api.storage.local.set({ aiStatus: s }).catch(() => {});
  else api.runtime.sendMessage({ type: 'aiStatus', status: s }).catch(() => {});
}

export async function handleAi(msg: AiRequest): Promise<unknown> {
  switch (msg.type) {
    case 'load':
      return checker.load({ model: msg.model, host: msg.host, onStatus: publish });
    case 'correct': {
      const out: string[] = [];
      for (const s of msg.sentences) out.push(await checker.correct(s));
      return { corrections: out };
    }
    case 'status':
      return checker.status;
  }
}

// Same-page callers (Firefox background) use this hook; runtime messages can't reach their own page.
(globalThis as any).__sscAi = handleAi;

api.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
  if (msg?.target !== 'ssc-ai') return false;
  handleAi(msg).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true;
});
