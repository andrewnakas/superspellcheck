// Turns model-proposed edits ("replace X with Y") into exact UTF-16 offsets,
// and drops anything that can't be located or isn't a minimal correction.
// The model never gets to say where in the text an edit goes: we verify it.

export interface ProposedEdit {
  original: string;
  replacement: string;
  /** A few words of text right before `original`, used to pick the right occurrence. */
  before: string;
  category: 'spelling' | 'grammar' | 'punctuation' | 'capitalization' | 'word_choice' | 'clarity';
  explanation: string;
}

export interface LocatedIssue {
  offset: number;
  length: number;
  text: string;
  category: string;
  rule: string;
  message: string;
  replacements: string[];
  confidence: number;
}

const MAX_EDIT_WORDS = 12;

function words(s: string): number {
  return s.trim().split(/\s+/).filter(Boolean).length;
}

/** All start indexes of `needle` in `hay`. */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) out.push(i);
  return out;
}

/** Shrink an edit to the part that actually changes (common prefix/suffix trimmed at word boundaries). */
export function minimize(original: string, replacement: string): { start: number; orig: string; rep: string } {
  let p = 0;
  while (p < original.length && p < replacement.length && original[p] === replacement[p]) p++;
  // back up to a word boundary so we underline whole words
  while (p > 0 && /\w/.test(original[p - 1] ?? '')) p--;
  let s = 0;
  while (s < original.length - p && s < replacement.length - p && original[original.length - 1 - s] === replacement[replacement.length - 1 - s]) s++;
  while (s > 0 && /\w/.test(original[original.length - s] ?? '')) s--;
  return { start: p, orig: original.slice(p, original.length - s), rep: replacement.slice(p, replacement.length - s) };
}

export function locate(text: string, edits: ProposedEdit[]): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  const taken: Array<[number, number]> = [];
  for (const e of edits) {
    if (!e.original || e.original === e.replacement) continue;
    if (words(e.original) > MAX_EDIT_WORDS || words(e.replacement) > MAX_EDIT_WORDS) continue; // not a proofreading fix
    const hits = occurrences(text, e.original);
    if (!hits.length) continue; // hallucinated text
    let at = hits[0];
    if (hits.length > 1 && e.before) {
      const withCtx = occurrences(text, e.before + e.original);
      const ctxTrim = withCtx.length ? withCtx : occurrences(text, e.before.trimEnd() + ' ' + e.original.trimStart());
      if (ctxTrim.length) at = ctxTrim[0] + (text.indexOf(e.original, ctxTrim[0]) - ctxTrim[0]);
    }
    const m = minimize(e.original, e.replacement);
    if (!m.orig && !m.rep) continue;
    let offset = at + m.start;
    let length = m.orig.length;
    let rep = m.rep;
    if (length === 0) {
      // pure insertion (e.g. a missing comma): attach it to the previous word so there is something to underline
      const prevWord = /\S+$/.exec(text.slice(0, offset));
      if (!prevWord) continue;
      offset -= prevWord[0].length;
      length = prevWord[0].length;
      rep = prevWord[0] + rep;
    }
    if (taken.some(([a, b]) => offset < b && a < offset + length)) continue;
    taken.push([offset, offset + length]);
    out.push({
      offset,
      length,
      text: text.slice(offset, offset + length),
      category: e.category === 'clarity' ? 'word_choice' : e.category,
      rule: `AI_${e.category.toUpperCase()}`,
      message: e.explanation,
      replacements: [rep],
      confidence: 0.8,
    });
  }
  return out.sort((a, b) => a.offset - b.offset);
}
