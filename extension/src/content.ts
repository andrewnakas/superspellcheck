// Content script: attaches to editable fields, asks the background engine to
// check their text and draws underlines + a suggestion card in a shadow-DOM
// overlay that never touches the page's own DOM.
import { api } from './storage';
import { editableRoot, EditableSurface, FieldSurface, Surface } from './surfaces';
import type { CheckResponse, Issue, Settings } from './types';

const DEBOUNCE_MS = 300;
const COLORS: Record<string, string> = {
  spelling: '#e5484d',
  grammar: '#3e63dd',
  punctuation: '#f5a524',
  capitalization: '#f5a524',
  word_choice: '#8e4ec6',
};

const STYLE = `
:host { all: initial; }
.layer { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647; overflow: hidden; }
.u { position: fixed; height: 2px; border-radius: 1px; pointer-events: none; opacity: .9; }
.card { position: fixed; pointer-events: auto; min-width: 220px; max-width: 340px; background: #fff; color: #1c2024;
  border-radius: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.18), 0 0 0 1px rgba(0,0,0,.06);
  font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; padding: 10px 12px; z-index: 2147483647; }
.card .msg { color: #60646c; font-size: 13px; margin-bottom: 8px; }
.card .sugs { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.card button { font: inherit; cursor: pointer; border: 0; border-radius: 6px; padding: 4px 10px; }
.card .sug { background: #3e63dd; color: #fff; font-weight: 600; }
.card .sug:focus-visible, .card .sug:hover { background: #3358d4; outline: none; }
.card .actions { display: flex; gap: 6px; border-top: 1px solid #e8e8ec; padding-top: 8px; }
.card .act { background: transparent; color: #60646c; padding: 2px 6px; font-size: 12px; }
.card .act:hover { background: #f0f0f3; }
.card .brand { margin-left: auto; color: #b9bbc6; font-size: 11px; align-self: center; }
.card .rw { display: block; width: 100%; text-align: left; background: #f0f0f3; color: inherit; margin-bottom: 6px; padding: 6px 8px; }
.card .rw:hover, .card .rw:focus-visible { background: #e0e1e6; outline: none; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-color-scheme: dark) {
  .card { background: #1c1d21; color: #edeef0; box-shadow: 0 8px 30px rgba(0,0,0,.5), 0 0 0 1px rgba(255,255,255,.08); }
  .card .msg { color: #b0b4ba; }
  .card .actions { border-color: #2e3135; }
  .card .act { color: #b0b4ba; }
  .card .act:hover { background: #2e3135; }
  .card .rw { background: #2e3135; }
  .card .rw:hover, .card .rw:focus-visible { background: #3a3f44; }
}
`;

// ---------------------------------------------------------------- overlay

const host = document.createElement('ssc-overlay');
const shadow = host.attachShadow({ mode: 'open' });
const style = document.createElement('style');
style.textContent = STYLE;
const layer = document.createElement('div');
layer.className = 'layer';
const live = document.createElement('div');
live.className = 'sr';
live.setAttribute('aria-live', 'polite');
shadow.append(style, layer, live);
function announce(msg: string) {
  live.textContent = '';
  window.setTimeout(() => (live.textContent = msg), 50);
}
let mounted = false;
function mount() {
  if (!mounted || !host.isConnected) {
    document.documentElement.appendChild(host);
    mounted = true;
  }
}

// ---------------------------------------------------------------- state

let settings: Settings | null = null;
const ignored = new Set<string>(); // "rule|text": ignored this session, or suppressed after repeated dismissals
const controllers = new Map<HTMLElement, Controller>();

class Controller {
  surface: Surface;
  issues: Issue[] = [];
  private underlines: HTMLDivElement[] = [];
  private timer = 0;
  private seq = 0;
  private composing = false;
  private resizeObs: ResizeObserver;

  constructor(public el: HTMLElement) {
    this.surface = el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? new FieldSurface(el, layer) : new EditableSurface(el);
    if (settings?.replaceNativeSpellcheck && el.spellcheck) {
      el.setAttribute('data-ssc-native', el.getAttribute('spellcheck') ?? '');
      el.spellcheck = false;
    }
    el.addEventListener('input', this.onInput);
    el.addEventListener('compositionstart', this.onCompStart);
    el.addEventListener('compositionend', this.onCompEnd);
    el.addEventListener('scroll', this.render, { passive: true });
    el.addEventListener('mouseup', this.onCaret);
    el.addEventListener('keyup', this.onKey);
    this.resizeObs = new ResizeObserver(() => this.render());
    this.resizeObs.observe(el);
    this.check();
  }

