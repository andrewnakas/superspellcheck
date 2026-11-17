// Text surfaces: a uniform way to read text from an editable element, find
// the on-screen rectangles of a text range, and replace a range — without
// modifying the page's DOM structure (critical for React/Vue editors).

export interface Surface {
  el: HTMLElement;
  getText(): string;
  /** Viewport rects (client coordinates) for [start, end) in UTF-16 offsets. */
  rectsFor(ranges: Array<[number, number]>): DOMRect[][];
  /** Caret position as a text offset, or null if the caret isn't in this element. */
  caretOffset(): number | null;
  replace(start: number, end: number, text: string): void;
  /** Visible box of the element (client coordinates), used to clip underlines. */
  clipRect(): DOMRect;
  destroy(): void;
}

const MIRROR_PROPS = [
  'boxSizing', 'width', 'height', 'overflowX', 'overflowY',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth', 'borderStyle',
  'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'fontStyle', 'fontVariant', 'fontWeight', 'fontStretch', 'fontSize', 'fontSizeAdjust', 'lineHeight', 'fontFamily',
  'textAlign', 'textTransform', 'textIndent', 'letterSpacing', 'wordSpacing', 'tabSize', 'direction', 'textRendering',
] as const;

/** <textarea> and <input>: measured with an invisible mirror element. */
export class FieldSurface implements Surface {
  private mirror: HTMLDivElement;

  constructor(public el: HTMLTextAreaElement | HTMLInputElement, host: Node) {
    this.mirror = document.createElement('div');
    this.mirror.setAttribute('aria-hidden', 'true');
    host.appendChild(this.mirror);
  }

  getText() {
    return this.el.value;
  }

  private syncMirror() {
    const cs = getComputedStyle(this.el);
    const m = this.mirror.style;
    for (const p of MIRROR_PROPS) (m as any)[p] = (cs as any)[p];
    const isInput = this.el instanceof HTMLInputElement;
    m.position = 'fixed';
    const r = this.el.getBoundingClientRect();
    m.left = `${r.left}px`;
    m.top = `${r.top}px`;
    m.visibility = 'hidden';
    m.pointerEvents = 'none';
    m.whiteSpace = isInput ? 'pre' : 'pre-wrap';
    m.overflowWrap = isInput ? 'normal' : 'break-word';
    m.overflow = 'hidden';
    m.margin = '0';
    m.borderColor = 'transparent';
  }

  rectsFor(ranges: Array<[number, number]>): DOMRect[][] {
    this.syncMirror();
    const text = this.getText();
    const frag = document.createDocumentFragment();
    const spans: HTMLSpanElement[] = [];
    let pos = 0;
    // ranges are sorted and non-overlapping
    for (const [s, e] of ranges) {
      if (s > pos) frag.append(text.slice(pos, s));
      const span = document.createElement('span');
      span.textContent = text.slice(s, e);
      frag.append(span);
      spans.push(span);
      pos = e;
    }
    frag.append(text.slice(pos) + '​'); // trailing newline needs a glyph to take space
    this.mirror.replaceChildren(frag);
    this.mirror.scrollTop = this.el.scrollTop;
    this.mirror.scrollLeft = this.el.scrollLeft;
    return spans.map((s) => Array.from(s.getClientRects()));
  }

  caretOffset() {
    if (document.activeElement !== this.el) return null;
    return this.el.selectionStart ?? null;
  }

  replace(start: number, end: number, text: string) {
    const el = this.el;
    el.focus();
    el.setSelectionRange(start, end);
    // execCommand keeps native undo and fires the input events frameworks listen for.
    const ok = document.execCommand && document.execCommand('insertText', false, text);
    if (!ok || el.value.slice(start, start + text.length) !== text) {
      el.setRangeText(text, start, end, 'end');
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    }
  }

  clipRect() {
    return this.el.getBoundingClientRect();
  }

  destroy() {
    this.mirror.remove();
  }
}

const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'TABLE', 'TD', 'TH', 'TR', 'UL']);

interface Seg {
  node: Text;
  start: number; // global offset of node's first char
}

/** contenteditable editors (Gmail, Notion-like, CMS editors, ...). */
export class EditableSurface implements Surface {
  private segs: Seg[] = [];
  private text = '';

  constructor(public el: HTMLElement) {}

  private blockOf(n: Node): Node {
    let cur: Node | null = n.parentNode;
    while (cur && cur !== this.el) {
      if (cur instanceof HTMLElement && BLOCK.has(cur.tagName)) return cur;
      cur = cur.parentNode;
    }
    return this.el;
  }

