/**
 * 不調の通知の保存 (intent と配達状態)。
 *
 * @implements spec/feature/daily-goal-run.md — 5. 不調の通知 / CC-DG-INV-12 / CC-INV-03
 *
 * 通知は行を先に保存してから配達する。 配達側は claim (intent) してから送り、 明確な拒否のときだけ
 * intent を戻して再試行する。 結果不明 (unknown) は再送しない。 文面は判定の時点の写しを持つ。
 */

import type { Database } from "better-sqlite3";
import type { ProgressVerdict } from "./domain.js";

export type AlertDeliveryStatus = "pending" | "unknown" | "sent" | "failed";

export interface DailyGoalAlert {
  id: string;
  goalId: string;
  at: number;
  kind: "first" | "repeat";
  verdict: ProgressVerdict;
  /** 通知の本文 (mention を含まない)。 */
  text: string;
  /** mention する投稿者 (allowedMentions に入れる 1 人)。 */
  mentionUserId: string;
  status: AlertDeliveryStatus;
  messageId: string | null;
  lastError: string | null;
}

interface AlertRow {
  id: string; goal_id: string; at: number; kind: DailyGoalAlert["kind"]; verdict: ProgressVerdict; text: string;
  mention_user_id: string; status: AlertDeliveryStatus; message_id: string | null; last_error: string | null;
}

const RETRY_MS = 60_000;

export class DailyGoalAlertRepository {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS daily_goal_alerts (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, verdict TEXT NOT NULL,
      text TEXT NOT NULL, mention_user_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', intent INTEGER NOT NULL DEFAULT 0,
      message_id TEXT, last_error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0
    ); CREATE INDEX IF NOT EXISTS daily_goal_alerts_goal ON daily_goal_alerts(goal_id, at);`);
  }

  private decode(raw: unknown): DailyGoalAlert {
    const r = raw as AlertRow;
    return { id: r.id, goalId: r.goal_id, at: r.at, kind: r.kind, verdict: r.verdict, text: r.text, mentionUserId: r.mention_user_id,
      status: r.status, messageId: r.message_id, lastError: r.last_error };
  }

  add(alert: Pick<DailyGoalAlert, "id" | "goalId" | "at" | "kind" | "verdict" | "text" | "mentionUserId">): void {
    this.db.prepare("INSERT OR IGNORE INTO daily_goal_alerts (id,goal_id,at,kind,verdict,text,mention_user_id) VALUES (?,?,?,?,?,?,?)")
      .run(alert.id, alert.goalId, alert.at, alert.kind, alert.verdict, alert.text.slice(0, 1500), alert.mentionUserId);
  }

  byGoal(goalId: string): DailyGoalAlert[] {
    return this.db.prepare("SELECT * FROM daily_goal_alerts WHERE goal_id=? ORDER BY at, rowid").all(goalId).map((r) => this.decode(r));
  }

  /** 配達待ち (未送信・再試行の時刻を過ぎた失敗)。 */
  pending(now: number): DailyGoalAlert[] {
    return this.db.prepare(`SELECT * FROM daily_goal_alerts WHERE status IN ('pending','failed') AND intent=0 AND next_attempt_at<=?
      ORDER BY rowid LIMIT 20`).all(now).map((r) => this.decode(r));
  }

  /** 送る直前の intent。 1 回だけ通る (以後の結果不明は再送しない)。 */
  claim(id: string): boolean {
    return this.db.prepare("UPDATE daily_goal_alerts SET intent=1, status='unknown' WHERE id=? AND intent=0 AND status IN ('pending','failed')")
      .run(id).changes === 1;
  }

  sent(id: string, messageId: string): void {
    this.db.prepare("UPDATE daily_goal_alerts SET status='sent', message_id=?, last_error=NULL WHERE id=?").run(messageId, id);
  }

  /** Discord が明確に拒否した (作られていない) ときだけ intent を戻し、 後で再試行する。 */
  rejected(id: string, error: string, now: number): void {
    this.db.prepare("UPDATE daily_goal_alerts SET intent=0, status='failed', last_error=?, next_attempt_at=? WHERE id=? AND message_id IS NULL")
      .run(error.slice(0, 2000), now + RETRY_MS, id);
  }

  /** 結果不明。 unknown のまま残し、 再送しない。 */
  unknownResult(id: string, error: string): void {
    this.db.prepare("UPDATE daily_goal_alerts SET status='unknown', last_error=? WHERE id=?").run(error.slice(0, 2000), id);
  }
}
