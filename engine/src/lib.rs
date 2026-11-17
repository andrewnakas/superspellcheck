//! SuperSpellCheck engine.
//!
//! Tier 1 (spelling) + Tier 2 rule-based grammar, designed to run on-device
//! (native or WASM) with no network access.

pub mod confusion;
pub mod errmodel;
pub mod lm;
pub mod rules;
pub mod symspell;
pub mod tokenize;
#[cfg(feature = "wasm")]
pub mod wasm;

use lm::{normalize_apostrophes, LanguageModel, WordStatus};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use symspell::{osa_distance, SymSpell};
use tokenize::{tokenize, TokKind, Token};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Category {
    Spelling,
    Grammar,
    Punctuation,
    Capitalization,
    WordChoice,
}

/// Issue with byte offsets, produced internally.
#[derive(Debug, Clone)]
pub struct RawIssue {
    pub start: usize,
    pub end: usize,
    pub replacements: Vec<String>,
    pub category: Category,
    pub rule: &'static str,
    pub message: String,
    pub confidence: f32,
}

/// Public issue. Offsets are UTF-16 code units so they map directly onto JS strings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub offset: usize,
    pub length: usize,
    pub text: String,
    pub category: Category,
    pub rule: String,
    pub message: String,
    pub replacements: Vec<String>,
    pub confidence: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct CheckOptions {
    /// Hide issues below this confidence. Low-noise by default.
    pub min_confidence: f32,
    pub disabled_rules: Vec<String>,
    pub max_suggestions: usize,
}

impl Default for CheckOptions {
    fn default() -> Self {
        CheckOptions { min_confidence: 0.5, disabled_rules: Vec::new(), max_suggestions: 5 }
    }
}

/// Tunable weights of the noisy-channel model.
#[derive(Debug, Clone, Copy)]
pub struct Weights {
    /// Penalty per unit of weighted edit distance (nats).
    pub alpha: f64,
    /// Weight of the language-model context score.
    pub beta: f64,
}

impl Default for Weights {
    fn default() -> Self {
        Weights { alpha: 6.0, beta: 1.0 }
    }
}

pub struct Engine {
    lm: LanguageModel,
    index: SymSpell,
    user_words: HashSet<String>,
    pub weights: Weights,
}

#[derive(Debug, Clone)]
pub struct Suggestion {
    pub word: String,
    pub score: f64,
    pub cost: f32,
}

/// Context around a word: neighbouring words in the same clause.
#[derive(Debug, Clone, Copy, Default)]
pub struct Ctx<'a> {
    pub prev: Option<&'a str>,
    pub next: Option<&'a str>,
}

impl Engine {
    pub fn new(lexicon: &str, unigrams: &str, bigrams: &str) -> Self {
        let lm = LanguageModel::new(lexicon, unigrams, bigrams);
        let index = SymSpell::build((0..lm.vocab_size() as u32).filter(|&i| lm.suggestible[i as usize]).map(|i| (i, lm.words[i as usize].as_str())));
        Engine { lm, index, user_words: HashSet::new(), weights: Weights::default() }
    }

    /// Load from the repository's `data/` directory.
    pub fn from_dir(dir: &std::path::Path) -> std::io::Result<Self> {
        let r = |f: &str| std::fs::read_to_string(dir.join(f));
        Ok(Self::new(&r("lexicon.txt")?, &r("unigrams.txt")?, &r("bigrams.txt")?))
    }

    pub fn add_word(&mut self, w: &str) {
        self.user_words.insert(normalize_apostrophes(w).to_lowercase());
    }

    pub fn remove_word(&mut self, w: &str) {
        self.user_words.remove(&normalize_apostrophes(w).to_lowercase());
    }

    pub fn index_size(&self) -> usize {
        self.index.len()
    }

    pub fn is_valid(&self, word: &str) -> bool {
        self.user_words.contains(&normalize_apostrophes(word).to_lowercase()) || self.lm.classify(word) == WordStatus::Valid
    }

    fn ctx_ids(&self, ctx: Ctx) -> (Option<u32>, Option<u32>) {
        (ctx.prev.and_then(|p| self.lm.id(&normalize_apostrophes(&p.to_lowercase()))), ctx.next.and_then(|n| self.lm.id(&normalize_apostrophes(&n.to_lowercase()))))
    }