  private onInput = () => {
    hideCard();
    this.clearUnderlines(); // text moved; stale underlines would be misplaced
    window.clearTimeout(this.timer);
    if (!this.composing) this.timer = window.setTimeout(() => this.check(), DEBOUNCE_MS);
  };
  private onCompStart = () => (this.composing = true);
  private onCompEnd = () => {
    this.composing = false;
    this.onInput();
  };
  private onCaret = () => window.setTimeout(() => this.openCardAtCaret(false), 0);
  private onKey = (e: KeyboardEvent) => {
    // Alt+Enter (Option+Enter on Mac) opens suggestions for the issue at the caret
    if (e.key === 'Enter' && e.altKey) this.openCardAtCaret(true);
  };

  async check() {
    const text = this.surface.getText();
    const id = ++this.seq;
    if (!text.trim()) {
      this.issues = [];
      this.render();
      return;
    }
    let res: CheckResponse;
    try {
      res = await api.runtime.sendMessage({ type: 'check', text });
    } catch {
      return; // extension reloaded / context invalidated
    }
    if (id !== this.seq || this.surface.getText() !== text) return; // stale
    if ('error' in res) {
      console.warn('[ssc]', res.error);
      return;
    }
    this.issues = res.issues.filter((i) => !ignored.has(`${i.rule}|${i.text}`));
    this.render();
    if (settings?.deepCheck) this.deepCheck(text, id);
  }

  /** Pro: merge AI findings that don't overlap what the local engine already found. */
  private async deepCheck(text: string, id: number) {
    let res: CheckResponse;
    try {
      res = await api.runtime.sendMessage({ type: 'deepCheck', text });
    } catch {
      return;
    }
    if (id !== this.seq || this.surface.getText() !== text || 'error' in res) return;
    const extra = res.issues.filter(
      (a) => !ignored.has(`${a.rule}|${a.text}`) && !this.issues.some((l) => a.offset < l.offset + l.length && l.offset < a.offset + a.length),
    );
    if (!extra.length) return;
    this.issues = [...this.issues, ...extra].sort((a, b) => a.offset - b.offset);
    this.render();
  }

  private clearUnderlines() {
    for (const u of this.underlines) u.remove();
    this.underlines = [];
  }

  render = () => {
    this.clearUnderlines();
    if (!this.el.isConnected || !this.issues.length) return;
    mount();
    const clip = this.surface.clipRect();
    const rects = this.surface.rectsFor(this.issues.map((i) => [i.offset, i.offset + i.length]));
    rects.forEach((rs, k) => {
      const color = COLORS[this.issues[k].category] ?? COLORS.spelling;
      for (const r of rs) {
        const bottom = r.bottom - 1;
        if (bottom < clip.top || bottom > clip.bottom + 1 || r.right < clip.left || r.left > clip.right) continue;
        const left = Math.max(r.left, clip.left);
        const right = Math.min(r.right, clip.right);
        const u = document.createElement('div');
        u.className = 'u';
        u.style.cssText = `left:${left}px;top:${bottom}px;width:${right - left}px;background:${color}`;
        u.dataset.rule = this.issues[k].rule;
        layer.appendChild(u);
        this.underlines.push(u);
      }
    });
  };

  issueAt(offset: number): Issue | undefined {
    return this.issues.find((i) => offset >= i.offset && offset <= i.offset + i.length);
  }

  openCardAtCaret(focusFirst: boolean) {
    const off = this.surface.caretOffset();
    if (off == null) return;
    const issue = this.issueAt(off);
    if (issue) showCard(this, issue, focusFirst);
    else hideCard();
  }

  apply(issue: Issue, replacement: string) {
    // Re-validate: the text may have changed since the check.
    const text = this.surface.getText();
    if (text.slice(issue.offset, issue.offset + issue.length) !== issue.text) return this.check();
    this.surface.replace(issue.offset, issue.offset + issue.length, replacement);
    api.runtime.sendMessage({ type: 'accepted', rule: issue.rule }).catch(() => {});
    const delta = replacement.length - issue.length;
    this.issues = this.issues.filter((i) => i !== issue).map((i) => (i.offset > issue.offset ? { ...i, offset: i.offset + delta } : i));
    this.render();
  }

