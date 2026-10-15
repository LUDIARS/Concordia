import type Database from "better-sqlite3";

/**
 * 巡回チャットの実行台帳 (spec/feature/patrol-chat.md §8)。
 *
 *   claimed → material_selected → rendering → rendered → delivery_pending → delivered
 *      ↘ skipped / failed                                       ↘ delivery_unknown
 *
 * - trigger_key は UNIQUE。 同じ trigger は一度だけ受理する (CC-PATROL-03)
 * - 状態遷移は lease_owner と現状態の compare-and-set。 所有権を失った実行は書けない (CC-PATROL-06)
 * - chat 投稿と chat_message_id の記録は同一 transaction (CC-PATROL-02)
 */

export type RunStatus =
  | "claimed"
  | "material_selected"
  | "rendering"
  | "rendered"
  | "delivery_pending"
  | "delivered"
  | "delivery_unknown"
  | "skipped"
  | "failed";

export type RunActionKind = "pick" | "event" | "reply" | "followup";

/** 投稿前で中断し得る状態 (再起動時の復旧対象)。 */
export const IN_FLIGHT_STATUSES: readonly RunStatus[] = ["claimed", "material_selected", "rendering", "rendered"];

export interface RuleRunRow {
  run_id: string;
  rule_id: string;
  rule_revision: number;
  trigger_key: string;
  action_kind: RunActionKind;
  conversation_id: string | null;
  scope_key: string;
  channel: string;
  source_ref: string | null;
  material_snapshot: string | null;
  seed: number | null;
  decision: string | null;
  reason: string | null;
  status: RunStatus;
  lease_owner: string | null;
  lease_until: number | null;
  render_attempts: number;
  llm_calls: number;
  rendered_text: string | null;
  chat_message_id: number | null;
  delivery_ref: string | null;
  error_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface ClaimInput {
  run_id: string;
  rule_id: string;
  rule_revision: number;
  trigger_key: string;
  action_kind: RunActionKind;
  conversation_id: string | null;
  scope_key: string;
  channel: string;
  lease_owner: string;
  lease_until: number;
  now: number;
}

export type RunFields = Partial<Pick<
  RuleRunRow,
  | "source_ref" | "material_snapshot" | "seed" | "decision" | "reason" | "rendered_text"
  | "error_code" | "delivery_ref" | "conversation_id" | "lease_until"
>> & { render_attempts_inc?: number; llm_calls_inc?: number };

const FIELD_COLUMNS = [
  "source_ref", "material_snapshot", "seed", "decision", "reason", "rendered_text",
  "error_code", "delivery_ref", "conversation_id", "lease_until",
] as const;

export interface RunListFilter {
  rule_id?: string;
  status?: RunStatus;
  /** `<created_at>:<run_id>` の続きから返す。 */
  cursor?: string | null;
  limit?: number;
}

export class RuleRunsRepo {
  constructor(private readonly db: Database.Database) {}

  /** trigger を受理して run を作る。 同じ trigger_key が既にあれば null (再受理しない)。 */
  claim(input: ClaimInput): RuleRunRow | null {
    const r = this.db
      .prepare(
        `INSERT INTO rule_runs(
           run_id, rule_id, rule_revision, trigger_key, action_kind, conversation_id, scope_key, channel,
           status, lease_owner, lease_until, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'claimed', ?, ?, ?, ?)
         ON CONFLICT(trigger_key) DO NOTHING`,
      )
      .run(
        input.run_id, input.rule_id, input.rule_revision, input.trigger_key, input.action_kind,
        input.conversation_id, input.scope_key, input.channel, input.lease_owner, input.lease_until,
        input.now, input.now,
      );
    return Number(r.changes ?? 0) > 0 ? this.find(input.run_id) : null;
  }

  /** 結果だけを残す run (skip を理由付きで履歴に出す)。 trigger_key が重複すれば何もしない。 */
  recordSkip(input: Omit<ClaimInput, "lease_owner" | "lease_until"> & { reason: string; decision?: string }): void {
    this.db
      .prepare(
        `INSERT INTO rule_runs(
           run_id, rule_id, rule_revision, trigger_key, action_kind, conversation_id, scope_key, channel,
           status, reason, decision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'skipped', ?, ?, ?, ?)
         ON CONFLICT(trigger_key) DO NOTHING`,
      )
      .run(
        input.run_id, input.rule_id, input.rule_revision, input.trigger_key, input.action_kind,
        input.conversation_id, input.scope_key, input.channel, input.reason, input.decision ?? null,
        input.now, input.now,
      );
  }

