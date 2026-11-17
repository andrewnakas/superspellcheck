//! Lexicon + n-gram language model.
//!
//! The lexicon decides what is a valid word (and its required capitalization).
//! The unigram/bigram counts rank candidates and provide sentence context.

use std::collections::HashMap;

#[derive(Debug, Clone, Default)]
pub struct CaseInfo {
    /// The lowercase form is a valid word ("apple").
    pub lower_ok: bool,
    /// Capitalized-only forms ("America", "iPhone", "NASA").
    pub cased: Vec<String>,
}

pub struct LanguageModel {
    ids: HashMap<String, u32>,
    pub words: Vec<String>,
    counts: Vec<f64>,
    /// Word may be offered as a suggestion (it is a real word, not n-gram junk).
    pub suggestible: Vec<bool>,
    pub case: Vec<CaseInfo>,
    bigrams: HashMap<u64, f64>,
    /// Valid regional spellings (British/Canadian) that are accepted but not suggested.
    variants: std::collections::HashSet<String>,
    total: f64,
    floor_count: f64,
}

#[inline]
fn pair_key(a: u32, b: u32) -> u64 {
    ((a as u64) << 32) | b as u64
}

/// Unigram-only words (not in the lexicon) are accepted as valid if they are this frequent.
const UNIGRAM_ONLY_MIN_COUNT: f64 = 2_000_000.0;

pub fn normalize_apostrophes(s: &str) -> String {
    s.replace('\u{2019}', "'").replace('\u{2018}', "'")
}

impl LanguageModel {
    pub fn new(lexicon: &str, unigrams: &str, bigrams: &str) -> Self {
        let mut lm = LanguageModel {
            ids: HashMap::new(),
            words: Vec::new(),
            counts: Vec::new(),
            suggestible: Vec::new(),
            case: Vec::new(),
            bigrams: HashMap::new(),
            variants: Default::default(),
            total: 0.0,
            floor_count: 1.0,
        };
        let mut min_count = f64::MAX;
        for line in unigrams.lines() {
            let mut it = line.split_whitespace();
            let (Some(w), Some(c)) = (it.next(), it.next()) else { continue };
            let Ok(c) = c.parse::<f64>() else { continue };
            let id = lm.intern(&w.to_lowercase());
            lm.counts[id as usize] += c;
            lm.total += c;
            if c < min_count {
                min_count = c;
            }
        }
        lm.floor_count = (min_count / 4.0).max(1.0);
        for raw in lexicon.lines() {
            let w = raw.trim();
            if w.is_empty() {
                continue;
            }
            let w = normalize_apostrophes(w);
            let lower = w.to_lowercase();
            let id = lm.intern(&lower) as usize;
            lm.suggestible[id] = true;
            if w == lower {
                lm.case[id].lower_ok = true;
            } else if !lm.case[id].cased.contains(&w) {
                lm.case[id].cased.push(w.clone());
            }
            if lm.counts[id] == 0.0 {
                lm.counts[id] = lm.floor_count;
            }
        }
        // Frequent unigram-only words are accepted (British spellings, modern words).
        for id in 0..lm.words.len() {
            if !lm.suggestible[id] && lm.counts[id] >= UNIGRAM_ONLY_MIN_COUNT && lm.words[id].chars().all(|c| c.is_alphabetic() || c == '\'') {
                lm.suggestible[id] = true;
                lm.case[id].lower_ok = true;
            }
        }
        for line in bigrams.lines() {
            let mut it = line.split_whitespace();
            let (Some(a), Some(b), Some(c)) = (it.next(), it.next(), it.next()) else { continue };
            let Ok(c) = c.parse::<f64>() else { continue };
            let (Some(&ia), Some(&ib)) = (lm.ids.get(&a.to_lowercase()), lm.ids.get(&b.to_lowercase())) else { continue };
            *lm.bigrams.entry(pair_key(ia, ib)).or_insert(0.0) += c;
        }
        lm
    }

    pub fn add_variants(&mut self, list: &str) {
        for w in list.lines().map(str::trim).filter(|w| !w.is_empty()) {
            self.variants.insert(normalize_apostrophes(w).to_lowercase());
        }
    }

