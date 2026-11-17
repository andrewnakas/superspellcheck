import { DEFAULT_SETTINGS, Settings } from './types';

const api: typeof chrome = (globalThis as any).browser ?? (globalThis as any).chrome;
export { api };

export async function getSettings(): Promise<Settings> {
  const s = await api.storage.sync.get('settings');
  return { ...DEFAULT_SETTINGS, ...(s.settings ?? {}) };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await api.storage.sync.set({ settings: next });
  return next;
}

/** Personal dictionary. Stored in sync storage so it follows the user across devices. */
export async function getDictionary(): Promise<string[]> {
  const s = await api.storage.sync.get('dictionary');
  return s.dictionary ?? [];
}

export async function setDictionary(words: string[]): Promise<void> {
  const unique = [...new Set(words.map((w) => w.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  await api.storage.sync.set({ dictionary: unique });
}

