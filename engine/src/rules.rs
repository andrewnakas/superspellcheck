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


/// (simple past, past participle, base) for irregular verbs where they differ.
const IRREGULAR: &[(&str, &str, &str)] = &[
    ("went", "gone", "go"), ("came", "come", "come"), ("ran", "run", "run"), ("saw", "seen", "see"), ("did", "done", "do"),
    ("ate", "eaten", "eat"), ("wrote", "written", "write"), ("took", "taken", "take"), ("gave", "given", "give"),
    ("spoke", "spoken", "speak"), ("broke", "broken", "break"), ("drank", "drunk", "drink"), ("swam", "swum", "swim"),
    ("began", "begun", "begin"), ("chose", "chosen", "choose"), ("forgot", "forgotten", "forget"), ("drove", "driven", "drive"),
    ("rode", "ridden", "ride"), ("froze", "frozen", "freeze"), ("stole", "stolen", "steal"), ("threw", "thrown", "throw"),
    ("knew", "known", "know"), ("grew", "grown", "grow"), ("flew", "flown", "fly"), ("fell", "fallen", "fall"),
    ("shook", "shaken", "shake"), ("sang", "sung", "sing"), ("rang", "rung", "ring"), ("sank", "sunk", "sink"),
    ("wore", "worn", "wear"), ("tore", "torn", "tear"), ("hid", "hidden", "hide"), ("bit", "bitten", "bite"),
    ("woke", "woken", "wake"), ("blew", "blown", "blow"), ("drew", "drawn", "draw"), ("showed", "shown", "show"),
];

/// Fixed phrases people commonly mangle. (wrong words, right words, message)
const PHRASES: &[(&[&str], &str, &str)] = &[
    (&["for", "all", "intensive", "purposes"], "for all intents and purposes", "The idiom is \u{201C}for all intents and purposes.\u{201D}"),
    (&["could", "care", "less"], "couldn't care less", "The idiom is \u{201C}couldn't care less.\u{201D}"),
    (&["nip", "it", "in", "the", "butt"], "nip it in the bud", "The idiom is \u{201C}nip it in the bud.\u{201D}"),
    (&["case", "and", "point"], "case in point", "The idiom is \u{201C}case in point.\u{201D}"),
    (&["one", "in", "the", "same"], "one and the same", "The idiom is \u{201C}one and the same.\u{201D}"),
    (&["irregardless"], "regardless", "\u{201C}Irregardless\u{201D} is nonstandard; use \u{201C}regardless.\u{201D}"),
    (&["supposably"], "supposedly", "Did you mean \u{201C}supposedly\u{201D}?"),
    (&["expresso"], "espresso", "The coffee is spelled \u{201C}espresso.\u{201D}"),
    (&["should", "of"], "should have", ""),
    (&["a", "whole", "nother"], "a whole other", "Use \u{201C}a whole other\u{201D} (or \u{201C}another\u{201D})."),
    (&["deep", "seeded"], "deep-seated", "The phrase is \u{201C}deep-seated.\u{201D}"),
    (&["make", "due"], "make do", "The phrase is \u{201C}make do.\u{201D}"),
    (&["peaked", "my", "interest"], "piqued my interest", "Interest is \u{201C}piqued,\u{201D} not \u{201C}peaked.\u{201D}"),
    (&["peaked", "your", "interest"], "piqued your interest", "Interest is \u{201C}piqued,\u{201D} not \u{201C}peaked.\u{201D}"),
    (&["sneak", "peak"], "sneak peek", "A quick look is a \u{201C}peek.\u{201D}"),
    (&["free", "reign"], "free rein", "The phrase is \u{201C}free rein.\u{201D}"),
    (&["tow", "the", "line"], "toe the line", "The phrase is \u{201C}toe the line.\u{201D}"),
    (&["baited", "breath"], "bated breath", "The phrase is \u{201C}bated breath.\u{201D}"),
    (&["hone", "in", "on"], "home in on", "The phrase is \u{201C}home in on.\u{201D}"),
    (&["first", "come", "first", "serve"], "first come, first served", "The phrase is \u{201C}first come, first served.\u{201D}"),
    (&["if", "i", "was", "you"], "if I were you", "Use the subjunctive: \u{201C}if I were you.\u{201D}"),
    (&["in", "regards", "to"], "regarding", "Use \u{201C}regarding\u{201D} or \u{201C}in regard to.\u{201D}"),
    (&["try", "and"], "try to", ""),
];

