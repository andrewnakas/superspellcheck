import { test } from 'node:test';
import assert from 'node:assert/strict';
import { locate, minimize } from '../src/locate.ts';

const e = (original: string, replacement: string, before = '', category: any = 'grammar') => ({ original, replacement, before, category, explanation: 'x' });

test('minimize trims unchanged words', () => {
  assert.deepEqual(minimize('He go to school', 'He goes to school'), { start: 3, orig: 'go', rep: 'goes' });
});

test('locates and minimizes an edit', () => {
  const text = 'Yesterday he go to school.';
  const [i] = locate(text, [e('he go to', 'he went to')]);
  assert.equal(text.slice(i.offset, i.offset + i.length), 'go');
  assert.deepEqual(i.replacements, ['went']);
});

test('uses context to pick the right occurrence', () => {
  const text = 'I like it. Their going home. I like their dog.';
  const [i] = locate(text, [e('Their', "They're", 'I like it. ')]);
  assert.equal(i.offset, text.indexOf('Their'));
  const [j] = locate('the cat and the cat sat', [e('the cat sat', 'the cats sat', 'and ')]);
  assert.equal(j.offset, 16);
});

test('drops hallucinated, huge or no-op edits', () => {
  const text = 'This is fine.';
  assert.deepEqual(locate(text, [e('not here', 'x'), e('This is fine.', 'This is fine.')]), []);
  const long = 'one two three four five six seven eight nine ten eleven twelve thirteen';
  assert.deepEqual(locate(long, [e(long, 'short')]), []);
});

test('pure insertions attach to the previous word', () => {
  const text = 'However we left.';
  const [i] = locate(text, [e('However we', 'However, we', '', 'punctuation')]);
  assert.equal(i.text, 'However');
  assert.deepEqual(i.replacements, ['However,']);
});

test('UTF-16 offsets with emoji', () => {
  const text = '😀 I has a dog.';
  const [i] = locate(text, [e('I has', 'I have')]);
  assert.equal(text.slice(i.offset, i.offset + i.length), 'has');
});
