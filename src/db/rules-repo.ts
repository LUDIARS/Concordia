import type Database from "better-sqlite3";

export type TriggerType = "tick" | "event";

export interface RuleRow {
  id: string;
  description: string | null;
  trigger_type: TriggerType;
  tick_sec: number | null;
  event_kind: string | null;
  conditions: string;       // JSON
  instructions: string;
  target: string | null;
  cooldown_sec: number;
  last_fired_at: number | null;
  enabled: number;
  added_at: number;
  added_by: string;
  removed_at: number | null;
  removed_by: string | null;
  removed_reason: string | null;
}

export interface RuleLogRow {
  id: number;
  ts: number;
  rule_id: string | null;
  action: "add" | "remove" | "fire" | "skip" | "error";
  detail: string | null;
  actor: "system" | "ai" | "human" | "engine";
}

export class RulesRepo {
  constructor(private readonly db: Database.Database) {}

  insert(input: Omit<RuleRow, "added_at" | "removed_at" | "removed_by" | "removed_reason" | "last_fired_at" | "enabled"> & {
    enabled?: boolean;
  }): RuleRow {
    const now = Math.floor(Date.now() / 1000);
    this.db
      .prepare(
        `INSERT INTO rules(
          id, description, trigger_type, tick_sec, event_kind, conditions,
          instructions, target, cooldown_sec, last_fired_at, enabled,
          added_at, added_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
        ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        input.id,
        input.description ?? null,
        input.trigger_type,
        input.tick_sec,
        input.event_kind,
        input.conditions,
        input.instructions,
        input.target,
        input.cooldown_sec,
        input.enabled === false ? 0 : 1,
        now,
        input.added_by,
      );
    return this.find(input.id)!;
  }

  find(id: string): RuleRow | null {
    return (
      (this.db.prepare(`SELECT * FROM rules WHERE id = ?`).get(id) as RuleRow | undefined) ?? null
    );
  }

  list(filter: { enabled?: boolean; trigger_type?: TriggerType } = {}): RuleRow[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.enabled !== undefined) { where.push("enabled = ?"); args.push(filter.enabled ? 1 : 0); }
    if (filter.trigger_type) { where.push("trigger_type = ?"); args.push(filter.trigger_type); }
    const sql = `SELECT * FROM rules ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY added_at DESC`;
    return this.db.prepare(sql).all(...args) as RuleRow[];
  }

  toggle(id: string, enabled: boolean): void {
    this.db.prepare(`UPDATE rules SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
  }

  /** human/ai 編集用. id / added_at / added_by / removed_* / last_fired_at は触らない. */
  updateRule(
    id: string,
    patch: {
      description?: string | null;
      trigger_type?: TriggerType;
      tick_sec?: number | null;
      event_kind?: string | null;
      conditions?: string;
      instructions?: string;
      target?: string | null;
      cooldown_sec?: number;
    },
  ): boolean {
    const sets: string[] = [];
    const args: unknown[] = [];
    if (patch.description !== undefined)  { sets.push("description = ?");  args.push(patch.description); }
    if (patch.trigger_type !== undefined) { sets.push("trigger_type = ?"); args.push(patch.trigger_type); }
    if (patch.tick_sec !== undefined)     { sets.push("tick_sec = ?");     args.push(patch.tick_sec); }
    if (patch.event_kind !== undefined)   { sets.push("event_kind = ?");   args.push(patch.event_kind); }
    if (patch.conditions !== undefined)   { sets.push("conditions = ?");   args.push(patch.conditions); }
    if (patch.instructions !== undefined) { sets.push("instructions = ?"); args.push(patch.instructions); }
    if (patch.target !== undefined)       { sets.push("target = ?");       args.push(patch.target); }
    if (patch.cooldown_sec !== undefined) { sets.push("cooldown_sec = ?"); args.push(patch.cooldown_sec); }
    if (sets.length === 0) return false;
    args.push(id);
    const r = this.db.prepare(`UPDATE rules SET ${sets.join(", ")} WHERE id = ?`).run(...args);
    return Number(r.changes ?? 0) > 0;
  }

  /**
   * system が seed した rule の本文を最新仕様で上書きする. 起動時の re-seed 用.
   * description / instructions / target / cooldown / tick_sec / event_kind / conditions を更新.
   * removed 済 rule は更新しない (retire を尊重).
   */
  updateSystemDefaults(input: {
    id: string;
    description: string | null;
    trigger_type: TriggerType;
    tick_sec: number | null;
    event_kind: string | null;
    conditions: string;
    instructions: string;
    target: string | null;
    cooldown_sec: number;
  }): boolean {
    const r = this.db
      .prepare(
        `UPDATE rules SET
           description  = ?,
           trigger_type = ?,
           tick_sec     = ?,
           event_kind   = ?,
           conditions   = ?,
           instructions = ?,
           target       = ?,
           cooldown_sec = ?
         WHERE id = ? AND added_by = 'system' AND removed_at IS NULL`,
      )
      .run(
        input.description,
        input.trigger_type,
        input.tick_sec,
        input.event_kind,
        input.conditions,
        input.instructions,
        input.target,
        input.cooldown_sec,
        input.id,
      );
    return Number(r.changes ?? 0) > 0;
  }

  setLastFired(id: string, ts: number): void {
    this.db.prepare(`UPDATE rules SET last_fired_at = ? WHERE id = ?`).run(ts, id);
  }

  remove(id: string, by: string, reason: string | null): boolean {
    const now = Math.floor(Date.now() / 1000);
    const r = this.db
      .prepare(`UPDATE rules SET enabled = 0, removed_at = ?, removed_by = ?, removed_reason = ? WHERE id = ?`)
      .run(now, by, reason, id);
    return Number(r.changes ?? 0) > 0;
  }

  log(input: { rule_id: string | null; action: RuleLogRow["action"]; detail?: string; actor: RuleLogRow["actor"] }): void {
    this.db
      .prepare(`INSERT INTO rules_log(ts, rule_id, action, detail, actor) VALUES (?, ?, ?, ?, ?)`)
      .run(Math.floor(Date.now() / 1000), input.rule_id, input.action, input.detail ?? null, input.actor);
  }

  recentLogs(limit = 100): RuleLogRow[] {
    return this.db
      .prepare(`SELECT * FROM rules_log ORDER BY ts DESC LIMIT ?`)
      .all(limit) as RuleLogRow[];
  }
}

/**
 * 起動時に上書きする default rule 定義. 以下に変更を加えると、 既存 DB の
 * system seed 済 rule にも自動反映される (instructions などの drift 防止).
 */
const DEFAULT_TICK_RULE = {
  id: "default-tick",
  description: "default 5-min tick: チャット発言フック (chitchat / consultation channel への投稿判断)",
  trigger_type: "tick" as const,
  tick_sec: 300,
  event_kind: null as string | null,
  conditions: JSON.stringify([
    { type: "any_active_session" },
  ]),
  instructions:
    "**この rule はチャットの発言フック用です. rule 自体の生成 / 削除を主目的としません.**\n" +
    "現在の Concordia 全体の状況 (active sessions / 直近 chat / 直近 events) を見て、 " +
    "次のいずれか 1 つを判断してください:\n" +
    "  (a) chitchat channel に短い雑談を投稿\n" +
    "  (b) consultation channel に軽いレビュー / 相談を投稿\n" +
    "  (c) 投稿不要 (skip) — 直近 chat と被ったり、 言うべきことがなければ skip\n" +
    "rule の add / remove は **どうしても rule の不整合・冗長を見つけた時のみ** で、 通常は使わないでください.\n" +
    "同じ内容を複数 channel に投稿しないこと。 短く、 AI 同士の対話前提で人間配慮不要。",
  target: null as string | null,
  cooldown_sec: 300,
};

/**
 * 起動時に呼ぶ. 既定の 5 分 tick rule を 1 件 seed する.
 *
 * - 未存在: insert
 * - 既存 (system seed): 仕様変更を反映して UPDATE (drift 防止)
 * - 既存 (human/ai が触った rule): 何もしない (尊重)
 *
 * 過去の `default-5sec-tick` (古い 5秒 tick) が残っていれば自動 retire する.
 */
export function seedDefaultRules(repo: RulesRepo): void {
  const existing = repo.find(DEFAULT_TICK_RULE.id);
  if (!existing) {
    repo.insert({
      id: DEFAULT_TICK_RULE.id,
      description: DEFAULT_TICK_RULE.description,
      trigger_type: DEFAULT_TICK_RULE.trigger_type,
      tick_sec: DEFAULT_TICK_RULE.tick_sec,
      event_kind: DEFAULT_TICK_RULE.event_kind,
      conditions: DEFAULT_TICK_RULE.conditions,
      instructions: DEFAULT_TICK_RULE.instructions,
      target: DEFAULT_TICK_RULE.target,
      cooldown_sec: DEFAULT_TICK_RULE.cooldown_sec,
      added_by: "system",
    });
    repo.log({ rule_id: DEFAULT_TICK_RULE.id, action: "add", actor: "system", detail: "seeded (5min)" });
  } else if (
    existing.added_by === "system" &&
    !existing.removed_at &&
    (existing.instructions !== DEFAULT_TICK_RULE.instructions ||
      existing.description !== DEFAULT_TICK_RULE.description ||
      existing.tick_sec !== DEFAULT_TICK_RULE.tick_sec ||
      existing.cooldown_sec !== DEFAULT_TICK_RULE.cooldown_sec ||
      existing.conditions !== DEFAULT_TICK_RULE.conditions ||
      existing.target !== DEFAULT_TICK_RULE.target)
  ) {
    const updated = repo.updateSystemDefaults({
      id: DEFAULT_TICK_RULE.id,
      description: DEFAULT_TICK_RULE.description,
      trigger_type: DEFAULT_TICK_RULE.trigger_type,
      tick_sec: DEFAULT_TICK_RULE.tick_sec,
      event_kind: DEFAULT_TICK_RULE.event_kind,
      conditions: DEFAULT_TICK_RULE.conditions,
      instructions: DEFAULT_TICK_RULE.instructions,
      target: DEFAULT_TICK_RULE.target,
      cooldown_sec: DEFAULT_TICK_RULE.cooldown_sec,
    });
    if (updated) {
      repo.log({
        rule_id: DEFAULT_TICK_RULE.id,
        action: "add",
        actor: "system",
        detail: "re-seeded (instructions / settings drift detected)",
      });
    }
  }

  // 過去の 5sec tick rule を retire
  const old = repo.find("default-5sec-tick");
  if (old && !old.removed_at) {
    repo.remove("default-5sec-tick", "system", "replaced by default-tick (5min interval)");
    repo.log({
      rule_id: "default-5sec-tick",
      action: "remove",
      actor: "system",
      detail: "replaced by default-tick (5min)",
    });
  }
}