  destroy() {
    window.clearTimeout(this.timer);
    this.clearUnderlines();
    this.resizeObs.disconnect();
    this.el.removeEventListener('input', this.onInput);
    this.el.removeEventListener('compositionstart', this.onCompStart);
    this.el.removeEventListener('compositionend', this.onCompEnd);
    this.el.removeEventListener('scroll', this.render);
    this.el.removeEventListener('mouseup', this.onCaret);
    this.el.removeEventListener('keyup', this.onKey);
    if (this.el.hasAttribute('data-ssc-native')) {
      const prev = this.el.getAttribute('data-ssc-native');
      if (prev) this.el.setAttribute('spellcheck', prev);
      else this.el.removeAttribute('spellcheck');
      this.el.removeAttribute('data-ssc-native');
    }
    this.surface.destroy();
  }
}

// ---------------------------------------------------------------- card

let card: HTMLDivElement | null = null;
let cardOwner: Controller | null = null;

function hideCard() {
  card?.remove();
  card = null;
  cardOwner = null;
}

/** Bounds of the sentence containing `offset`. */
function sentenceAround(text: string, offset: number): [number, number] {
  let start = offset;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start--;
  while (start < offset && /\s/.test(text[start])) start++;
  let end = offset;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end++;
  if (end < text.length && text[end] !== '\n') end++;
  return [start, end];
}

async function showRewrites(ctrl: Controller, c: HTMLDivElement, at: number) {
  const text = ctrl.surface.getText();
  const [s, e] = sentenceAround(text, at);
  const sentence = text.slice(s, e);
  const body = document.createElement('div');
  body.className = 'msg';
  body.textContent = 'Rewriting\u2026';
  c.replaceChildren(body);
  announce('Rewriting sentence');
  const res = await api.runtime.sendMessage({ type: 'rewrite', text: sentence, goal: 'clearer' }).catch(() => ({ error: 'unavailable' }));
  if (card !== c) return;
  if (!res || 'error' in res || !res.rewrites?.length) {
    body.textContent = 'Couldn\u2019t get a rewrite right now.';
    return;
  }
  body.textContent = 'Pick a version:';
  for (const r of res.rewrites as string[]) {
    const b = document.createElement('button');
    b.className = 'rw';
    b.textContent = r;
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
    b.addEventListener('click', () => {
      hideCard();
      if (ctrl.surface.getText().slice(s, e) === sentence) {
        ctrl.surface.replace(s, e, r);
        api.runtime.sendMessage({ type: 'accepted', rule: 'AI_REWRITE' }).catch(() => {});
      }
    });
    c.append(b);
  }
  (c.querySelector('.rw') as HTMLButtonElement | null)?.focus();
  announce(`${res.rewrites.length} rewrites available`);
}

