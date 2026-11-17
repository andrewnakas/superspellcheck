//! Tokenizer that understands the kinds of text people type in a browser:
//! prose, plus URLs, emails, @mentions, #hashtags, code identifiers and
//! numbers, which must never be "corrected".

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokKind {
    /// A word made of letters, possibly with internal apostrophes.
    Word,
    /// Digits, possibly with separators.
    Number,
    /// A single punctuation character.
    Punct,
    /// Whitespace run. `newlines` counts line breaks inside it.
    Space,
    /// Something that is not prose (URL, email, code identifier, ...).
    Skip,
}

#[derive(Debug, Clone)]
pub struct Token<'a> {
    pub kind: TokKind,
    pub text: &'a str,
    /// Byte offsets into the source text.
    pub start: usize,
    pub end: usize,
    /// True for the first word of a sentence.
    pub sentence_start: bool,
}

fn is_apostrophe(c: char) -> bool {
    c == '\'' || c == '\u{2019}'
}

fn is_word_char(c: char) -> bool {
    c.is_alphabetic()
}

/// Decide whether a whitespace-delimited chunk is non-prose and must be skipped wholesale.
fn chunk_is_skippable(chunk: &str) -> bool {
    let trimmed = chunk.trim_matches(|c: char| matches!(c, '(' | ')' | '"' | '\'' | '\u{201C}' | '\u{201D}' | ',' | '.' | ';' | ':' | '!' | '?' | '[' | ']' | '<' | '>'));
    if trimmed.is_empty() {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.contains("://") || lower.starts_with("www.") || lower.starts_with("mailto:") {
        return true;
    }
    if trimmed.starts_with('@') || trimmed.starts_with('#') || trimmed.starts_with('$') || trimmed.starts_with('/') || trimmed.starts_with('~') {
        return true;
    }
    if trimmed.contains('@') && trimmed.contains('.') {
        return true; // email
    }
    if trimmed.contains('_') || trimmed.contains('\\') || trimmed.contains('/') && !trimmed.contains(' ') && trimmed.chars().filter(|c| *c == '/').count() >= 1 && trimmed.len() > 3 && !is_simple_slash_pair(trimmed) {
        return true;
    }
    if trimmed.contains('`') || trimmed.contains('{') || trimmed.contains('}') || trimmed.contains('=') || trimmed.contains("()") || trimmed.contains("->") || trimmed.contains("::") {
        return true;
    }
    // letters mixed with digits: "mp3", "v2", "b4ck" — identifiers, model numbers.
    let has_digit = trimmed.chars().any(|c| c.is_ascii_digit());
    let has_alpha = trimmed.chars().any(|c| c.is_alphabetic());
    if has_digit && has_alpha {
        // allow ordinals like 1st, 2nd, 3rd, 21th (the last is an error but not spelling)
        let ordinal = trimmed.trim_start_matches(|c: char| c.is_ascii_digit());
        if !matches!(ordinal.to_ascii_lowercase().as_str(), "st" | "nd" | "rd" | "th" | "s" | "am" | "pm" | "k" | "m") {
            return true;
        }
    }
    // camelCase / PascalCase with internal capitals: "iPhone", "JavaScript", "getUserName"
    let chars: Vec<char> = trimmed.chars().collect();
    for w in chars.windows(2) {
        if w[0].is_lowercase() && w[1].is_uppercase() {
            return true;
        }
    }
    // file names / domains: "index.js", "example.com"
    if let Some(dot) = trimmed.rfind('.') {
        let (head, tail) = trimmed.split_at(dot);
        let tail = &tail[1..];
        if !head.is_empty() && !tail.is_empty() && tail.len() <= 4 && tail.chars().all(|c| c.is_ascii_lowercase()) && head.chars().last().map_or(false, |c| c.is_alphanumeric()) {
            return true;
        }
    }
    false
}

/// "and/or", "his/her" are prose.
fn is_simple_slash_pair(s: &str) -> bool {
    let parts: Vec<&str> = s.split('/').collect();
    parts.len() == 2 && parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_alphabetic()))
}

const ABBREVIATIONS: &[&str] = &[
    "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "eg", "ie", "inc", "ltd", "co", "corp", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec", "approx", "dept", "est", "fig", "no", "vol", "p", "pp", "u.s", "a.m", "p.m",
];