    /// LM score of a (possibly multi-word) replacement in context.
    fn seq_score(&self, seq: &[&str], ctx: Ctx) -> f64 {
        let (pid, nid) = self.ctx_ids(ctx);
        let ids: Vec<Option<u32>> = seq.iter().map(|w| self.lm.id(w)).collect();
        let mut s = if ctx.prev.is_some() { self.lm.ln_cond(pid, ids[0]) } else { self.lm.ln_unigram(ids[0]) };
        for k in 1..ids.len() {
            s += self.lm.ln_cond(ids[k - 1], ids[k]);
        }
        if ctx.next.is_some() {
            s += self.lm.ln_cond(*ids.last().unwrap(), nid) - self.lm.ln_unigram(nid);
        }
        s
    }

    /// Ranked corrections for a misspelled word (lowercase output, no case restoration).
    pub fn suggest(&self, word: &str, ctx: Ctx, limit: usize) -> Vec<Suggestion> {
        let lower = normalize_apostrophes(&word.to_lowercase());
        let chars: Vec<char> = lower.chars().collect();
        let max_d = if chars.len() >= 9 { 3 } else { 2 };
        let mut seen: HashMap<u32, ()> = HashMap::new();
        let mut out: Vec<Suggestion> = Vec::new();
        let w = self.weights;
        for id in self.index.candidates(&lower) {
            if seen.insert(id, ()).is_some() {
                continue;
            }
            let cand = &self.lm.words[id as usize];
            if *cand == lower {
                continue;
            }
            let cc: Vec<char> = cand.chars().collect();
            if osa_distance(&chars, &cc, max_d) > max_d {
                continue;
            }
            let cost = errmodel::weighted_distance(&lower, cand);
            let score = -w.alpha * cost as f64 + w.beta * self.seq_score(&[cand.as_str()], ctx);
            out.push(Suggestion { word: cand.clone(), score, cost });
        }
        // Run-on words: "alot" -> "a lot", "infront" -> "in front"
        if chars.len() >= 4 {
            for k in 1..chars.len() {
                let a: String = chars[..k].iter().collect();
                let b: String = chars[k..].iter().collect();
                let ok = |s: &str| {
                    (s.chars().count() > 1 || s == "a" || s == "i") && self.lm.id(s).map_or(false, |id| self.lm.suggestible[id as usize] && self.lm.case[id as usize].lower_ok && self.lm.count(id) > 1e6)
                };
                if ok(&a) && ok(&b) {
                    let (ia, ib) = (self.lm.id(&a).unwrap(), self.lm.id(&b).unwrap());
                    if self.lm.bigram_count(ia, ib) <= 0.0 {
                        continue;
                    }
                    let cost = 0.45f32;
                    let score = -w.alpha * cost as f64 + w.beta * self.seq_score(&[a.as_str(), b.as_str()], ctx);
                    out.push(Suggestion { word: format!("{} {}", a, b), score, cost });
                }
            }
        }
        out.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap());
        out.truncate(limit.max(1) * 2);
        out
    }

    pub fn check(&self, text: &str) -> Vec<Issue> {
        self.check_with(text, &CheckOptions::default())
    }

    pub fn check_json(&self, text: &str, opts_json: &str) -> String {
        let opts: CheckOptions = serde_json::from_str(opts_json).unwrap_or_default();
        serde_json::to_string(&self.check_with(text, &opts)).unwrap()
    }

    pub fn check_with(&self, text: &str, opts: &CheckOptions) -> Vec<Issue> {
        let toks = tokenize(text);
        let mut raw: Vec<RawIssue> = Vec::new();
        self.spell_pass(&toks, opts, &mut raw);
        self.confusion_pass(&toks, &mut raw);
        raw.extend(rules::run(text, &toks));

        // Resolve overlaps: earlier passes (spelling) win, then higher confidence.
        let mut accepted: Vec<RawIssue> = Vec::new();
        for r in raw {
            if r.confidence < opts.min_confidence || opts.disabled_rules.iter().any(|d| d == r.rule) {
                continue;
            }
            if accepted.iter().any(|a| r.start < a.end && a.start < r.end) {
                continue;
            }
            accepted.push(r);
        }
        accepted.sort_by_key(|r| r.start);
        let u16_at = utf16_index(text);
        accepted
            .into_iter()
            .map(|r| Issue {
                offset: u16_at[r.start],
                length: u16_at[r.end] - u16_at[r.start],
                text: text[r.start..r.end].to_string(),
                category: r.category,
                rule: r.rule.to_string(),
                message: r.message,
                replacements: r.replacements.into_iter().take(opts.max_suggestions.max(1)).collect(),
                confidence: (r.confidence * 100.0).round() / 100.0,
            })
            .collect()
    }

    /// Words with their clause context (neighbours not separated by punctuation).
    fn word_contexts<'a>(toks: &'a [Token<'a>]) -> Vec<(usize, Ctx<'a>)> {
        let mut out = Vec::new();
        let widx: Vec<usize> = toks.iter().enumerate().filter(|(_, t)| t.kind == TokKind::Word).map(|(i, _)| i).collect();
        let clean = |a: usize, b: usize| toks[a + 1..b].iter().all(|t| t.kind == TokKind::Space && !t.text.contains("\n\n"));
        for (k, &ti) in widx.iter().enumerate() {
            let prev = if k > 0 && clean(widx[k - 1], ti) { Some(toks[widx[k - 1]].text) } else { None };
            let next = if k + 1 < widx.len() && clean(ti, widx[k + 1]) { Some(toks[widx[k + 1]].text) } else { None };
            out.push((ti, Ctx { prev, next }));
        }
        out
    }

    fn spell_pass(&self, toks: &[Token], opts: &CheckOptions, out: &mut Vec<RawIssue>) {
        for (ti, ctx) in Self::word_contexts(toks) {
            let t = &toks[ti];
            let word = t.text;
            if self.user_words.contains(&normalize_apostrophes(&word.to_lowercase())) {
                continue;
            }
            let letters = word.chars().filter(|c| c.is_alphabetic()).count();
            let all_caps = word.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());
            if letters <= 1 || !word.chars().all(|c| c.is_ascii_alphabetic() || c == '\'' || c == '\u{2019}' || c == '.') {
                continue; // non-English letters: likely a foreign word or name
            }
            if word.contains('.') {
                continue; // dotted abbreviation
            }
            match self.lm.classify(word) {
                WordStatus::Valid => {}
                WordStatus::WrongCase(correct) => {
                    out.push(RawIssue {
                        start: t.start,
                        end: t.end,
                        replacements: vec![correct.clone()],
                        category: Category::Capitalization,
                        rule: "PROPER_NOUN_CAPITAL",
                        message: format!("\u{201C}{}\u{201D} should be capitalized.", correct),
                        confidence: 0.85,
                    });
                }
                WordStatus::Unknown => {
                    if all_caps && letters <= 6 {
                        continue; // acronym
                    }
                    let capitalized = word.chars().next().map_or(false, |c| c.is_uppercase()) && !all_caps;
                    let maybe_name = capitalized && !t.sentence_start;
                    let sugg = self.suggest(word, ctx, opts.max_suggestions);
                    let probs = softmax(&sugg.iter().map(|s| s.score).collect::<Vec<_>>());
                    let top_p = probs.first().copied().unwrap_or(0.0);
                    let best_cost = sugg.first().map_or(9.0, |s| s.cost);
                    let confidence: f32 = if maybe_name {
                        // Names are the #1 source of false alarms. Only flag obvious typos.
                        if best_cost <= 0.6 && top_p > 0.6 { 0.6 } else { 0.3 }
                    } else {
                        0.95
                    };
                    let replacements: Vec<String> = sugg
                        .iter()
                        .take(opts.max_suggestions)
                        .map(|s| restore_case(word, &self.cased_form(&s.word), t.sentence_start))
                        .collect();
                    out.push(RawIssue {
                        start: t.start,
                        end: t.end,
                        replacements,
                        category: Category::Spelling,
                        rule: "SPELLING",
                        message: if sugg.is_empty() { format!("\u{201C}{}\u{201D} isn't in the dictionary.", word) } else { "Possible spelling mistake.".to_string() },
                        confidence,
                    });
                }
            }
        }
    }

    /// If a lexicon word is only valid capitalized, return that form.
    fn cased_form(&self, lower: &str) -> String {
        lower
            .split(' ')
            .map(|w| match self.lm.id(w) {
                Some(id) if !self.lm.case[id as usize].lower_ok && !self.lm.case[id as usize].cased.is_empty() => self.lm.case[id as usize].cased[0].clone(),
                _ => w.to_string(),
            })
            .collect::<Vec<_>>()
            .join(" ")
    }

    fn confusion_pass(&self, toks: &[Token], out: &mut Vec<RawIssue>) {
        for (ti, ctx) in Self::word_contexts(toks) {
            if ctx.prev.is_none() && ctx.next.is_none() {
                continue;
            }
            let t = &toks[ti];
            let lower = normalize_apostrophes(&t.text.to_lowercase());
            let alts = confusion::alternatives(&lower);
            if alts.is_empty() {
                continue;
            }
            let orig = self.seq_score(&[lower.as_str()], ctx);
            let mut best: Option<(&str, f64)> = None;
            for alt in alts {
                let seq: Vec<&str> = alt.split(' ').collect();
                // Need positive evidence: the alternative must be attested next to a neighbour.
                let ids: Vec<Option<u32>> = seq.iter().map(|w| self.lm.id(w)).collect();
                if ids.iter().any(|i| i.is_none()) {
                    continue;
                }
                let (pid, nid) = self.ctx_ids(ctx);
                let attested_left = pid.map_or(false, |p| self.lm.bigram_count(p, ids[0].unwrap()) > 0.0);
                let attested_right = nid.map_or(false, |n| self.lm.bigram_count(ids.last().unwrap().unwrap(), n) > 0.0);
                if !attested_left && !attested_right {
                    continue;
                }
                let gain = self.seq_score(&seq, ctx) - orig - confusion::switch_penalty(&lower, alt);
                if gain > 0.0 && best.map_or(true, |b| gain > b.1) {
                    best = Some((alt, gain));
                }
            }
            if let Some((alt, gain)) = best {
                let confidence = (0.5 + 0.5 * (1.0 - (-gain / 2.0).exp())) as f32;
                let rep = restore_case(t.text, alt, false);
                out.push(RawIssue {
                    start: t.start,
                    end: t.end,
                    replacements: vec![rep.clone()],
                    category: Category::WordChoice,
                    rule: "CONFUSED_WORD",
                    message: format!("\u{201C}{}\u{201D} may be the wrong word here. Did you mean \u{201C}{}\u{201D}?", t.text, rep),
                    confidence,
                });
            }
        }
    }
}