function showCard(ctrl: Controller, issue: Issue, focusFirst: boolean) {
  hideCard();
  mount();
  const rects = ctrl.surface.rectsFor([[issue.offset, issue.offset + issue.length]])[0];
  const anchor = rects[rects.length - 1];
  if (!anchor) return;
  const c = document.createElement('div');
  c.className = 'card';
  c.setAttribute('role', 'dialog');
  c.setAttribute('aria-label', 'Writing suggestion');
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = issue.message;
  c.append(msg);
  if (issue.replacements.length) {
    const sugs = document.createElement('div');
    sugs.className = 'sugs';
    for (const rep of issue.replacements.slice(0, 5)) {
      const b = document.createElement('button');
      b.className = 'sug';
      b.textContent = rep === '' ? '(delete)' : rep;
      b.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the editor
      b.addEventListener('click', () => {
        hideCard();
        ctrl.apply(issue, rep);
      });
      sugs.append(b);
    }
    c.append(sugs);
  }
  const actions = document.createElement('div');
  actions.className = 'actions';
  const ignore = document.createElement('button');
  ignore.className = 'act';
  ignore.textContent = 'Ignore';
  ignore.addEventListener('click', () => {
    ignored.add(`${issue.rule}|${issue.text}`);
    api.runtime.sendMessage({ type: 'ignore', key: `${issue.rule}|${issue.text}` }).catch(() => {});
    for (const ct of controllers.values()) {
      ct.issues = ct.issues.filter((i) => !(i.rule === issue.rule && i.text === issue.text));
      ct.render();
    }
    hideCard();
  });
  actions.append(ignore);
  if (issue.category === 'spelling') {
    const add = document.createElement('button');
    add.className = 'act';
    add.textContent = 'Add to dictionary';
    add.addEventListener('click', async () => {
      hideCard();
      await api.runtime.sendMessage({ type: 'addWord', word: issue.text });
      for (const ct of controllers.values()) ct.check();
    });
    actions.append(add);
  }
  if (settings?.deepCheck) {
    const improve = document.createElement('button');
    improve.className = 'act';
    improve.textContent = 'Improve sentence';
    improve.addEventListener('mousedown', (ev) => ev.preventDefault());
    improve.addEventListener('click', () => showRewrites(ctrl, c, issue.offset));
    actions.append(improve);
  }
  const brand = document.createElement('span');
  brand.className = 'brand';
  brand.textContent = 'SuperSpellCheck';
  actions.append(brand);
  c.append(actions);
  layer.append(c);
  // place below the word, flip above if there is no room
  const cr = c.getBoundingClientRect();
  let top = anchor.bottom + 6;
  if (top + cr.height > window.innerHeight - 8) top = anchor.top - cr.height - 6;
  const left = Math.min(Math.max(8, anchor.left), window.innerWidth - cr.width - 8);
  c.style.left = `${left}px`;
  c.style.top = `${Math.max(8, top)}px`;
  card = c;
  cardOwner = ctrl;
  if (focusFirst) {
    (c.querySelector('button') as HTMLButtonElement | null)?.focus();
    const sug = issue.replacements.length ? ` Suggestions: ${issue.replacements.slice(0, 3).join(', ')}.` : '';
    announce(`${issue.message}${sug}`);
  }
  // Arrow keys move between the card's buttons.
  c.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const buttons = [...c.querySelectorAll('button')] as HTMLButtonElement[];
    const i = buttons.indexOf(shadow.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const next = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? i + 1 : i - 1;
    buttons[(next + buttons.length) % buttons.length].focus();
  });
}

// ---------------------------------------------------------------- wiring

function siteDisabled(s: Settings) {
  return !s.enabled || s.disabledSites.includes(location.hostname);
}

function attach(target: EventTarget | null) {
  if (!settings || siteDisabled(settings)) return;
  const root = editableRoot(target);
  if (!root || controllers.has(root)) return;
  controllers.set(root, new Controller(root));
}

function rerenderAll() {
  for (const [el, c] of controllers) {
    if (!el.isConnected) {
      c.destroy();
      controllers.delete(el);
    } else c.render();
  }
}

let raf = 0;
function scheduleRender() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    rerenderAll();
    hideCard();
  });
}

async function start() {
  try {
    settings = await api.runtime.sendMessage({ type: 'getSettings' });
  } catch {
    return;
  }
  document.addEventListener('focusin', (e) => attach(e.composedPath()[0] ?? e.target), true);
  if (document.activeElement) attach(document.activeElement);
  window.addEventListener('scroll', scheduleRender, { capture: true, passive: true });
  window.addEventListener('resize', scheduleRender, { passive: true });
  document.addEventListener('keydown', (e) => {
    if (card && e.key === 'Escape') {
      e.stopPropagation();
      const owner = cardOwner;
      const focusInCard = document.activeElement === host;
      hideCard();
      if (focusInCard) owner?.el.focus();
    }
  }, true);
  document.addEventListener('mousedown', (e) => {
    if (card && !e.composedPath().includes(card)) hideCard();
  }, true);
  try {
    const { suppressed = [] } = await api.storage.local.get('suppressed');
    for (const k of suppressed as string[]) ignored.add(k);
  } catch {}
  api.storage.onChanged.addListener((changes) => {
    if (changes.suppressed) for (const k of (changes.suppressed.newValue ?? []) as string[]) ignored.add(k);
    if (!changes.settings) return;
    settings = { ...settings!, ...changes.settings.newValue };
    for (const [el, c] of controllers) {
      if (siteDisabled(settings!)) {
        c.destroy();
        controllers.delete(el);
      } else c.check();
    }
  });
}

start();