pub fn tokenize(text: &str) -> Vec<Token<'_>> {
    let mut toks: Vec<Token> = Vec::new();
    let bytes_len = text.len();
    let mut i = 0;
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let n = chars.len();
    let byte_at = |idx: usize| if idx < n { chars[idx].0 } else { bytes_len };

    while i < n {
        let (b, c) = chars[i];
        if c.is_whitespace() {
            let mut j = i;
            while j < n && chars[j].1.is_whitespace() {
                j += 1;
            }
            toks.push(Token { kind: TokKind::Space, text: &text[b..byte_at(j)], start: b, end: byte_at(j), sentence_start: false });
            i = j;
            continue;
        }
        // whole non-whitespace chunk
        let mut j = i;
        while j < n && !chars[j].1.is_whitespace() {
            j += 1;
        }
        let chunk = &text[b..byte_at(j)];
        if chunk_is_skippable(chunk) {
            // keep leading/trailing sentence punctuation as Punct so sentence splitting still works
            let core_end = chunk.trim_end_matches(|c: char| matches!(c, '.' | ',' | ';' | ':' | '!' | '?' | ')' | '"' | '\u{201D}')).len();
            let core_end = if core_end == 0 { chunk.len() } else { core_end };
            toks.push(Token { kind: TokKind::Skip, text: &chunk[..core_end], start: b, end: b + core_end, sentence_start: false });
            for (off, pc) in chunk[core_end..].char_indices() {
                let s = b + core_end + off;
                toks.push(Token { kind: TokKind::Punct, text: &text[s..s + pc.len_utf8()], start: s, end: s + pc.len_utf8(), sentence_start: false });
            }
            i = j;
            continue;
        }
        // split chunk into words / numbers / punctuation
        let mut k = i;
        while k < j {
            let (kb, kc) = chars[k];
            if is_word_char(kc) {
                let mut m = k + 1;
                while m < j {
                    let mc = chars[m].1;
                    if is_word_char(mc) {
                        m += 1;
                    } else if is_apostrophe(mc) && m + 1 < j && is_word_char(chars[m + 1].1) {
                        m += 2;
                    } else if mc == '.' && m + 1 < j && is_word_char(chars[m + 1].1) && m + 2 <= j && (m + 2 == j || !is_word_char(chars[m + 2].1)) && chars[k..m].iter().all(|x| x.1.is_alphabetic()) && m - k == 1 {
                        // dotted abbreviations like "e.g" "i.e" "U.S"
                        m += 2;
                    } else {
                        break;
                    }
                }
                let s = kb;
                let e = byte_at(m);
                toks.push(Token { kind: TokKind::Word, text: &text[s..e], start: s, end: e, sentence_start: false });
                k = m;
            } else if kc.is_ascii_digit() {
                let mut m = k + 1;
                while m < j && (chars[m].1.is_ascii_digit() || (matches!(chars[m].1, ',' | '.' | ':') && m + 1 < j && chars[m + 1].1.is_ascii_digit())) {
                    m += 1;
                }
                // absorb unit / ordinal suffixes: "2nd", "10am", "5k"
                while m < j && chars[m].1.is_alphabetic() {
                    m += 1;
                }
                toks.push(Token { kind: TokKind::Number, text: &text[kb..byte_at(m)], start: kb, end: byte_at(m), sentence_start: false });
                k = m;
            } else {
                let e = kb + kc.len_utf8();
                toks.push(Token { kind: TokKind::Punct, text: &text[kb..e], start: kb, end: e, sentence_start: false });
                k += 1;
            }
        }
        i = j;
    }
    mark_sentences(&mut toks);
    toks
}

fn mark_sentences(toks: &mut [Token]) {
    let mut at_start = true;
    for idx in 0..toks.len() {
        match toks[idx].kind {
            TokKind::Word => {
                if at_start {
                    toks[idx].sentence_start = true;
                    at_start = false;
                }
            }
            TokKind::Number | TokKind::Skip => at_start = false,
            TokKind::Space => {
                if toks[idx].text.matches('\n').count() >= 2 {
                    at_start = true;
                }
            }
            TokKind::Punct => {
                let p = toks[idx].text;
                if p == "!" || p == "?" {
                    at_start = true;
                } else if p == "." || p == "\u{2026}" {
                    // abbreviation? look at previous word
                    let prev_word = toks[..idx].iter().rev().find(|t| t.kind != TokKind::Space);
                    let is_abbrev = match prev_word {
                        Some(t) if t.kind == TokKind::Word && t.end == toks[idx].start => {
                            let lw = t.text.to_ascii_lowercase();
                            ABBREVIATIONS.contains(&lw.as_str()) || (t.text.chars().count() == 1 && t.text.chars().all(|c| c.is_uppercase()))
                        }
                        _ => false,
                    };
                    // "..." ellipsis: only a sentence break if followed by a capital, handled by next word check below
                    let next_is_dot = toks.get(idx + 1).map_or(false, |t| t.text == ".");
                    if !is_abbrev && !next_is_dot {
                        at_start = true;
                    }
                } else if p == ":" {
                    // after a colon a new sentence may or may not start; do not force capitalization
                }
            }
        }
    }
    // A sentence start after "..." followed by lowercase is fine: leave as is.
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(s: &str) -> Vec<&str> {
        tokenize(s).into_iter().filter(|t| t.kind == TokKind::Word).map(|t| t.text).collect()
    }

    #[test]
    fn basic_words() {
        assert_eq!(words("Hello, world! It's fine."), vec!["Hello", "world", "It's", "fine"]);
    }

    #[test]
    fn skips_non_prose() {
        let w = words("see https://example.com/foo or mail bob@example.com, ping @alice about #release and getUserName in index.js");
        assert_eq!(w, vec!["see", "or", "mail", "ping", "about", "and", "in"]);
    }

    #[test]
    fn sentence_starts() {
        let t = tokenize("hello there. this is Dr. Smith. ok");
        let starts: Vec<&str> = t.iter().filter(|t| t.sentence_start).map(|t| t.text).collect();
        assert_eq!(starts, vec!["hello", "this", "ok"]);
    }

    #[test]
    fn numbers_and_ordinals() {
        let t = tokenize("I have 1,000 apples on the 2nd day");
        assert!(t.iter().any(|t| t.kind == TokKind::Number && t.text == "1,000"));
        assert_eq!(words("I have 1,000 apples on the 2nd day"), vec!["I", "have", "apples", "on", "the", "day"]);
    }
}
