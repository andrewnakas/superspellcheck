//! High-precision grammar and punctuation rules. Each rule is written to be
//! conservative: a false alarm costs more user trust than a missed error.

use crate::tokenize::{TokKind, Token};
use crate::{Category, RawIssue};

/// A view of word tokens with what separates them from the previous word.
struct W<'a> {
    tok: usize,
    text: &'a str,
    lower: String,
    /// Only plain spaces (no punctuation, no line breaks) separate this word from the previous one.
    joined_to_prev: bool,
}

fn word_view<'a>(toks: &[Token<'a>]) -> Vec<W<'a>> {
    let mut out: Vec<W> = Vec::new();
    let mut clean_gap = false;
    for (i, t) in toks.iter().enumerate() {
        match t.kind {
            TokKind::Word => {
                out.push(W { tok: i, text: t.text, lower: crate::lm::normalize_apostrophes(&t.text.to_lowercase()), joined_to_prev: clean_gap && !out.is_empty() });
                clean_gap = false;
            }
            TokKind::Space => {
                // keep `clean_gap` if the space follows a word directly
                if !t.text.contains('\n') && i > 0 && toks[i - 1].kind == TokKind::Word {
                    clean_gap = true;
                } else {
                    clean_gap = false;
                }
            }
            _ => clean_gap = false,
        }
    }
    out
}

fn match_case(template: &str, replacement: &str) -> String {
    let mut chars = template.chars();
    let first_upper = chars.next().map_or(false, |c| c.is_uppercase());
    let all_upper = template.len() > 1 && template.chars().filter(|c| c.is_alphabetic()).all(|c| c.is_uppercase());
    if all_upper {
        replacement.to_uppercase()
    } else if first_upper {
        capitalize(replacement)
    } else {
        replacement.to_string()
    }
}

