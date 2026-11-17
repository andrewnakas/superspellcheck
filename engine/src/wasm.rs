//! WebAssembly bindings used by the browser extension.

use crate::{CheckOptions, Engine};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmEngine {
    inner: Engine,
}

#[wasm_bindgen]
impl WasmEngine {
    #[wasm_bindgen(constructor)]
    pub fn new(lexicon: &str, unigrams: &str, bigrams: &str, variants: &str) -> WasmEngine {
        let mut inner = Engine::new(lexicon, unigrams, bigrams);
        inner.add_variants(variants);
        WasmEngine { inner }
    }

    /// Check `text`; `options` is a JSON CheckOptions object (may be "{}").
    /// Returns a JSON array of issues with UTF-16 offsets.
    pub fn check(&self, text: &str, options: &str) -> String {
        let opts: CheckOptions = serde_json::from_str(options).unwrap_or_default();
        serde_json::to_string(&self.inner.check_with(text, &opts)).unwrap_or_else(|_| "[]".into())
    }

    #[wasm_bindgen(js_name = addWord)]
    pub fn add_word(&mut self, word: &str) {
        self.inner.add_word(word);
    }

    #[wasm_bindgen(js_name = removeWord)]
    pub fn remove_word(&mut self, word: &str) {
        self.inner.remove_word(word);
    }

    #[wasm_bindgen(js_name = isValid)]
    pub fn is_valid(&self, word: &str) -> bool {
        self.inner.is_valid(word)
    }
}
