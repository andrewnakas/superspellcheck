export type Category = 'spelling' | 'grammar' | 'punctuation' | 'capitalization' | 'word_choice';

export interface Issue {
  offset: number; // UTF-16
  length: number;
  text: string;
  category: Category;
  rule: string;
  message: string;
  replacements: string[];
  confidence: number;
}

export interface Settings {
  enabled: boolean;
  /** 0..1 — issues below this confidence are hidden. */
  minConfidence: number;
  disabledSites: string[];
  disabledRules: string[];
  /** Turn off the browser's own spellcheck in fields we handle, to avoid double underlines. */
  replaceNativeSpellcheck: boolean;
  /** On-device AI deep check (fine-tuned Qwen). Off until the user opts in and downloads the model. */
  aiCheck: boolean;
  aiModel: string;
  /** Model host override; empty means Hugging Face. Used by tests and self-hosted mirrors. */
  aiHost: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  minConfidence: 0.5,
  disabledSites: [],
  disabledRules: [],
  replaceNativeSpellcheck: true,
  aiCheck: false,
  // Swap for the fine-tuned model once it is published (see train/README.md).
  aiModel: 'onnx-community/Qwen3-0.6B-ONNX',
  aiHost: '',
};

export type Request =
  | { type: 'check'; text: string }
  | { type: 'aiCheck'; text: string }
  | { type: 'aiLoad' }
  | { type: 'aiStatus'; status: unknown }
  | { type: 'addWord'; word: string }
  | { type: 'ignore'; key: string }
  | { type: 'accepted'; rule: string }
  | { type: 'removeWord'; word: string }
  | { type: 'getSettings' }
  | { type: 'ping' };

export type CheckResponse = { issues: Issue[]; ms: number } | { error: string };
