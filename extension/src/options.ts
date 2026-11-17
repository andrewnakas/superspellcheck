import { getDictionary, getSettings, saveSettings, setDictionary } from './storage';

const RULES: Array<[string, string]> = [
  ['SPELLING', 'Spelling'],
  ['CONFUSED_WORD', 'Commonly confused words (form/from, lose/loose)'],
  ['A_VS_AN', 'A vs. an'],
  ['REPEATED_WORD', 'Repeated words'],
  ['PRONOUN_AGREEMENT', 'Subject–verb agreement'],
  ['MODAL_OF', '"Could of" → "could have"'],
  ['THEN_THAN', 'Then vs. than'],
  ['YOUR_YOURE', 'Your vs. you’re'],
  ['ITS_ITS', 'Its vs. it’s'],
  ['SENTENCE_START_CAPITAL', 'Capitalize sentence starts'],
  ['PROPER_NOUN_CAPITAL', 'Capitalize proper nouns'],
  ['SPACE_BEFORE_PUNCT', 'Space before punctuation'],
  ['MISSING_SPACE_AFTER_PUNCT', 'Missing space after punctuation'],
];
const LEVELS = [0.75, 0.5, 0.25];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function chip(text: string, onRemove: () => void): HTMLLIElement {
  const li = document.createElement('li');
  li.append(text);
  const b = document.createElement('button');
  b.textContent = '×';
  b.setAttribute('aria-label', `Remove ${text}`);
  b.addEventListener('click', onRemove);
  li.append(b);
  return li;
}

async function render() {
  const s = await getSettings();
  $<HTMLInputElement>('enabled').checked = s.enabled;
  $<HTMLInputElement>('native').checked = s.replaceNativeSpellcheck;
  const lvl = LEVELS.reduce((best, v, i) => (Math.abs(v - s.minConfidence) < Math.abs(LEVELS[best] - s.minConfidence) ? i : best), 0);
  $<HTMLInputElement>('sensitivity').value = String(lvl);

  const rules = $('rules');
  rules.replaceChildren(
    ...RULES.map(([id, label]) => {
      const l = document.createElement('label');
      l.className = 'row';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !s.disabledRules.includes(id);
      cb.addEventListener('change', async () => {
        const cur = await getSettings();
        const set = new Set(cur.disabledRules);
        if (cb.checked) set.delete(id);
        else set.add(id);
        await saveSettings({ disabledRules: [...set] });
      });
      l.append(cb, label);
      return l;
    }),
  );

  const dict = await getDictionary();
  $('dict').replaceChildren(...dict.map((w) => chip(w, async () => { await setDictionary(dict.filter((x) => x !== w)); render(); })));
  $('sites').replaceChildren(...s.disabledSites.map((h) => chip(h, async () => { await saveSettings({ disabledSites: s.disabledSites.filter((x) => x !== h) }); render(); })));
}

$<HTMLInputElement>('enabled').addEventListener('change', (e) => saveSettings({ enabled: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>('native').addEventListener('change', (e) => saveSettings({ replaceNativeSpellcheck: (e.target as HTMLInputElement).checked }));
$<HTMLInputElement>('sensitivity').addEventListener('change', (e) => saveSettings({ minConfidence: LEVELS[Number((e.target as HTMLInputElement).value)] }));
$<HTMLFormElement>('addform').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>('newword');
  if (input.value.trim()) {
    await setDictionary([...(await getDictionary()), input.value.trim()]);
    input.value = '';
    render();
  }
});

render();
