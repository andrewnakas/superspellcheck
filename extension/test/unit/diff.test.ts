import { test } from 'node:test';
import assert from 'node:assert/strict';
import { correctionToIssues, diffSentences, sentences } from '../../src/diff.ts';

const valid = (w: string) => !['recieve', 'teh'].includes(w.toLowerCase());
const apply = (s: string, fixes: Array<{ offset: number; length: number; replacements: string[] }>) =>
  [...fixes].sort((a, b) => b.offset - a.offset).reduce((t, f) => t.slice(0, f.offset) + f.replacements[0] + t.slice(f.offset + f.length), s);

test('single word substitution', () => {
  const src = 'He go to school yesterday.';
  const is = correctionToIssues(src, 'He went to school yesterday.', valid);
  assert.equal(is.length, 1);
  assert.equal(is[0].text, 'go');
  assert.deepEqual(is[0].replacements, ['went']);
  assert.equal(is[0].category, 'grammar');
});

test('categories', () => {
  assert.equal(correctionToIssues('I recieve mail.', 'I receive mail.', valid)[0].category, 'spelling');
  assert.equal(correctionToIssues('we met in paris.', 'We met in Paris.', valid).map((i) => i.category).join(), 'capitalization,capitalization');
  const p = correctionToIssues('However we left early.', 'However, we left early.', valid);
  assert.equal(p[0].text, 'However');
  assert.deepEqual(p[0].replacements, ['However,']);
  assert.equal(p[0].category, 'punctuation');
});

test('insertions and deletions round-trip', () => {
  for (const [src, fixed] of [
    ['I went store today.', 'I went to the store today.'],
    ['This is is fine.', 'This is fine.'],
    ['She dont like it', "She doesn't like it."],
    ['😀 he have a dog.', '😀 He has a dog.'],
  ]) {
    const is = correctionToIssues(src, fixed, valid);
    assert.ok(is.length > 0, src);
    assert.equal(apply(src, is), fixed, src);
  }
});

test('rejects rewrites, chatter and no-ops', () => {
  assert.deepEqual(correctionToIssues('The cat sat.', 'The cat sat.', valid), []);
  assert.deepEqual(correctionToIssues('The cat sat on the mat.', 'Sure! Here is the corrected sentence: "The cat sat on the mat."', valid), []);
  assert.deepEqual(correctionToIssues('The results were very good overall.', 'Overall, the outcomes turned out excellent.', valid), []);
});

test('sentence splitting keeps offsets', () => {
  const t = 'Hi there. how are you?  Fine!\nNext line';
  const ss = sentences(t);
  assert.deepEqual(ss.map((s) => s.text), ['Hi there.', 'how are you?', 'Fine!', 'Next line']);
  for (const s of ss) assert.equal(t.slice(s.offset, s.offset + s.text.length), s.text);
});

test('diff handles empty and identical', () => {
  assert.deepEqual(diffSentences('', ''), []);
  assert.deepEqual(diffSentences('a b', 'a b'), []);
});
