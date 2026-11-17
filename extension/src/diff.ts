// Turns "original sentence -> corrected sentence" into minimal, underline-able edits.
// The model never chooses offsets: we align its output against the real text and
// drop anything that looks like a rewrite rather than a correction.
import type { Category, Issue } from './types';

interface Tok {
  t: string;
  start: number; // UTF-16 offset in its string
}

function tokens(s: string): Tok[] {
  const out: Tok[] = [];
  const re = /\s+|[\p{L}\p{N}]+(?:['’][\p{L}]+)*|[^\s\p{L}\p{N}]/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) out.push({ t: m[0], start: m.index });
  return out;
}

export interface Hunk {
  offset: number;
  length: number;
  replacement: string;
}

/** Token-level LCS alignment -> list of replaced spans in `orig`. */
export function diffSentences(orig: string, fixed: string): Hunk[] {
  const a = tokens(orig);
  const b = tokens(fixed);
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i].t === b[j].t ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const hunks: Hunk[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i].t === b[j].t) {
      i++;
      j++;
      continue;
    }
    const i0 = i;
    const j0 = j;
    while ((i < n || j < m) && !(i < n && j < m && a[i].t === b[j].t)) {
      if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) j++;
      else i++;
    }
    const start = i0 < n ? a[i0].start : orig.length;
    const end = i > i0 ? a[i - 1].start + a[i - 1].t.length : start;
    const rep = b.slice(j0, j).map((x) => x.t).join('');
    hunks.push({ offset: start, length: end - start, replacement: rep });
  }
  // merge hunks separated only by whitespace ("he go to" -> "he goes to" stays one hunk per word)
  const merged: Hunk[] = [];
  for (const h of hunks) {
    const prev = merged[merged.length - 1];
    if (prev && /^\s*$/.test(orig.slice(prev.offset + prev.length, h.offset)) && h.offset - (prev.offset + prev.length) <= 1 && prev.length && h.length) {
      const gap = orig.slice(prev.offset + prev.length, h.offset);
      prev.replacement = prev.replacement + gap + h.replacement;
      prev.length = h.offset + h.length - prev.offset;
    } else merged.push({ ...h });
  }
  // Pure insertions get attached to a neighbouring word so there is something to underline:
  // directly after a word ("However" -> "However,") use that word, otherwise the next word
  // ("went store" -> "went to the store" underlines "store").
  const out: Hunk[] = [];
  for (const h of merged) {
    let { offset, length, replacement } = h;
    if (length === 0) {
      const before = /[\p{L}\p{N}'\u2019]+$/u.exec(orig.slice(0, offset));
      const after = /^[\p{L}\p{N}'\u2019]+/u.exec(orig.slice(offset));
      if (before) {
        offset -= before[0].length;
        length = before[0].length;
        replacement = before[0] + replacement;
      } else if (after) {
        length = after[0].length;
        replacement = replacement + after[0];
      } else continue;
    }
    const text = orig.slice(offset, offset + length);
    if (text.replace(/\s+/g, ' ').trim() === replacement.replace(/\s+/g, ' ').trim()) continue; // whitespace-only
    out.push({ offset, length, replacement });
  }
  return out;
}

/** Word counts used to tell a correction from a rewrite. */
function words(s: string): number {
  return (s.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

export function categorize(text: string, replacement: string, isValidWord: (w: string) => boolean): Category {
  if (text.toLowerCase() === replacement.toLowerCase()) return 'capitalization';
  const strip = (s: string) => s.replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim();
  if (strip(text) === strip(replacement)) return 'punctuation';
  if (/^[\p{L}']+$/u.test(text) && !isValidWord(text)) return 'spelling';
  return 'grammar';
}

/**
 * Convert a model correction into issues. Returns [] if the output is not a plausible
 * minimal correction (too many changes, different length, chatty reply).
 */
export function correctionToIssues(orig: string, fixed: string, isValidWord: (w: string) => boolean): Issue[] {
  fixed = fixed.trim();
  if (!fixed || fixed === orig.trim()) return [];
  const wo = words(orig);
  const wf = words(fixed);
  if (Math.abs(wo - wf) > Math.max(2, wo * 0.25)) return []; // a rewrite, or an explanation
  const hunks = diffSentences(orig, fixed);
  const changedWords = hunks.reduce((n, h) => n + Math.max(words(orig.slice(h.offset, h.offset + h.length)), words(h.replacement)), 0);
  if (hunks.length > 4 || changedWords > Math.max(3, wo * 0.4)) return [];
  return hunks.map((h) => {
    const text = orig.slice(h.offset, h.offset + h.length);
    const category = categorize(text, h.replacement, isValidWord);
    const message =
      category === 'spelling' ? 'Possible spelling mistake.' :
      category === 'capitalization' ? 'Capitalization.' :
      category === 'punctuation' ? 'Punctuation.' : 'This may not be grammatical.';
    return {
      offset: h.offset,
      length: h.length,
      text,
      category,
      rule: `AI_${category.toUpperCase()}`,
      message: `${message} (on-device AI)`,
      replacements: [h.replacement],
      confidence: 0.7,
    };
  });
}

/** Split a paragraph into sentences with their offsets. */
export function sentences(text: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  const re = /[^.!?\n]+(?:[.!?]+["'”’)]*|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const s = raw.trim();
    if (s) out.push({ text: s, offset: m.index + lead });
    if (m[0] === '') re.lastIndex++;
  }
  return out;
}