fn softmax(scores: &[f64]) -> Vec<f64> {
    if scores.is_empty() {
        return vec![];
    }
    let m = scores.iter().cloned().fold(f64::MIN, f64::max);
    let e: Vec<f64> = scores.iter().map(|s| (s - m).exp()).collect();
    let z: f64 = e.iter().sum();
    e.into_iter().map(|x| x / z).collect()
}

/// Apply the capitalization pattern of `typed` to `suggestion`.
pub fn restore_case(typed: &str, suggestion: &str, sentence_start: bool) -> String {
    let alpha: Vec<char> = typed.chars().filter(|c| c.is_alphabetic()).collect();
    let all_caps = alpha.len() > 1 && alpha.iter().all(|c| c.is_uppercase());
    if all_caps {
        return suggestion.to_uppercase();
    }
    if typed.chars().next().map_or(false, |c| c.is_uppercase()) || sentence_start {
        return rules::capitalize(suggestion);
    }
    suggestion.to_string()
}

/// Map from byte offset to UTF-16 offset (length text.len()+1).
fn utf16_index(text: &str) -> Vec<usize> {
    let mut v = vec![0usize; text.len() + 1];
    let mut u = 0;
    for (b, c) in text.char_indices() {
        for k in 0..c.len_utf8() {
            v[b + k] = u;
        }
        u += c.len_utf16();
    }
    v[text.len()] = u;
    v
}
