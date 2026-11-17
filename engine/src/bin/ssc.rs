//! Command-line front end.
//!
//!   ssc check [--data DIR] [--all] [TEXT]     check TEXT (or stdin), print JSON issues
//!   ssc suggest [--data DIR] WORD [PREV] [NEXT]
//!   ssc batch [--data DIR]                     word[<TAB>prev<TAB>next] per stdin line -> "word<TAB>ok|bad<TAB>s1,s2,..."
//!   ssc jsonl [--data DIR] [--all]             JSON string per stdin line -> JSON issue array per line

use ssc_engine::{CheckOptions, Ctx, Engine};
use std::io::{BufRead, Read};
use std::path::PathBuf;

fn main() {
    let mut args: Vec<String> = std::env::args().skip(1).collect();
    let mut data = std::env::var("SSC_DATA").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("data"));
    let mut all = false;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "--data" && i + 1 < args.len() {
            data = PathBuf::from(args.remove(i + 1));
            args.remove(i);
        } else if args[i] == "--all" {
            all = true;
            args.remove(i);
        } else {
            i += 1;
        }
    }
    let cmd = args.first().cloned().unwrap_or_else(|| "check".into());
    let t0 = std::time::Instant::now();
    let mut engine = Engine::from_dir(&data).unwrap_or_else(|e| {
        eprintln!("failed to load data from {}: {}", data.display(), e);
        std::process::exit(2)
    });
    if let Ok(a) = std::env::var("SSC_ALPHA") { engine.weights.alpha = a.parse().unwrap(); }
    if let Ok(b) = std::env::var("SSC_BETA") { engine.weights.beta = b.parse().unwrap(); }
    eprintln!("loaded in {:?} ({} index entries)", t0.elapsed(), engine.index_size());
    match cmd.as_str() {
        "check" => {
            let text = if args.len() > 1 { args[1..].join(" ") } else {
                let mut s = String::new();
                std::io::stdin().read_to_string(&mut s).unwrap();
                s
            };
            let opts = CheckOptions { min_confidence: if all { 0.0 } else { 0.5 }, ..Default::default() };
            let t1 = std::time::Instant::now();
            let issues = engine.check_with(&text, &opts);
            eprintln!("checked in {:?}", t1.elapsed());
            println!("{}", serde_json::to_string_pretty(&issues).unwrap());
        }
        "suggest" => {
            let word = args.get(1).expect("word required");
            let ctx = Ctx { prev: args.get(2).map(|s| s.as_str()), next: args.get(3).map(|s| s.as_str()) };
            for s in engine.suggest(word, ctx, 10) {
                println!("{:<20} score={:.2} cost={:.2}", s.word, s.score, s.cost);
            }
        }
        "batch" => {
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let line = line.unwrap();
                let mut parts = line.split('\t');
                let word = parts.next().unwrap_or("");
                let prev = parts.next().filter(|s| !s.is_empty());
                let next = parts.next().filter(|s| !s.is_empty());
                let valid = engine.is_valid(word);
                let sugg: Vec<String> = if valid { vec![] } else { engine.suggest(word, Ctx { prev, next }, 10).into_iter().map(|s| s.word).collect() };
                println!("{}\t{}\t{}", word, if valid { "ok" } else { "bad" }, sugg.join(","));
            }
        }
        "jsonl" => {
            // one JSON string per stdin line -> one JSON array of issues per line
            let opts = CheckOptions { min_confidence: if all { 0.0 } else { 0.5 }, ..Default::default() };
            let stdin = std::io::stdin();
            for line in stdin.lock().lines() {
                let text: String = serde_json::from_str(&line.unwrap()).unwrap_or_default();
                println!("{}", serde_json::to_string(&engine.check_with(&text, &opts)).unwrap());
            }
        }
        other => {
            eprintln!("unknown command {other}");
            std::process::exit(1)
        }
    }
}