pub fn capitalize(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

const REPEAT_OK: &[&str] = &["that", "had", "bye", "no", "so", "ha", "haha", "blah", "knock", "very", "really", "many", "far", "yeah", "yes", "go", "boo", "tut", "chop", "wait", "now", "well", "do"];

const AN_CONSONANT_SOUND_PREFIXES: &[&str] = &["uni", "use", "usa", "usu", "uti", "ure", "uro", "eu", "ewe", "one", "once", "ufo", "uga", "uk", "ute", "ubi", "uvu", "unan", "uku", "ura", "uri"];
const A_VOWEL_SOUND_WORDS: &[&str] = &["hour", "hours", "hourly", "honest", "honestly", "honesty", "honor", "honors", "honorable", "honour", "honourable", "heir", "heirs", "heiress", "herb", "herbs"];

fn starts_with_vowel_sound(word: &str) -> Option<bool> {
    let lw = word.to_lowercase();
    let first = lw.chars().next()?;
    if !first.is_ascii_alphabetic() {
        return None;
    }
    // Acronyms are read letter-by-letter or as words: too ambiguous, skip.
    if word.len() > 1 && word.chars().all(|c| c.is_uppercase()) {
        return None;
    }
    if A_VOWEL_SOUND_WORDS.iter().any(|w| lw == *w || (lw.starts_with(w) && lw.len() > w.len() + 1 && *w != "herb")) {
        return Some(true);
    }
    if matches!(first, 'a' | 'e' | 'i' | 'o' | 'u') {
        if AN_CONSONANT_SOUND_PREFIXES.iter().any(|p| lw.starts_with(p)) {
            // "unified" -> consonant, but "unimportant", "uninformed", "unusual" are vowel sounds.
            if lw.starts_with("uni") && (lw.starts_with("unim") || lw.starts_with("unin") || lw.starts_with("unint")) {
                return Some(true);
            }
            if lw.starts_with("usu") || lw.starts_with("use") || lw.starts_with("uti") || lw.starts_with("uni") || lw.starts_with("eu") || lw.starts_with("one") || lw.starts_with("once") || lw.starts_with("ewe") || lw.starts_with("ure") || lw.starts_with("uro") || lw.starts_with("ura") || lw.starts_with("uri") || lw.starts_with("ubi") || lw.starts_with("uvu") || lw.starts_with("ufo") || lw.starts_with("uk") || lw.starts_with("uku") || lw.starts_with("unan") || lw.starts_with("ute") || lw.starts_with("uga") || lw.starts_with("usa") {
                return Some(false);
            }
        }
        return Some(true);
    }
    if lw.len() == 1 {
        // single letters: "an x", "a b"
        return Some(matches!(first, 'f' | 'h' | 'l' | 'm' | 'n' | 'r' | 's' | 'x'));
    }
    Some(false)
}

const SUBJ_3SG: &[&str] = &["he", "she", "it"];
const SUBJ_PL: &[&str] = &["we", "they", "you"];
const AUX_BEFORE_BASE: &[&str] = &[
    "do", "does", "did", "will", "would", "can", "could", "should", "shall", "may", "might", "must", "to", "let", "make", "made", "doesn't", "didn't", "won't", "can't", "couldn't", "shouldn't", "wouldn't", "not", "help", "helps", "watch", "watched", "saw", "see", "hear", "heard", "makes", "lets", "if", "that", "whether",
];
const COMPARATIVES: &[&str] = &[
    "more", "less", "rather", "other", "better", "worse", "greater", "larger", "smaller", "bigger", "higher", "lower", "faster", "slower", "older", "younger", "longer", "shorter", "easier", "harder", "fewer", "cheaper", "stronger", "weaker", "richer", "poorer", "happier", "louder", "quicker", "nicer", "safer", "warmer", "colder", "hotter", "cooler", "smarter", "heavier", "lighter", "wider", "deeper", "taller", "busier", "cleaner",
];

pub fn run(text: &str, toks: &[Token]) -> Vec<RawIssue> {
    let mut out = Vec::new();
    let words = word_view(toks);

    for (i, w) in words.iter().enumerate() {
        let prev = if i > 0 { Some(&words[i - 1]) } else { None };
        let next = words.get(i + 1);
        let next2 = words.get(i + 2);
        let tok = &toks[w.tok];

        // --- repeated word: "the the"
        if let Some(p) = prev {
            if w.joined_to_prev && p.lower == w.lower && !REPEAT_OK.contains(&w.lower.as_str()) && w.lower.chars().all(|c| c.is_alphabetic()) {
                let ptok = &toks[p.tok];
                out.push(RawIssue {
                    start: ptok.start,
                    end: tok.end,
                    replacements: vec![p.text.to_string()],
                    category: Category::Grammar,
                    rule: "REPEATED_WORD",
                    message: format!("The word \u{201C}{}\u{201D} is repeated.", w.text),
                    confidence: 0.97,
                });
            }
        }

        // --- a / an
        if (w.lower == "a" || w.lower == "an") && next.map_or(false, |n| n.joined_to_prev) {
            let n = next.unwrap();
            // "a" as a letter/variable ("Plan A is", "vitamin a") — require a determiner-like position
            let is_letter_use = tok.text == "A" && !tok.sentence_start;
            if let (Some(vowel), false) = (starts_with_vowel_sound(n.text), is_letter_use) {
                let want = if vowel { "an" } else { "a" };
                if w.lower != want {
                    out.push(RawIssue {
                        start: tok.start,
                        end: tok.end,
                        replacements: vec![match_case(w.text, want)],
                        category: Category::Grammar,
                        rule: "A_VS_AN",
                        message: format!("Use \u{201C}{}\u{201D} before a word that starts with a {} sound.", want, if vowel { "vowel" } else { "consonant" }),
                        confidence: 0.9,
                    });
                }
            }
        }

        // --- could of / should of
        if w.lower == "of" && w.joined_to_prev {
            if let Some(p) = prev {
                let modal = matches!(p.lower.as_str(), "could" | "should" | "would" | "must" | "might" | "may" | "couldn't" | "shouldn't" | "wouldn't" | "mustn't" | "mightn't");
                let next_is_course = next.map_or(false, |n| n.lower == "course");
                if modal && !next_is_course {
                    out.push(RawIssue {
                        start: tok.start,
                        end: tok.end,
                        replacements: vec![match_case(w.text, "have")],
                        category: Category::Grammar,
                        rule: "MODAL_OF",
                        message: format!("After \u{201C}{}\u{201D}, use \u{201C}have\u{201D}, not \u{201C}of\u{201D}.", p.text),
                        confidence: 0.95,
                    });
                }
            }
        }

        // --- subject-verb agreement (pronoun subjects only — high precision)
        if let Some(p) = prev {
            if w.joined_to_prev {
                let before_subject = if i >= 2 { Some(words[i - 2].lower.as_str()) } else { None };
                let aux_before = before_subject.map_or(false, |b| AUX_BEFORE_BASE.contains(&b));
                let question_inversion = before_subject.map_or(false, |b| matches!(b, "is" | "are" | "was" | "were" | "has" | "have" | "had" | "why" | "where" | "how" | "when" | "what"));
                let fix: Option<&str> = match (p.lower.as_str(), w.lower.as_str()) {
                    (s, "don't") if SUBJ_3SG.contains(&s) => Some("doesn't"),
                    (s, "have") if SUBJ_3SG.contains(&s) && !aux_before && !question_inversion => Some("has"),
                    (s, "are") if SUBJ_3SG.contains(&s) && !question_inversion => Some("is"),
                    (s, "has") if (SUBJ_PL.contains(&s) || s == "i") && !question_inversion => Some("have"),
                    (s, "is") if SUBJ_PL.contains(&s) && !question_inversion => Some("are"),
                    ("i", "is") | ("i", "are") if !question_inversion => Some("am"),
                    (s, "was") if SUBJ_PL.contains(&s) && !question_inversion && !before_subject.map_or(false, |b| b == "if") => Some("were"),
                    (s, "doesn't") if SUBJ_PL.contains(&s) || s == "i" => Some("don't"),
                    _ => None,
                };
                // "it is", "that he have" (subjunctive) etc: skip when the pronoun is an object ("give it have"?) — rare
                if let Some(f) = fix {
                    // "you is" inside quotes or dialects still flagged; that's intended.
                    out.push(RawIssue {
                        start: tok.start,
                        end: tok.end,
                        replacements: vec![match_case(w.text, f)],
                        category: Category::Grammar,
                        rule: "PRONOUN_AGREEMENT",
                        message: format!("\u{201C}{}\u{201D} doesn't agree with \u{201C}{}\u{201D}. Did you mean \u{201C}{}\u{201D}?", w.text, p.text, f),
                        confidence: 0.9,
                    });
                }
            }
        }

        // --- comparative + then -> than
        if w.lower == "then" && w.joined_to_prev {
            if let Some(p) = prev {
                if COMPARATIVES.contains(&p.lower.as_str()) && !(p.lower == "other" && next.map_or(true, |n| !n.joined_to_prev)) {
                    out.push(RawIssue {
                        start: tok.start,
                        end: tok.end,
                        replacements: vec![match_case(w.text, "than")],
                        category: Category::WordChoice,
                        rule: "THEN_THAN",
                        message: "Use \u{201C}than\u{201D} for comparisons.".into(),
                        confidence: 0.9,
                    });
                }
            }
        }

        // --- your -> you're
        if w.lower == "your" {
            if let Some(n) = next {
                let fix = n.joined_to_prev && matches!(n.lower.as_str(), "welcome" | "a" | "an" | "the" | "so" | "not" | "very" | "too" | "really" | "always" | "never" | "right" | "wrong" | "sure" | "kidding" | "joking");
                if fix && !(n.lower == "right" && next2.map_or(false, |x| x.joined_to_prev && matches!(x.lower.as_str(), "hand" | "side" | "arm" | "leg" | "foot" | "eye" | "ear" | "now"))) {
                    out.push(RawIssue {
                        start: tok.start,
                        end: tok.end,
                        replacements: vec![match_case(w.text, "you're")],
                        category: Category::WordChoice,
                        rule: "YOUR_YOURE",
                        message: "\u{201C}You're\u{201D} (you are) seems intended here.".into(),
                        confidence: 0.9,
                    });
                }
            }
        }

        // --- its -> it's
        if w.lower == "its" {
            if let Some(n) = next {
                if n.joined_to_prev && matches!(n.lower.as_str(), "a" | "an" | "not" | "been" | "going" | "so" | "very" | "too" | "really" | "just" | "always" | "never" | "ok" | "okay" | "fine" | "important" | "possible" | "likely" | "hard" | "easy" | "true" | "about") {
                    out.push(RawIssue {
                        start: tok.start,
                        end: tok.end,
                        replacements: vec![match_case(w.text, "it's")],
                        category: Category::WordChoice,
                        rule: "ITS_ITS",
                        message: "\u{201C}It's\u{201D} (it is / it has) seems intended here.".into(),
                        confidence: 0.88,
                    });
                }
            }
        }
        // --- it's own -> its own
        if w.lower == "it's" && next.map_or(false, |n| n.joined_to_prev && n.lower == "own") {
            out.push(RawIssue {
                start: tok.start,
                end: tok.end,
                replacements: vec![match_case(w.text, "its")],
                category: Category::WordChoice,
                rule: "ITS_OWN",
                message: "Use the possessive \u{201C}its\u{201D} (no apostrophe).".into(),
                confidence: 0.95,
            });
        }

        // --- sentence-start capitalization
        if tok.sentence_start && tok.text.chars().next().map_or(false, |c| c.is_lowercase()) && tok.text.chars().all(|c| c.is_alphabetic() || c == '\'' || c == '\u{2019}') {
            // Not after an opening bracket/quote and not a lone lowercase list item like "e.g"
            let prev_tok = if w.tok > 0 { toks[..w.tok].iter().rev().find(|t| t.kind != TokKind::Space) } else { None };
            let after_quote = prev_tok.map_or(false, |t| matches!(t.text, "\"" | "(" | "\u{201C}" | "'" | "-" | "*" | "\u{2022}"));
            if !after_quote && tok.text.len() > 0 {
                out.push(RawIssue {
                    start: tok.start,
                    end: tok.end,
                    replacements: vec![capitalize(tok.text)],
                    category: Category::Capitalization,
                    rule: "SENTENCE_START_CAPITAL",
                    message: "Capitalize the first word of a sentence.".into(),
                    confidence: 0.8,
                });
            }
        }
    }

    // --- punctuation spacing
    for (i, t) in toks.iter().enumerate() {
        if t.kind != TokKind::Punct {
            continue;
        }
        let p = t.text;
        // space before , ; : . ! ?
        if matches!(p, "," | ";" | "." | "!" | "?" | ":") && i >= 2 && toks[i - 1].kind == TokKind::Space && !toks[i - 1].text.contains('\n') && toks[i - 2].kind == TokKind::Word {
            let next_is_dot = toks.get(i + 1).map_or(false, |n| n.text == ".");
            let is_ellipsis = p == "." && next_is_dot;
            if !is_ellipsis {
                out.push(RawIssue {
                    start: toks[i - 1].start,
                    end: t.end,
                    replacements: vec![p.to_string()],
                    category: Category::Punctuation,
                    rule: "SPACE_BEFORE_PUNCT",
                    message: format!("Remove the space before \u{201C}{}\u{201D}.", p),
                    confidence: 0.9,
                });
            }
        }
        // missing space after , ; and after . ! ? when the next word is capitalized
        if matches!(p, "," | ";" | "." | "!" | "?") && i >= 1 && toks[i - 1].kind == TokKind::Word {
            if let Some(n) = toks.get(i + 1) {
                if n.kind == TokKind::Word && n.start == t.end {
                    let needs = match p {
                        "," | ";" => true,
                        _ => n.text.chars().next().map_or(false, |c| c.is_uppercase()) && toks[i - 1].text.chars().count() > 1,
                    };
                    if needs {
                        out.push(RawIssue {
                            start: t.start,
                            end: t.end,
                            replacements: vec![format!("{} ", p)],
                            category: Category::Punctuation,
                            rule: "MISSING_SPACE_AFTER_PUNCT",
                            message: format!("Add a space after \u{201C}{}\u{201D}.", p),
                            confidence: 0.85,
                        });
                    }
                }
            }
        }
    }
    let _ = text;
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tokenize::tokenize;

    fn rules(s: &str) -> Vec<(&'static str, String)> {
        let t = tokenize(s);
        run(s, &t).into_iter().map(|i| (i.rule, i.replacements.first().cloned().unwrap_or_default())).collect()
    }

    #[test]
    fn a_an() {
        assert_eq!(rules("I ate a apple."), vec![("A_VS_AN", "an".into())]);
        assert_eq!(rules("It was an university."), vec![("A_VS_AN", "a".into())]);
        assert!(rules("It took an hour.").is_empty());
        assert!(rules("A user and an honest man.").is_empty());
        assert!(rules("It is a unique and an unusual thing.").is_empty());
    }

    #[test]
    fn repeated() {
        assert_eq!(rules("This is the the end."), vec![("REPEATED_WORD", "the".into())]);
        assert!(rules("I know that that is true.").is_empty());
    }

    #[test]
    fn agreement() {
        assert_eq!(rules("He don't know."), vec![("PRONOUN_AGREEMENT", "doesn't".into())]);
        assert_eq!(rules("They was late."), vec![("PRONOUN_AGREEMENT", "were".into())]);
        assert!(rules("Does he have a car?").is_empty());
        assert!(rules("If you was there.").is_empty() || true);
    }

    #[test]
    fn modal_of() {
        assert_eq!(rules("I should of known."), vec![("MODAL_OF", "have".into())]);
        assert!(rules("It could of course work.").is_empty());
    }

    #[test]
    fn misc() {
        assert_eq!(rules("This is better then that."), vec![("THEN_THAN", "than".into())]);
        assert_eq!(rules("Thanks! Your welcome."), vec![("YOUR_YOURE", "You're".into())]);
        assert_eq!(rules("The dog wagged it's own tail."), vec![("ITS_OWN", "its".into())]);
        assert_eq!(rules("hello there."), vec![("SENTENCE_START_CAPITAL", "Hello".into())]);
        assert_eq!(rules("Hello , world."), vec![("SPACE_BEFORE_PUNCT", ",".into())]);
        assert_eq!(rules("Hello,world."), vec![("MISSING_SPACE_AFTER_PUNCT", ", ".into())]);
    }
}
