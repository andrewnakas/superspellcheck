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
  /** Pro: also send paragraphs to the cloud API for an AI deep check. Off unless the user opts in. */
  deepCheck: boolean;
  apiBase: string;
}

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  minConfidence: 0.5,
  disabledSites: [],
  disabledRules: [],
  replaceNativeSpellcheck: true,
  deepCheck: false,
  apiBase: 'https://api.superspellcheck.app',
};

export type Request =
  | { type: 'check'; text: string }
  | { type: 'deepCheck'; text: string }
  | { type: 'addWord'; word: string }
  | { type: 'ignore'; key: string }
  | { type: 'accepted'; rule: string }
  | { type: 'rewrite'; text: string; goal: 'clearer' | 'shorter' | 'formal' | 'friendly' }
  | { type: 'removeWord'; word: string }
  | { type: 'getSettings' }
  | { type: 'ping' };

export type CheckResponse = { issues: Issue[]; ms: number } | { error: string };