  /**
   * 状態遷移 (compare-and-set)。 現状態が from のいずれかで、 lease_owner が一致する時だけ書く。
   * 書けなければ false (所有権喪失 / 既に別状態)。
   */
  transition(runId: string, leaseOwner: string, from: readonly RunStatus[], to: RunStatus, fields: RunFields, now: number): boolean {
    const sets = ["status = ?", "updated_at = ?"];
    const args: unknown[] = [to, now];
    for (const col of FIELD_COLUMNS) {
      if (fields[col] === undefined) continue;
      sets.push(`${col} = ?`);
      args.push(fields[col]);
    }
    if (fields.render_attempts_inc) { sets.push("render_attempts = render_attempts + ?"); args.push(fields.render_attempts_inc); }
    if (fields.llm_calls_inc) { sets.push("llm_calls = llm_calls + ?"); args.push(fields.llm_calls_inc); }
    const placeholders = from.map(() => "?").join(", ");
    args.push(runId, leaseOwner, ...from);
    const r = this.db
      .prepare(`UPDATE rule_runs SET ${sets.join(", ")} WHERE run_id = ? AND lease_owner = ? AND status IN (${placeholders})`)
      .run(...args);
    return Number(r.changes ?? 0) > 0;
  }

  /**
   * 生成済み本文を chat へ確定する。 chat 行の insert と run.chat_message_id の記録を同一 transaction で行い、
   * 片方だけが残らないようにする。 run が rendered でない / lease を失っていれば insert しない。
   */
  commitChat(runId: string, leaseOwner: string, now: number, insertChat: (text: string) => number): number | null {
    const tx = this.db.transaction(() => {
      const run = this.find(runId);
      if (!run || run.status !== "rendered" || run.lease_owner !== leaseOwner || run.rendered_text === null) return null;
      const chatId = insertChat(run.rendered_text);
      this.db
        .prepare(`UPDATE rule_runs SET status = 'delivery_pending', chat_message_id = ?, updated_at = ? WHERE run_id = ?`)
        .run(chatId, now, runId);
      return chatId;
    });
    return tx.immediate();
  }

  /** 配達結果を記録する (lease 不要: 投稿は確定済みで、 配達の照合だけを進める)。 */
  markDelivery(runId: string, status: "delivered" | "delivery_unknown", ref: string | null, now: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE rule_runs SET status = ?, delivery_ref = COALESCE(?, delivery_ref), updated_at = ?
         WHERE run_id = ? AND status IN ('delivery_pending', 'delivery_unknown')`,
      )
      .run(status, ref, now, runId);
    return Number(r.changes ?? 0) > 0;
  }

  /** 投稿で開いた会話を run に結び付ける (投稿確定後の付帯情報なので lease は見ない)。 */
  markConversation(runId: string, conversationId: string, now: number): void {
    this.db.prepare(`UPDATE rule_runs SET conversation_id = ?, updated_at = ? WHERE run_id = ?`).run(conversationId, now, runId);
  }

  find(runId: string): RuleRunRow | null {
    return (this.db.prepare(`SELECT * FROM rule_runs WHERE run_id = ?`).get(runId) as RuleRunRow | undefined) ?? null;
  }

  findByChatMessage(chatMessageId: number): RuleRunRow | null {
    return (
      (this.db.prepare(`SELECT * FROM rule_runs WHERE chat_message_id = ?`).get(chatMessageId) as RuleRunRow | undefined) ?? null
    );
  }

  list(filter: RunListFilter = {}): { runs: RuleRunRow[]; next_cursor: string | null } {
    const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 50)), 200);
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.rule_id) { where.push("rule_id = ?"); args.push(filter.rule_id); }
    if (filter.status) { where.push("status = ?"); args.push(filter.status); }
    const cursor = parseCursor(filter.cursor);
    if (cursor) {
      where.push("(created_at < ? OR (created_at = ? AND run_id < ?))");
      args.push(cursor.createdAt, cursor.createdAt, cursor.runId);
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM rule_runs ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
         ORDER BY created_at DESC, run_id DESC LIMIT ?`,
      )
      .all(...args, limit + 1) as RuleRunRow[];
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return { runs: page, next_cursor: rows.length > limit && last ? `${last.created_at}:${last.run_id}` : null };
  }