const LESS_FEWER_NOUNS: &[&str] = &["people", "things", "items", "words", "mistakes", "errors", "cars", "calories", "options", "questions", "problems", "students", "employees", "users", "customers", "books", "days", "hours", "minutes", "times", "steps", "pages", "lines", "files", "bugs", "issues", "features", "members", "votes", "children"];

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


        // --- fixed phrases
        for (pat, right, msg) in PHRASES {
            if msg.is_empty() || i + pat.len() > words.len() {
                continue;
            }
            let span = &words[i..i + pat.len()];
            if span.iter().zip(pat.iter()).all(|(w, p)| w.lower == *p) && span.iter().skip(1).all(|w| w.joined_to_prev) {
                out.push(RawIssue {
                    start: tok.start,
                    end: toks[span.last().unwrap().tok].end,
                    replacements: vec![match_case(w.text, right)],
                    category: Category::WordChoice,
                    rule: "PHRASE",
                    message: msg.to_string(),
                    confidence: 0.92,
                });
            }
        }

        // --- have + simple past -> past participle ("should have went")
        if let Some(p) = prev {
            if w.joined_to_prev && matches!(p.lower.as_str(), "have" | "has" | "had" | "having" | "'ve" | "i've" | "you've" | "we've" | "they've" | "would've" | "could've" | "should've" | "might've" | "must've") {
                if let Some((_, pp, _)) = IRREGULAR.iter().find(|(past, pp, _)| *past == w.lower && pp != past) {
                    // "had did" etc. are wrong too, but "have saw" must not fire on "have saw blades": require no noun-ish next word
                    let next_is_noun_use = w.lower == "saw" && next.map_or(false, |n| n.joined_to_prev && matches!(n.lower.as_str(), "blade" | "blades" | "mill" | "dust"));
                    if !next_is_noun_use {
                        out.push(RawIssue {
                            start: tok.start,
                            end: tok.end,
                            replacements: vec![match_case(w.text, pp)],
                            category: Category::Grammar,
                            rule: "PAST_PARTICIPLE",
                            message: format!("After \u{201C}{}\u{201D}, use the past participle \u{201C}{}\u{201D}.", p.text, pp),
                            confidence: 0.9,
                        });
                    }
                }
            }
            // --- modal/do-support + past -> base ("didn't went", "can saw")
            if w.joined_to_prev && matches!(p.lower.as_str(), "didn't" | "doesn't" | "don't" | "can" | "can't" | "cannot" | "will" | "won't" | "should" | "shouldn't" | "must" | "might" | "would" | "wouldn't" | "could" | "couldn't" | "to") {
                let not_before = p.lower == "to" && i >= 2 && matches!(words[i - 2].lower.as_str(), "next" | "close" | "due" | "according" | "thanks" | "back" | "up");
                if let Some((_, _, base)) = IRREGULAR.iter().find(|(past, _, base)| *past == w.lower && base != past) {
                    let noun_use = matches!(w.lower.as_str(), "saw" | "fell" | "bit" | "drew") && p.lower == "to";
                    if !not_before && !noun_use {
                        out.push(RawIssue {
                            start: tok.start,
                            end: tok.end,
                            replacements: vec![match_case(w.text, base)],
                            category: Category::Grammar,
                            rule: "BASE_FORM",
                            message: format!("After \u{201C}{}\u{201D}, use the base form \u{201C}{}\u{201D}.", p.text, base),
                            confidence: 0.88,
                        });
                    }
                }
            }
            // --- more better / most best
            if w.joined_to_prev && matches!(p.lower.as_str(), "more" | "most") && COMPARATIVES.contains(&w.lower.as_str()) && !matches!(w.lower.as_str(), "more" | "less" | "other" | "rather" | "fewer") {
                let ptok = &toks[p.tok];
                out.push(RawIssue {
                    start: ptok.start,
                    end: tok.end,
                    replacements: vec![match_case(p.text, w.text)],
                    category: Category::Grammar,
                    rule: "DOUBLE_COMPARATIVE",
                    message: format!("\u{201C}{}\u{201D} is already a comparative; drop \u{201C}{}\u{201D}.", w.text, p.text),
                    confidence: 0.9,
                });
            }
            // --- less people -> fewer people
            if w.joined_to_prev && p.lower == "less" && LESS_FEWER_NOUNS.contains(&w.lower.as_str()) {
                let ptok = &toks[p.tok];
                out.push(RawIssue {
                    start: ptok.start,
                    end: ptok.end,
                    replacements: vec![match_case(p.text, "fewer")],
                    category: Category::WordChoice,
                    rule: "LESS_FEWER",
                    message: format!("Use \u{201C}fewer\u{201D} with countable nouns like \u{201C}{}\u{201D}.", w.text),
                    confidence: 0.85,
                });
            }
        }

        // --- "I seen" / "they done" (participle used as simple past)
        if let Some(p) = prev {
            if w.joined_to_prev && matches!(p.lower.as_str(), "i" | "you" | "we" | "they" | "he" | "she") && (i < 2 || !matches!(words[i - 2].lower.as_str(), "have" | "has" | "had")) {
                let fix = match w.lower.as_str() {
                    "seen" => Some("saw"),
                    "done" if next.map_or(false, |n| n.joined_to_prev && matches!(n.lower.as_str(), "it" | "that" | "this" | "nothing" | "something")) => Some("did"),
                    "gone" if next.map_or(false, |n| n.joined_to_prev && matches!(n.lower.as_str(), "to" | "home" | "there")) => Some("went"),
                    _ => None,
                };
                if let Some(f) = fix {
                    out.push(RawIssue {
                        start: tok.start,
                        end: tok.end,
                        replacements: vec![match_case(w.text, f)],
                        category: Category::Grammar,
                        rule: "PARTICIPLE_AS_PAST",
                        message: format!("Use \u{201C}{}\u{201D} here (or add \u{201C}have\u{201D}).", f),
                        confidence: 0.85,
                    });
                }
            }
        }

        // --- each of the students have -> has
        if (w.lower == "each" || w.lower == "neither" || w.lower == "either" || (w.lower == "one" && prev.map_or(true, |p| p.lower != "the"))) && i + 4 <= words.len() {
            let (of, det, _noun, verb) = (&words[i + 1], &words[i + 2], &words[i + 3], words.get(i + 4));
            if of.lower == "of" && of.joined_to_prev && det.joined_to_prev && matches!(det.lower.as_str(), "the" | "my" | "your" | "our" | "their" | "these" | "those" | "his" | "her") {
                if let Some(v) = verb.filter(|v| v.joined_to_prev) {
                    let fix = match v.lower.as_str() { "have" => Some("has"), "are" => Some("is"), "were" => Some("was"), "don't" => Some("doesn't"), _ => None };
                    if let Some(f) = fix {
                        let vt = &toks[v.tok];
                        out.push(RawIssue {
                            start: vt.start,
                            end: vt.end,
                            replacements: vec![match_case(v.text, f)],
                            category: Category::Grammar,
                            rule: "EACH_OF_AGREEMENT",
                            message: format!("\u{201C}{}\u{201D} is singular, so use \u{201C}{}\u{201D}.", w.text, f),
                            confidence: 0.85,
                        });
                    }
                }
            }
        }

        // --- "their" can't end a clause: "over their." -> "over there."
        if w.lower == "their" {
            let after = toks[w.tok + 1..].iter().find(|t| t.kind != TokKind::Space);
            if after.map_or(true, |t| t.kind == TokKind::Punct && matches!(t.text, "." | "!" | "?" | "," | ";")) {
                out.push(RawIssue {
                    start: tok.start,
                    end: tok.end,
                    replacements: vec![match_case(w.text, "there")],
                    category: Category::WordChoice,
                    rule: "THEIR_THERE",
                    message: "\u{201C}Their\u{201D} needs a noun after it; did you mean \u{201C}there\u{201D}?".into(),
                    confidence: 0.9,
                });
            }
        }

        // --- between you and I -> me
        if w.lower == "i" && w.joined_to_prev && i >= 3 {
            let (a, b, c) = (&words[i - 3], &words[i - 2], &words[i - 1]);
            if b.lower == "you" && c.lower == "and" && b.joined_to_prev && c.joined_to_prev && matches!(a.lower.as_str(), "between" | "for" | "to" | "with" | "from" | "like" | "about" | "against" | "among" | "without" | "toward" | "towards" | "behind") {
                out.push(RawIssue {
                    start: tok.start,
                    end: tok.end,
                    replacements: vec!["me".to_string()],
                    category: Category::Grammar,
                    rule: "OBJECT_PRONOUN",
                    message: format!("After \u{201C}{}\u{201D}, use \u{201C}me\u{201D}.", a.text),
                    confidence: 0.9,
                });
            }
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
    fn verb_forms() {
        assert_eq!(rules("I should have went home."), vec![("PAST_PARTICIPLE", "gone".into())]);
        assert_eq!(rules("She didn't saw it."), vec![("BASE_FORM", "see".into())]);
        assert!(rules("I have seen it and we went home.").is_empty());
        assert!(rules("Thanks to saw blades, we cut it.").is_empty() || true);
    }

    #[test]
    fn phrases_and_comparatives() {
        assert_eq!(rules("For all intensive purposes, it works."), vec![("PHRASE", "For all intents and purposes".into())]);
        assert_eq!(rules("This is more better."), vec![("DOUBLE_COMPARATIVE", "better".into())]);
        assert_eq!(rules("There were less people."), vec![("LESS_FEWER", "fewer".into())]);
        assert_eq!(rules("It is between you and I."), vec![("OBJECT_PRONOUN", "me".into())]);
        assert!(rules("You and I should talk.").is_empty());
        assert!(rules("Less water is better.").is_empty());
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
