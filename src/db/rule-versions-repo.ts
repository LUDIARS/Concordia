import type Database from "better-sqlite3";
import type { RuleRow } from "./rules-repo.js";

/**
 * rule 設定の版履歴 (spec/feature/patrol-chat.md §8 / CC-PATROL-08)。
 * 編集・有効化・rollback のたびに更新後の定義を 1 行残す。 実行状態 (last_* / next_due_at) は含めない。
 */

export interface RuleVersionRow {
  id: number;
  rule_id: string;
  revision: number;
  snapshot: string;
  actor: string;
  note: string | null;
  created_at: number;
}

/** 版として残す定義部分。 */
export type RuleDefinitionSnapshot = Pick<
  RuleRow,
  | "description" | "trigger_type" | "tick_sec" | "event_kind" | "conditions" | "instructions"
  | "target" | "cooldown_sec" | "enabled" | "config_version" | "execution_mode" | "action_config"
>;

export function snapshotOf(rule: RuleRow): RuleDefinitionSnapshot {
  return {
    description: rule.description,
    trigger_type: rule.trigger_type,
    tick_sec: rule.tick_sec,
    event_kind: rule.event_kind,
    conditions: rule.conditions,
    instructions: rule.instructions,
    target: rule.target,
    cooldown_sec: rule.cooldown_sec,
    enabled: rule.enabled,
    config_version: rule.config_version,
    execution_mode: rule.execution_mode,
    action_config: rule.action_config,
  };
}

export class RuleVersionsRepo {
  constructor(private readonly db: Database.Database) {}

  /** 同じ (rule, revision) は一度だけ残す。 */
  record(rule: RuleRow, actor: string, note: string | null, nowSec = Math.floor(Date.now() / 1000)): void {
    this.db
      .prepare(
        `INSERT INTO rule_versions(rule_id, revision, snapshot, actor, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(rule_id, revision) DO NOTHING`,
      )
      .run(rule.id, rule.revision, JSON.stringify(snapshotOf(rule)), actor, note, nowSec);
  }

  list(ruleId: string, limit = 50): RuleVersionRow[] {
    return this.db
      .prepare(`SELECT * FROM rule_versions WHERE rule_id = ? ORDER BY revision DESC LIMIT ?`)
      .all(ruleId, Math.min(Math.max(1, limit), 200)) as RuleVersionRow[];
  }

  find(ruleId: string, revision: number): RuleVersionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM rule_versions WHERE rule_id = ? AND revision = ?`)
        .get(ruleId, revision) as RuleVersionRow | undefined) ?? null
    );
  }
}