    fn intern(&mut self, w: &str) -> u32 {
        if let Some(&id) = self.ids.get(w) {
            return id;
        }
        let id = self.words.len() as u32;
        self.ids.insert(w.to_string(), id);
        self.words.push(w.to_string());
        self.counts.push(0.0);
        self.suggestible.push(false);
        self.case.push(CaseInfo::default());
        id
    }

    pub fn id(&self, lower: &str) -> Option<u32> {
        self.ids.get(lower).copied()
    }

    pub fn vocab_size(&self) -> usize {
        self.words.len()
    }

    pub fn count(&self, id: u32) -> f64 {
        self.counts[id as usize]
    }

    /// ln P(w)
    pub fn ln_unigram(&self, id: Option<u32>) -> f64 {
        let c = id.map_or(0.0, |i| self.counts[i as usize]).max(self.floor_count);
        (c / self.total).ln()
    }

    pub fn bigram_count(&self, a: u32, b: u32) -> f64 {
        self.bigrams.get(&pair_key(a, b)).copied().unwrap_or(0.0)
    }

    /// ln P(b | a) with stupid backoff to the unigram.
    pub fn ln_cond(&self, a: Option<u32>, b: Option<u32>) -> f64 {
        if let (Some(a), Some(b)) = (a, b) {
            let bc = self.bigram_count(a, b);
            if bc > 0.0 {
                return (bc / self.counts[a as usize].max(bc)).ln();
            }
        }
        (0.4f64).ln() + self.ln_unigram(b)
    }

    /// Context score of putting `w` between `prev` and `next`:
    /// ln P(w | prev) + ln P(next | w). Missing neighbours fall back to unigram.
    pub fn ln_context(&self, prev: Option<u32>, w: Option<u32>, next: Option<u32>, has_prev: bool, has_next: bool) -> f64 {
        let left = if has_prev { self.ln_cond(prev, w) } else { self.ln_unigram(w) };
        let right = if has_next { self.ln_cond(w, next) - self.ln_unigram(next) } else { 0.0 };
        left + right
    }

    /// Is `word` (as typed) a valid spelling? Returns:
    /// - `Valid`
    /// - `WrongCase(correct)` e.g. "america" -> "America"
    /// - `Unknown`
    pub fn classify(&self, word: &str) -> WordStatus {
        let w = normalize_apostrophes(word);
        let lower = w.to_lowercase();
        if self.variants.contains(&lower) || FOREIGN_PARTICLES.contains(&lower.as_str()) {
            return WordStatus::Valid;
        }
        if let Some(id) = self.id(&lower) {
            let ci = &self.case[id as usize];
            if self.suggestible[id as usize] {
                if ci.lower_ok {
                    return WordStatus::Valid;
                }
                if ci.cased.iter().any(|c| *c == w) {
                    return WordStatus::Valid;
                }
                let all_caps = w.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());
                if all_caps {
                    return WordStatus::Valid;
                }
                // Title-case input for a cased lexicon entry like "Mcdonald" vs "McDonald": accept first-letter matches.
                if let Some(c) = ci.cased.iter().find(|c| c.chars().skip(1).any(|x| x.is_lowercase())) {
                    if FOREIGN_PARTICLES.contains(&lower.as_str()) {
                        return WordStatus::Valid; // "de", "von", "la" inside names and phrases
                    }
                    return WordStatus::WrongCase(c.clone());
                }
            }
        }
        // possessives and contractions on known bases: "Smith's", "John's", "dogs'"
        for suf in ["'s", "'"] {
            if let Some(base) = lower.strip_suffix(suf) {
                if base.len() > 1 {
                    if let Some(id) = self.id(base) {
                        if self.suggestible[id as usize] {
                            return WordStatus::Valid;
                        }
                    }
                }
            }
        }
        WordStatus::Unknown
    }
}

const FOREIGN_PARTICLES: &[&str] = &["de", "la", "le", "du", "von", "van", "der", "da", "di", "del", "al", "el", "des", "den", "les", "los", "las"];

#[derive(Debug, Clone, PartialEq)]
pub enum WordStatus {
    Valid,
    WrongCase(String),
    Unknown,
}
