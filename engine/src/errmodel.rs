//! Noisy-channel error model: how likely is it that someone intending `intended`
//! typed `typed`? Weighted edit distance that knows about keyboard layout,
//! doubled letters, vowel confusion, missing apostrophes and phonetics.

const QWERTY: [&str; 3] = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];

fn key_pos(c: char) -> Option<(f32, f32)> {
    for (r, row) in QWERTY.iter().enumerate() {
        if let Some(col) = row.find(c) {
            // stagger rows like a real keyboard
            return Some((r as f32, col as f32 + r as f32 * 0.5));
        }
    }
    None
}

pub fn keyboard_adjacent(a: char, b: char) -> bool {
    match (key_pos(a), key_pos(b)) {
        (Some((r1, c1)), Some((r2, c2))) => {
            let dr = (r1 - r2).abs();
            let dc = (c1 - c2).abs();
            dr <= 1.0 && dc <= 1.0 && !(dr == 0.0 && dc == 0.0)
        }
        _ => false,
    }
}

fn is_vowel(c: char) -> bool {
    matches!(c, 'a' | 'e' | 'i' | 'o' | 'u' | 'y')
}

fn sound_alike(a: char, b: char) -> bool {
    let pairs = ["ck", "cs", "ks", "sz", "iy", "mn", "dt", "bp", "fv", "gj", "gk", "xz", "qk", "wv"];
    pairs.iter().any(|p| {
        let mut it = p.chars();
        let (x, y) = (it.next().unwrap(), it.next().unwrap());
        (a == x && b == y) || (a == y && b == x)
    })
}

fn sub_cost(typed: char, intended: char) -> f32 {
    if typed == intended {
        0.0
    } else if typed.to_lowercase().eq(intended.to_lowercase()) {
        0.1
    } else if is_vowel(typed) && is_vowel(intended) {
        0.55
    } else if keyboard_adjacent(typed, intended) {
        0.6
    } else if sound_alike(typed, intended) {
        0.65
    } else {
        1.0
    }
}

/// Cost of an extra char `c` in what was typed (at typed position i).
fn ins_cost(typed: &[char], i: usize) -> f32 {
    let c = typed[i];
    if c == '\'' || c == '-' {
        return 0.3;
    }
    let prev = if i > 0 { Some(typed[i - 1]) } else { None };
    let next = typed.get(i + 1).copied();
    if prev == Some(c) || next == Some(c) {
        0.35 // accidental doubling
    } else if prev.map_or(false, |p| keyboard_adjacent(p, c)) || next.map_or(false, |n| keyboard_adjacent(n, c)) {
        0.55 // fat finger
    } else if is_vowel(c) {
        0.7
    } else {
        0.9
    }
}

/// Cost of a char of `intended` (at position j) that is missing from what was typed.
fn del_cost(intended: &[char], j: usize) -> f32 {
    let c = intended[j];
    if c == '\'' {
        return 0.2; // "dont" -> "don't"
    }
    if c == '-' || c == ' ' {
        return 0.3;
    }
    let prev = if j > 0 { Some(intended[j - 1]) } else { None };
    let next = intended.get(j + 1).copied();
    if prev == Some(c) || next == Some(c) {
        0.35 // undoubling: "ocurred" for "occurred"
    } else if is_vowel(c) {
        0.6
    } else {
        0.85
    }
}

/// Weighted OSA distance; lower means a more plausible typo.
pub fn weighted_distance(typed: &str, intended: &str) -> f32 {
    let t: Vec<char> = typed.chars().collect();
    let w: Vec<char> = intended.chars().collect();
    let (n, m) = (t.len(), w.len());
    let mut d = vec![vec![0f32; m + 1]; n + 1];
    for i in 1..=n {
        d[i][0] = d[i - 1][0] + ins_cost(&t, i - 1);
    }
    for j in 1..=m {
        d[0][j] = d[0][j - 1] + del_cost(&w, j - 1);
    }
    for i in 1..=n {
        for j in 1..=m {
            let mut v = (d[i - 1][j] + ins_cost(&t, i - 1))
                .min(d[i][j - 1] + del_cost(&w, j - 1))
                .min(d[i - 1][j - 1] + sub_cost(t[i - 1], w[j - 1]));
            if i > 1 && j > 1 && t[i - 1] == w[j - 2] && t[i - 2] == w[j - 1] && t[i - 1] != t[i - 2] {
                v = v.min(d[i - 2][j - 2] + 0.55);
            }
            // two-for-one phonetic substitutions: "f" for "ph", "k" for "ck", "s" for "ss"/"sc"
            if j > 1 && i >= 1 {
                let pair = (w[j - 2], w[j - 1]);
                let single = t[i - 1];
                let ok = matches!((pair, single), (('p', 'h'), 'f') | (('c', 'k'), 'k') | (('c', 'k'), 'c') | (('s', 'c'), 's') | (('g', 'h'), 'f') | (('q', 'u'), 'k'));
                if ok {
                    v = v.min(d[i - 1][j - 2] + 0.5);
                }
            }
            d[i][j] = v;
        }
    }
    let mut cost = d[n][m];
    // People rarely get the first letter wrong.
    if let (Some(a), Some(b)) = (t.first(), w.first()) {
        if a != b && !(a.to_lowercase().eq(b.to_lowercase())) {
            cost += 0.45;
        }
    }
    if cost > 0.0 && sound_key(typed) == sound_key(intended) {
        cost *= 0.7;
    }
    cost
}

/// A rough phonetic key (Metaphone-flavoured) used to reward sound-alike corrections.
pub fn sound_key(word: &str) -> String {
    let w = word.to_lowercase().replace('\'', "");
    let mut s = w
        .replace("ph", "f")
        .replace("gh", "")
        .replace("ck", "k")
        .replace("sch", "sk")
        .replace("tch", "ch")
        .replace("dg", "j")
        .replace("qu", "kw")
        .replace('q', "k")
        .replace('x', "ks")
        .replace('z', "s");
    for (from, to) in [("ce", "se"), ("ci", "si"), ("cy", "sy")] {
        s = s.replace(from, to);
    }
    s = s.replace('c', "k");
    if s.starts_with("kn") || s.starts_with("wr") || s.starts_with("gn") {
        s.remove(0);
    }
    let mut out = String::new();
    let mut last = ' ';
    for (i, c) in s.chars().enumerate() {
        if i > 0 && is_vowel(c) {
            last = c;
            continue;
        }
        if c != last {
            out.push(c);
        }
        last = c;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn doubling_is_cheap() {
        assert!(weighted_distance("ocured", "occurred") < 1.0);
        assert!(weighted_distance("untill", "until") < 0.5);
    }

    #[test]
    fn keyboard_typos_beat_random() {
        assert!(weighted_distance("thw", "the") < weighted_distance("thw", "thy"));
    }

    #[test]
    fn apostrophe_missing() {
        assert!(weighted_distance("dont", "don't") < 0.3);
    }

    #[test]
    fn phonetic() {
        assert_eq!(sound_key("fone"), sound_key("phone"));
        assert!(weighted_distance("fone", "phone") < weighted_distance("fone", "done") + 0.5);
    }
}
