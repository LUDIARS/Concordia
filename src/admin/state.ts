/**
 * Runtime-toggled admin switches that previously lived as one-shot env
 * vars (CONCORDIA_DISABLE_CLAUDE) or were unreachable without a restart.
 *
 *   - chat_muted               default true   — chitchat / chat-reply / report
 *                                                 task enqueues are skipped
 *   - rules_enabled            default false  — rule engine + proposer both
 *                                                 paused (no claude calls)
 *   - rule_proposer_interval   default 3600s  — gap between proposer ticks
 *                                                 (60..86400)
 *
 * Persisted in `schema_meta` (key/value table that already exists). All
 * reads cache the row to one SELECT per get — cheap enough for the rule
 * engine's per-tick check.
 *
 * The env var CONCORDIA_DISABLE_CLAUDE=1 still wins as an emergency OFF
 * even when rules_enabled=true in DB — see callers.
 */

import type Database from "better-sqlite3";

const KEY_CHAT_MUTED = "admin.chat_muted";
const KEY_RULES_ENABLED = "admin.rules_enabled";
const KEY_PROPOSER_INTERVAL = "admin.rule_proposer_interval_sec";

const DEFAULT_CHAT_MUTED = true;
const DEFAULT_RULES_ENABLED = false;
const DEFAULT_PROPOSER_INTERVAL = 3600;

const PROPOSER_INTERVAL_MIN = 60;
const PROPOSER_INTERVAL_MAX = 86400;

export class AdminState {
  constructor(private readonly db: Database.Database) {}

  getChatMuted(): boolean {
    return this.getBool(KEY_CHAT_MUTED, DEFAULT_CHAT_MUTED);
  }

  setChatMuted(value: boolean): void {
    this.setBool(KEY_CHAT_MUTED, value);
  }

  getRulesEnabled(): boolean {
    return this.getBool(KEY_RULES_ENABLED, DEFAULT_RULES_ENABLED);
  }

  setRulesEnabled(value: boolean): void {
    this.setBool(KEY_RULES_ENABLED, value);
  }

  getRuleProposerIntervalSec(): number {
    const raw = this.getRaw(KEY_PROPOSER_INTERVAL);
    if (raw === null) return DEFAULT_PROPOSER_INTERVAL;
    const n = Number(raw);
    if (!Number.isFinite(n)) return DEFAULT_PROPOSER_INTERVAL;
    return clamp(n, PROPOSER_INTERVAL_MIN, PROPOSER_INTERVAL_MAX);
  }

  setRuleProposerIntervalSec(value: number): void {
    if (!Number.isFinite(value)) {
      throw new Error("rule_proposer_interval_sec must be a finite number");
    }
    const clamped = clamp(Math.floor(value), PROPOSER_INTERVAL_MIN, PROPOSER_INTERVAL_MAX);
    this.setRaw(KEY_PROPOSER_INTERVAL, String(clamped));
  }

  snapshot(): {
    chat_muted: boolean;
    rules_enabled: boolean;
    rule_proposer_interval_sec: number;
  } {
    return {
      chat_muted: this.getChatMuted(),
      rules_enabled: this.getRulesEnabled(),
      rule_proposer_interval_sec: this.getRuleProposerIntervalSec(),
    };
  }

  // ── internals ───────────────────────────────────────────────────────

  private getRaw(key: string): string | null {
    const row = this.db.prepare(`SELECT value FROM schema_meta WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  private setRaw(key: string, value: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO schema_meta(key, value) VALUES (?, ?)`)
      .run(key, value);
  }

  private getBool(key: string, fallback: boolean): boolean {
    const raw = this.getRaw(key);
    if (raw === null) return fallback;
    return raw === "1" || raw === "true";
  }

  private setBool(key: string, value: boolean): void {
    this.setRaw(key, value ? "1" : "0");
  }
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export const ADMIN_PROPOSER_INTERVAL_MIN = PROPOSER_INTERVAL_MIN;
export const ADMIN_PROPOSER_INTERVAL_MAX = PROPOSER_INTERVAL_MAX;
