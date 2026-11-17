//! Real-word error detection: words that are spelled correctly but are the
//! wrong word in context ("form" for "from", "loose" for "lose"). Dictionary
//! checkers (Chrome, Hunspell) cannot catch these at all.

/// Groups of commonly confused real words. Each word may be replaced by any other in its group.
pub const SETS: &[&[&str]] = &[
    &["their", "there", "they're"],
    &["your", "you're"],
    &["its", "it's"],
    &["then", "than"],
    &["to", "too"],
    &["affect", "effect"],
    &["affected", "effected"],
    &["accept", "except"],
    &["advice", "advise"],
    &["breath", "breathe"],
    &["quite", "quiet"],
    &["weather", "whether"],
    &["principal", "principle"],
    &["complement", "compliment"],
    &["desert", "dessert"],
    &["lose", "loose"],
    &["loosing", "losing"],
    &["past", "passed"],
    &["peace", "piece"],
    &["brake", "break"],
    &["here", "hear"],
    &["know", "now"],
    &["knew", "new"],
    &["write", "right"],
    &["where", "were", "wear"],
    &["whose", "who's"],
    &["of", "off"],
    &["form", "from"],
    &["fro", "for"],
    &["dose", "does"],
    &["latter", "later"],
    &["chose", "choose"],
    &["definitely", "defiantly"],
    &["thought", "though", "through", "thorough"],
    &["were", "we're"],
    &["led", "lead"],
    &["sight", "site", "cite"],
    &["council", "counsel"],
    &["stationary", "stationery"],
    &["further", "farther"],
    &["eminent", "imminent"],
    &["elicit", "illicit"],
    &["allot", "alot"],
    &["clothes", "cloths"],
    &["dinner", "diner"],
    &["personal", "personnel"],
    &["access", "excess"],
    &["adverse", "averse"],
    &["altogether", "all together"],
    &["everyday", "every day"],
    &["anyway", "any way"],
    &["maybe", "may be"],
    &["setup", "set up"],
    &["login", "log in"],
    &["bare", "bear"],
    &["coarse", "course"],
    &["discreet", "discrete"],
    &["insure", "ensure"],
    &["lie", "lay"],
    &["sneak", "snuck"],
    &["tenant", "tenet"],
    &["want", "won't"],
    &["wont", "won't"],
    &["cant", "can't"],
    &["were", "we're"],
    &["hole", "whole"],
    &["weak", "week"],
    &["by", "buy", "bye"],
    &["sea", "see"],
    &["meet", "meat"],
    &["plain", "plane"],
    &["rain", "reign", "rein"],
    &["role", "roll"],
    &["sale", "sell"],
    &["threw", "through"],
    &["waist", "waste"],
    &["wait", "weight"],
    &["which", "witch"],
    &["an", "and"],
    &["it", "in"],
    &["is", "if"],
    &["on", "one"],
    &["the", "they", "then"],
    &["as", "has"],
    &["us", "use"],
    &["be", "by"],
];

/// Per-set prior penalty (nats) for switching away from what was typed.
/// Short function words are confusable but also extremely common in valid text,
/// so they need stronger evidence.
pub fn switch_penalty(typed: &str, alt: &str) -> f64 {
    let short = |w: &str| w.len() <= 3;
    let mut p = 5.0;
    if short(typed) && short(alt) {
        p += 2.0;
    }
    if alt.contains(' ') || typed.contains(' ') {
        p += 1.0;
    }
    p
}

pub fn alternatives(lower: &str) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = Vec::new();
    for set in SETS {
        if set.contains(&lower) {
            for &w in set.iter() {
                if w != lower && !out.contains(&w) {
                    out.push(w);
                }
            }
        }
    }
    out
}
