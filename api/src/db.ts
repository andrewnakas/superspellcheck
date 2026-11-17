// Accounts, API keys and usage in SQLite (node:sqlite). Only SHA-256 hashes of keys are stored.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Account, KeyStore } from './app.ts';

export const MONTHLY_CHAR_LIMIT: Record<Account['plan'], number> = { pro: 2_000_000, team: 10_000_000 };

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

export interface AccountRow {
  id: string;
  email: string;
  plan: 'pro' | 'team';
  status: 'pending' | 'active' | 'canceled';
  stripe_customer: string | null;
  stripe_subscription: string | null;
  key_issued: number;
}

export class AccountStore implements KeyStore {
  private db: DatabaseSync;

  constructor(path = process.env.SSC_DB ?? 'ssc.sqlite') {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, plan TEXT NOT NULL DEFAULT 'pro',
        status TEXT NOT NULL DEFAULT 'pending', stripe_customer TEXT, stripe_subscription TEXT UNIQUE,
        key_issued INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS api_keys (
        hash TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES accounts(id), created INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS usage (
        account_id TEXT NOT NULL, month TEXT NOT NULL, requests INTEGER NOT NULL DEFAULT 0, chars INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (account_id, month));
    `);
  }

  createPending(email: string, plan: 'pro' | 'team' = 'pro'): AccountRow {
    const id = `acct_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    this.db.prepare('INSERT INTO accounts (id, email, plan, created) VALUES (?, ?, ?, ?)').run(id, email, plan, Date.now());
    return this.get(id)!;
  }

  get(id: string): AccountRow | null {
    return (this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as AccountRow | undefined) ?? null;
  }

  activate(id: string, customer: string | null, subscription: string | null) {
    this.db.prepare("UPDATE accounts SET status = 'active', stripe_customer = ?, stripe_subscription = ? WHERE id = ?").run(customer, subscription, id);
  }

  setSubscriptionStatus(subscription: string, active: boolean) {
    this.db.prepare('UPDATE accounts SET status = ? WHERE stripe_subscription = ?').run(active ? 'active' : 'canceled', subscription);
  }

  /** Issues the account's first key exactly once (shown to the user a single time). */
  issueFirstKey(id: string): string | null {
    const res = this.db.prepare("UPDATE accounts SET key_issued = 1 WHERE id = ? AND key_issued = 0 AND status = 'active'").run(id);
    if (res.changes !== 1) return null;
    return this.createKey(id);
  }

  createKey(accountId: string): string {
    const key = `ssc_${randomBytes(24).toString('base64url')}`;
    this.db.prepare('INSERT INTO api_keys (hash, account_id, created) VALUES (?, ?, ?)').run(hash(key), accountId, Date.now());
    return key;
  }

  /** Revokes every key on the account and returns a new one. */
  rotateKey(oldKey: string): string | null {
    const row = this.db.prepare('SELECT account_id FROM api_keys WHERE hash = ? AND revoked = 0').get(hash(oldKey)) as { account_id: string } | undefined;
    if (!row) return null;
    this.db.prepare('UPDATE api_keys SET revoked = 1 WHERE account_id = ?').run(row.account_id);
    return this.createKey(row.account_id);
  }

  accountForKey(key: string): AccountRow | null {
    return (this.db
      .prepare('SELECT a.* FROM api_keys k JOIN accounts a ON a.id = k.account_id WHERE k.hash = ? AND k.revoked = 0')
      .get(hash(key)) as AccountRow | undefined) ?? null;
  }

  async lookup(key: string): Promise<Account | null> {
    const a = this.accountForKey(key);
    return a && a.status === 'active' ? { id: a.id, plan: a.plan } : null;
  }

  private month(now = new Date()) {
    return now.toISOString().slice(0, 7);
  }

  /** Records usage; returns false if this request would exceed the monthly allowance. */
  meter(account: Account, chars: number, now = new Date()): boolean {
    const m = this.month(now);
    const cur = this.db.prepare('SELECT chars FROM usage WHERE account_id = ? AND month = ?').get(account.id, m) as { chars: number } | undefined;
    if ((cur?.chars ?? 0) + chars > MONTHLY_CHAR_LIMIT[account.plan]) return false;
    this.db
      .prepare('INSERT INTO usage (account_id, month, requests, chars) VALUES (?, ?, 1, ?) ON CONFLICT(account_id, month) DO UPDATE SET requests = requests + 1, chars = chars + excluded.chars')
      .run(account.id, m, chars);
    return true;
  }

  usage(accountId: string, now = new Date()) {
    return (this.db.prepare('SELECT requests, chars FROM usage WHERE account_id = ? AND month = ?').get(accountId, this.month(now)) as
      | { requests: number; chars: number }
      | undefined) ?? { requests: 0, chars: 0 };
  }
}
