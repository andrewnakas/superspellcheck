//! Symmetric-delete candidate index (SymSpell). Stores hashed deletes of each
//! word's prefix in a flat sorted array, which keeps memory low (important in WASM).

use std::collections::HashSet;

pub const MAX_DIST: usize = 2;
const PREFIX: usize = 7;

pub struct SymSpell {
    entries: Vec<(u32, u32)>,
}

#[inline]
fn hash(chars: &[char]) -> u32 {
    // FNV-1a over chars
    let mut h: u32 = 0x811c9dc5;
    for &c in chars {
        h ^= c as u32;
        h = h.wrapping_mul(0x01000193);
    }
    h
}

fn deletes(word: &[char], max: usize, out: &mut Vec<Vec<char>>) {
    let mut frontier: Vec<Vec<char>> = vec![word.to_vec()];
    let mut seen: HashSet<Vec<char>> = HashSet::new();
    seen.insert(word.to_vec());
    out.push(word.to_vec());
    for _ in 0..max {
        let mut next = Vec::new();
        for w in &frontier {
            if w.len() <= 1 {
                continue;
            }
            for i in 0..w.len() {
                let mut d = w.clone();
                d.remove(i);
                if seen.insert(d.clone()) {
                    out.push(d.clone());
                    next.push(d);
                }
            }
        }
        frontier = next;
    }
}

impl SymSpell {
    pub fn build<'a>(words: impl Iterator<Item = (u32, &'a str)>) -> Self {
        let mut entries = Vec::new();
        let mut buf = Vec::new();
        for (id, w) in words {
            let chars: Vec<char> = w.chars().take(PREFIX).collect();
            buf.clear();
            deletes(&chars, MAX_DIST, &mut buf);
            for d in &buf {
                entries.push((hash(d), id));
            }
        }
        entries.sort_unstable();
        entries.dedup();
        entries.shrink_to_fit();
        SymSpell { entries }
    }

    /// Candidate word ids that may be within MAX_DIST edits of `input` (lowercase).
    /// Caller must verify with a real distance.
    pub fn candidates(&self, input: &str) -> Vec<u32> {
        let chars: Vec<char> = input.chars().take(PREFIX).collect();
        let mut ds = Vec::new();
        deletes(&chars, MAX_DIST, &mut ds);
        let mut out = HashSet::new();
        for d in &ds {
            let h = hash(d);
            let start = self.entries.partition_point(|e| e.0 < h);
            for e in &self.entries[start..] {
                if e.0 != h {
                    break;
                }
                out.insert(e.1);
            }
        }
        out.into_iter().collect()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }
}

/// Optimal-string-alignment (restricted Damerau-Levenshtein) distance, early exit above `max`.
pub fn osa_distance(a: &[char], b: &[char], max: usize) -> usize {
    let (n, m) = (a.len(), b.len());
    if n.abs_diff(m) > max {
        return max + 1;
    }
    let mut d = vec![vec![0usize; m + 1]; n + 1];
    for i in 0..=n {
        d[i][0] = i;
    }
    for j in 0..=m {
        d[0][j] = j;
    }
    for i in 1..=n {
        let mut row_min = usize::MAX;
        for j in 1..=m {
            let cost = if a[i - 1] == b[j - 1] { 0 } else { 1 };
            let mut v = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
            if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                v = v.min(d[i - 2][j - 2] + 1);
            }
            d[i][j] = v;
            row_min = row_min.min(v);
        }
        if row_min > max {
            return max + 1;
        }
    }
    d[n][m]
}