  /** Build the flat text and the offset map. Block boundaries and <br> become "\n". */
  private scan() {
    const segs: Seg[] = [];
    let text = '';
    let lastBlock: Node | null = null;
    const walker = document.createTreeWalker(this.el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => {
        if (n instanceof HTMLElement) {
          if (n.tagName === 'BR') return NodeFilter.FILTER_ACCEPT;
          // skip non-editable islands (mentions, chips) and hidden content
          if (n.isContentEditable === false || n.tagName === 'SCRIPT' || n.tagName === 'STYLE') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_SKIP;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n instanceof HTMLElement) {
        text += '\n';
        lastBlock = null;
        continue;
      }
      const t = n as Text;
      const block = this.blockOf(t);
      if (lastBlock && block !== lastBlock && !text.endsWith('\n')) text += '\n';
      lastBlock = block;
      segs.push({ node: t, start: text.length });
      text += t.data;
    }
    this.segs = segs;
    this.text = text;
  }

  getText() {
    this.scan();
    return this.text;
  }

  private locate(offset: number, preferEnd: boolean): [Text, number] | null {
    // binary search for the segment containing offset
    let lo = 0;
    let hi = this.segs.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.segs[mid].start <= offset) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    if (found < 0) return null;
    let seg = this.segs[found];
    // At a boundary between two text nodes, a range end belongs to the earlier node.
    if (preferEnd && offset === seg.start && found > 0) {
      const prev = this.segs[found - 1];
      if (prev.start + prev.node.data.length === offset) seg = prev;
    }
    const local = offset - seg.start;
    if (local > seg.node.data.length) return null; // offset falls on a virtual "\n"
    return [seg.node, local];
  }

  private range(start: number, end: number): Range | null {
    const a = this.locate(start, false);
    const b = this.locate(end, true);
    if (!a || !b) return null;
    const r = document.createRange();
    try {
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
    } catch {
      return null;
    }
    return r;
  }

  rectsFor(ranges: Array<[number, number]>): DOMRect[][] {
    this.scan();
    return ranges.map(([s, e]) => {
      const r = this.range(s, e);
      return r ? Array.from(r.getClientRects()).filter((x) => x.width > 0) : [];
    });
  }

  caretOffset() {
    const sel = document.getSelection();
    if (!sel || !sel.anchorNode || !this.el.contains(sel.anchorNode)) return null;
    this.scan();
    const node = sel.anchorNode;
    if (node.nodeType === Node.TEXT_NODE) {
      const seg = this.segs.find((s) => s.node === node);
      return seg ? seg.start + sel.anchorOffset : null;
    }
    // caret between element children: use the first text node after it
    const child = node.childNodes[sel.anchorOffset];
    if (child) {
      const seg = this.segs.find((s) => child === s.node || child.contains(s.node));
      if (seg) return seg.start;
    }
    return null;
  }

  replace(start: number, end: number, text: string) {
    this.scan();
    const r = this.range(start, end);
    if (!r) return;
    this.el.focus();
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    const ok = document.execCommand && document.execCommand('insertText', false, text);
    if (!ok) {
      r.deleteContents();
      r.insertNode(document.createTextNode(text));
      this.el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: text }));
    }
  }

  clipRect() {
    return this.el.getBoundingClientRect();
  }

  destroy() {}
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', '']);

/** Find the editable surface root for an event target, or null if unsupported. */
export function editableRoot(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof HTMLElement)) return null;
  if (target instanceof HTMLTextAreaElement) return usable(target) ? target : null;
  if (target instanceof HTMLInputElement) return TEXT_INPUT_TYPES.has(target.type) && usable(target) ? target : null;
  if (target.isContentEditable) {
    let host: HTMLElement = target;
    while (host.parentElement && host.parentElement.isContentEditable) host = host.parentElement;
    return usable(host) ? host : null;
  }
  return null;
}

function usable(el: HTMLElement): boolean {
  if ((el as HTMLInputElement).readOnly || (el as HTMLInputElement).disabled) return false;
  if (el.closest('[data-gramm="false"], [data-ssc="off"]')) return false;
  // Respect pages that explicitly turned spellcheck off (code editors, OTP fields)
  // unless we were the ones who turned it off.
  if (el.getAttribute('spellcheck') === 'false' && !el.hasAttribute('data-ssc-native')) return false;
  // Code editors
  if (el.closest('.CodeMirror, .cm-editor, .monaco-editor, .ace_editor')) return false;
  const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
  if (/one-time-code|username|email|tel|cc-|postal|password/.test(ac)) return false;
  return true;
}