  /** 今日 (sinceSec 以降) の root 投稿数と LLM 呼出し数。 */
  usageSince(ruleId: string, sinceSec: number): { roots: number; llmCalls: number } {
    const row = this.db
      .prepare(
        `SELECT
           SUM(CASE WHEN action_kind IN ('pick', 'event') AND chat_message_id IS NOT NULL THEN 1 ELSE 0 END) AS roots,
           SUM(llm_calls) AS llm
         FROM rule_runs WHERE rule_id = ? AND created_at >= ?`,
      )
      .get(ruleId, sinceSec) as { roots: number | null; llm: number | null };
    return { roots: row.roots ?? 0, llmCalls: row.llm ?? 0 };
  }

  /** この rule が選んだことのある話題 (失敗した選択も再選択しない)。 */
  usedItemIds(ruleId: string, sinceSec: number): Set<string> {
    const rows = this.db
      .prepare(`SELECT DISTINCT source_ref FROM rule_runs WHERE rule_id = ? AND source_ref IS NOT NULL AND created_at >= ?`)
      .all(ruleId, sinceSec) as Array<{ source_ref: string }>;
    return new Set(rows.map((r) => r.source_ref));
  }

  /** 投稿まで進んだ定期・event の素材の題 (直近の話題の減点に使う)。 */
  recentPostedTitles(ruleId: string, sinceSec: number): Array<{ title: string; created_at: number }> {
    const rows = this.db
      .prepare(
        `SELECT json_extract(material_snapshot, '$.title') AS title, created_at FROM rule_runs
          WHERE rule_id = ? AND created_at >= ? AND action_kind IN ('pick', 'event') AND material_snapshot IS NOT NULL
            AND json_valid(material_snapshot) AND status IN ('delivery_pending', 'delivered', 'delivery_unknown')
          ORDER BY created_at DESC LIMIT 100`,
      )
      .all(ruleId, sinceSec) as Array<{ title: string | null; created_at: number }>;
    return rows.filter((r): r is { title: string; created_at: number } => typeof r.title === "string" && r.title !== "");
  }

  /** lease が切れた投稿前の run (再起動・クラッシュの取り残し)。 */
  listStale(nowSec: number): RuleRunRow[] {
    const placeholders = IN_FLIGHT_STATUSES.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM rule_runs WHERE status IN (${placeholders}) AND (lease_until IS NULL OR lease_until < ?) ORDER BY created_at`)
      .all(...IN_FLIGHT_STATUSES, nowSec) as RuleRunRow[];
  }

  /** 取り残し run の所有権を引き継ぐ (前の lease が切れている時だけ)。 */
  adopt(runId: string, leaseOwner: string, leaseUntil: number, nowSec: number): boolean {
    const r = this.db
      .prepare(
        `UPDATE rule_runs SET lease_owner = ?, lease_until = ?, updated_at = ?
         WHERE run_id = ? AND (lease_until IS NULL OR lease_until < ?)`,
      )
      .run(leaseOwner, leaseUntil, nowSec, runId, nowSec);
    return Number(r.changes ?? 0) > 0;
  }

  /** 配達の照合対象。 delivery_unknown も 1 日は照合を続け、 記録が見つかった時だけ delivered へ進める。 */
  listAwaitingDelivery(nowSec: number): RuleRunRow[] {
    return this.db
      .prepare(
        `SELECT * FROM rule_runs
         WHERE status = 'delivery_pending' OR (status = 'delivery_unknown' AND updated_at >= ?)
         ORDER BY updated_at`,
      )
      .all(nowSec - 86400) as RuleRunRow[];
  }

  /** rule 無効化時、 投稿前の run を止める (生成済み本文は残す)。 */
  cancelInFlight(ruleId: string, reason: string, nowSec: number): number {
    const r = this.db
      .prepare(
        `UPDATE rule_runs SET status = 'skipped', reason = ?, updated_at = ?
         WHERE rule_id = ? AND status IN ('claimed', 'material_selected')`,
      )
      .run(reason, nowSec, ruleId);
    return Number(r.changes ?? 0);
  }
}

function parseCursor(raw: string | null | undefined): { createdAt: number; runId: string } | null {
  if (!raw) return null;
  const idx = raw.indexOf(":");
  if (idx <= 0) return null;
  const createdAt = Number(raw.slice(0, idx));
  const runId = raw.slice(idx + 1);
  return Number.isInteger(createdAt) && runId ? { createdAt, runId } : null;
}
