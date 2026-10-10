/**
 * デイリーゴールの Cc 所有の永続化。
 *
 * @implements spec/feature/daily-goal-run.md — 状態の所有者 / CC-DG-INV-02 / CC-INV-03
 *
 * 起動とカード投稿は intent を先に保存してから外部副作用を起こす。 結果不明は
 * 照合で解消し、 同じ起動・同じ投稿を再送しない。 状態遷移は CAS (WHERE 句) で守る。
 */

import type { Database } from "better-sqlite3";
import type {
  CheckpointDecision,
  DailyGoal,
  DailyGoalCheckpoint,
  DailyGoalStatus,
  LaunchState,
  RemainingItem,
  StopReason,
} from "./domain.js";

interface GoalRow {
  id: string; date: string; project: string; repo_path: string; goal_text: string; acceptance: string;
  actio_task_ids: string; permissions: string; confirmed_by: string; confirmed_at: number; status: DailyGoalStatus;
  session_id: string | null; run_id: string | null; launch_state: LaunchState; launched_at: number | null;
  launch_error: string | null; next_launch_at: number | null; stop_reason: StopReason | null; stopped_by: string | null;
  remaining: string | null; source_message_id: string | null; acceptance_progress: string | null; created_at: number;
}

export interface DailyGoalCard {
  id: string;
  /** goal = ゴールごとのカード、 reminder = 9:00 の通知、 summary = 4:00 のまとめ。 refId は goal id か業務日。 */
  kind: "goal" | "reminder" | "summary";
  refId: string;
  revision: number;
  deliveredRevision: number;
  channelId: string | null;
  messageId: string | null;
  intent: boolean;
  deliveryStatus: "pending" | "delivered" | "unknown" | "failed";
  lastError: string | null;
}

export interface TimelineEntry { at: number; text: string }

const ACTIVE = "('confirmed','running')";

export class DailyGoalRepository {
  constructor(private readonly db: Database) {
    db.exec(`CREATE TABLE IF NOT EXISTS daily_goals (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, project TEXT NOT NULL, repo_path TEXT NOT NULL, goal_text TEXT NOT NULL,
      acceptance TEXT NOT NULL, actio_task_ids TEXT NOT NULL, permissions TEXT NOT NULL, confirmed_by TEXT NOT NULL,
      confirmed_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed', session_id TEXT, run_id TEXT,
      launch_state TEXT NOT NULL DEFAULT 'none', launched_at INTEGER, launch_error TEXT, next_launch_at INTEGER,
      stop_reason TEXT, stopped_by TEXT, remaining TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS daily_goals_date ON daily_goals(date);
    CREATE INDEX IF NOT EXISTS daily_goals_status ON daily_goals(status);
    CREATE TABLE IF NOT EXISTS daily_goal_checkpoints (
      id TEXT PRIMARY KEY, goal_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, evidence TEXT NOT NULL,
      progress INTEGER NOT NULL DEFAULT 0, report TEXT, decision TEXT NOT NULL DEFAULT 'pending'
    ); CREATE INDEX IF NOT EXISTS daily_goal_checkpoints_goal ON daily_goal_checkpoints(goal_id, at);
    CREATE TABLE IF NOT EXISTS daily_goal_timeline (
      id INTEGER PRIMARY KEY AUTOINCREMENT, goal_id TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS daily_goal_timeline_goal ON daily_goal_timeline(goal_id, id);
    CREATE TABLE IF NOT EXISTS daily_goal_cards (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL, ref_id TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      delivered_revision INTEGER NOT NULL DEFAULT 0, channel_id TEXT, message_id TEXT, intent INTEGER NOT NULL DEFAULT 0,
      delivery_status TEXT NOT NULL DEFAULT 'pending', last_error TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0
    ); CREATE TABLE IF NOT EXISTS daily_goal_candidates (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, project TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
    );`);
    // 候補 (daily_goal_candidates) は撤廃したが、 既存のデータは消さない (新規に書かないだけ)。
    const columns = new Set((db.prepare("PRAGMA table_info(daily_goals)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!columns.has("source_message_id")) db.exec("ALTER TABLE daily_goals ADD COLUMN source_message_id TEXT");
    if (!columns.has("acceptance_progress")) db.exec("ALTER TABLE daily_goals ADD COLUMN acceptance_progress TEXT");
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS daily_goals_source_message ON daily_goals(source_message_id) WHERE source_message_id IS NOT NULL");
  }

  private decode(raw: unknown): DailyGoal | null {
    if (!raw) return null;
    const r = raw as GoalRow;
    return {
      id: r.id, date: r.date, project: r.project, repoPath: r.repo_path, goalText: r.goal_text,
      acceptance: JSON.parse(r.acceptance) as string[], actioTaskIds: JSON.parse(r.actio_task_ids) as string[],
      permissions: JSON.parse(r.permissions), confirmedBy: JSON.parse(r.confirmed_by), confirmedAt: r.confirmed_at,
      status: r.status, launchState: r.launch_state, createdAt: r.created_at,
      ...(r.session_id ? { sessionId: r.session_id } : {}),
      ...(r.run_id ? { runId: r.run_id } : {}),
      ...(r.launched_at !== null ? { launchedAt: r.launched_at } : {}),
      ...(r.launch_error ? { launchError: r.launch_error } : {}),
      ...(r.next_launch_at !== null ? { nextLaunchAt: r.next_launch_at } : {}),
      ...(r.stop_reason ? { stopReason: r.stop_reason } : {}),
      ...(r.stopped_by ? { stoppedBy: r.stopped_by } : {}),
      ...(r.remaining ? { remaining: JSON.parse(r.remaining) as RemainingItem[] } : {}),
      ...(r.source_message_id ? { sourceMessageId: r.source_message_id } : {}),
      ...(r.acceptance_progress ? { acceptanceProgress: JSON.parse(r.acceptance_progress) as Record<string, string[]> } : {}),
    };
  }

  /** 同じ id (登録元の投稿由来) の再送は既存行を返す。 同じ投稿から 2 件目は作らない (CC-DG-INV-02)。 */
  create(goal: Omit<DailyGoal, "status" | "launchState">): { goal: DailyGoal; created: boolean } {
    const existing = goal.sourceMessageId ? this.bySourceMessage(goal.sourceMessageId) : null;
    if (existing) return { goal: existing, created: false };
    const info = this.db.prepare(`INSERT OR IGNORE INTO daily_goals (id,date,project,repo_path,goal_text,acceptance,actio_task_ids,
      permissions,confirmed_by,confirmed_at,status,launch_state,source_message_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,'confirmed','none',?,?,?)`).run(
      goal.id, goal.date, goal.project, goal.repoPath, goal.goalText, JSON.stringify(goal.acceptance), JSON.stringify(goal.actioTaskIds),
      JSON.stringify(goal.permissions), JSON.stringify(goal.confirmedBy), goal.confirmedAt, goal.sourceMessageId ?? null, goal.createdAt, goal.createdAt);
    return { goal: this.byId(goal.id)!, created: info.changes === 1 };
  }

  bySourceMessage(messageId: string): DailyGoal | null {
    return this.decode(this.db.prepare("SELECT * FROM daily_goals WHERE source_message_id=?").get(messageId));
  }

  byId(id: string): DailyGoal | null { return this.decode(this.db.prepare("SELECT * FROM daily_goals WHERE id=?").get(id)); }
  list(opts: { date?: string; limit?: number } = {}): DailyGoal[] {
    const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
    const rows = opts.date
      ? this.db.prepare("SELECT * FROM daily_goals WHERE date=? ORDER BY created_at DESC LIMIT ?").all(opts.date, limit)
      : this.db.prepare("SELECT * FROM daily_goals ORDER BY created_at DESC LIMIT ?").all(limit);
    return rows.map((r) => this.decode(r)!);
  }
  listByStatus(statuses: readonly DailyGoalStatus[]): DailyGoal[] {
    if (statuses.length === 0) return [];
    return this.db.prepare(`SELECT * FROM daily_goals WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at LIMIT 500`)
      .all(...statuses).map((r) => this.decode(r)!);
  }
  bySession(sessionId: string): DailyGoal[] {
    return this.db.prepare(`SELECT * FROM daily_goals WHERE session_id=? AND status IN ${ACTIVE}`).all(sessionId).map((r) => this.decode(r)!);
  }
  /** 業務日のゴール (登録順)。 */
  onDate(date: string): DailyGoal[] {
    return this.db.prepare("SELECT * FROM daily_goals WHERE date=? ORDER BY created_at LIMIT 500").all(date).map((r) => this.decode(r)!);
  }

  /** 受入条件ごとに Cc が実在を確かめた証跡の参照を記録する (到達の照合のたびに上書き)。 */
  setAcceptanceProgress(id: string, progress: Record<string, string[]>, now: number): void {
    this.db.prepare("UPDATE daily_goals SET acceptance_progress=?, updated_at=? WHERE id=?").run(JSON.stringify(progress), now, id);
  }

  /** 起動の intent を先に保存する。 確定済み・未起動のゴールだけが 1 回だけ通る。 */
  claimLaunch(id: string, runId: string, now: number): boolean {
    return this.db.prepare(`UPDATE daily_goals SET launch_state='intent', run_id=?, launch_error=NULL, updated_at=?
      WHERE id=? AND status='confirmed' AND launch_state='none'`).run(runId, now, id).changes === 1;
  }
  markLaunched(id: string, runId: string, now: number): boolean {
    return this.db.prepare(`UPDATE daily_goals SET launch_state='launched', status='running', run_id=?, launched_at=?, launch_error=NULL, updated_at=?
      WHERE id=? AND status='confirmed' AND launch_state IN ('intent','unknown')`).run(runId, now, now, id).changes === 1;
  }
  markLaunchUnknown(id: string, error: string, now: number): void {
    this.db.prepare(`UPDATE daily_goals SET launch_state='unknown', launch_error=?, updated_at=? WHERE id=? AND launch_state='intent'`)
      .run(error.slice(0, 2000), now, id);
  }
  /** 起動しなかったことが確定した (run が作られていない) ときだけ intent を戻す。 */
  releaseLaunch(id: string, error: string, nextAt: number, now: number): void {
    this.db.prepare(`UPDATE daily_goals SET launch_state='none', run_id=NULL, launch_error=?, next_launch_at=?, updated_at=?
      WHERE id=? AND status='confirmed' AND launch_state='intent'`).run(error.slice(0, 2000), nextAt, now, id);
  }
  bindSession(id: string, sessionId: string, now: number): boolean {
    return this.db.prepare(`UPDATE daily_goals SET session_id=?, updated_at=? WHERE id=? AND session_id IS NULL AND status='running'`)
      .run(sessionId, now, id).changes === 1;
  }
  /** 終了の CAS。 既に終わったゴールは変えない。 */
  finish(id: string, input: { status: Exclude<DailyGoalStatus, "confirmed" | "running">; reason: StopReason; by?: string | null; remaining?: RemainingItem[]; now: number }): boolean {
    return this.db.prepare(`UPDATE daily_goals SET status=?, stop_reason=?, stopped_by=?, remaining=?, updated_at=? WHERE id=? AND status IN ${ACTIVE}`)
      .run(input.status, input.reason, input.by ?? null, input.remaining ? JSON.stringify(input.remaining) : null, input.now, id).changes === 1;
  }

  addCheckpoint(cp: DailyGoalCheckpoint): void {
    this.db.prepare("INSERT OR IGNORE INTO daily_goal_checkpoints (id,goal_id,at,kind,evidence,progress,report,decision) VALUES (?,?,?,?,?,?,?,?)")
      .run(cp.id, cp.goalId, cp.at, cp.kind, JSON.stringify(cp.evidence), cp.progress ? 1 : 0, cp.report, cp.decision);
  }
  private decodeCheckpoint(raw: unknown): DailyGoalCheckpoint {
    const r = raw as { id: string; goal_id: string; at: number; kind: DailyGoalCheckpoint["kind"]; evidence: string; progress: number; report: string | null; decision: CheckpointDecision };
    return { id: r.id, goalId: r.goal_id, at: r.at, kind: r.kind, evidence: JSON.parse(r.evidence), progress: !!r.progress, report: r.report, decision: r.decision };
  }
  checkpoints(goalId: string): DailyGoalCheckpoint[] {
    return this.db.prepare("SELECT * FROM daily_goal_checkpoints WHERE goal_id=? ORDER BY at, rowid").all(goalId).map((r) => this.decodeCheckpoint(r));
  }
  lastCheckpoint(goalId: string, kinds?: readonly DailyGoalCheckpoint["kind"][]): DailyGoalCheckpoint | null {
    const where = kinds?.length ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : "";
    const r = this.db.prepare(`SELECT * FROM daily_goal_checkpoints WHERE goal_id=?${where} ORDER BY at DESC, rowid DESC LIMIT 1`).get(goalId, ...(kinds ?? []));
    return r ? this.decodeCheckpoint(r) : null;
  }
  /** 確認への判断を 1 回だけ記録する (pending → 決定)。 */
  decideCheckpoint(id: string, decision: CheckpointDecision, report: string | null): boolean {
    return this.db.prepare("UPDATE daily_goal_checkpoints SET decision=?, report=COALESCE(?, report) WHERE id=? AND decision='pending'")
      .run(decision, report, id).changes === 1;
  }

  setCheckpointReport(id: string, report: string): void {
    this.db.prepare("UPDATE daily_goal_checkpoints SET report=? WHERE id=?").run(report, id);
  }

  addTimeline(goalId: string, at: number, text: string): void {
    this.db.prepare("INSERT INTO daily_goal_timeline (goal_id,at,text) VALUES (?,?,?)").run(goalId, at, text.slice(0, 300));
  }
  timeline(goalId: string, limit = 20): TimelineEntry[] {
    return (this.db.prepare("SELECT at, text FROM daily_goal_timeline WHERE goal_id=? ORDER BY id DESC LIMIT ?").all(goalId, limit) as TimelineEntry[]).reverse();
  }

  /** カードの版を上げる (無ければ作る)。 配達側が同じ message を編集して追いつく。 */
  touchCard(id: string, kind: DailyGoalCard["kind"], refId: string): void {
    this.db.prepare(`INSERT INTO daily_goal_cards (id,kind,ref_id) VALUES (?,?,?)
      ON CONFLICT(id) DO UPDATE SET revision=revision+1, delivery_status=CASE WHEN delivery_status='unknown' THEN 'unknown' ELSE 'pending' END`).run(id, kind, refId);
  }
  private decodeCard(raw: unknown): DailyGoalCard {
    const r = raw as { id: string; kind: DailyGoalCard["kind"]; ref_id: string; revision: number; delivered_revision: number; channel_id: string | null; message_id: string | null; intent: number; delivery_status: DailyGoalCard["deliveryStatus"]; last_error: string | null };
    return { id: r.id, kind: r.kind, refId: r.ref_id, revision: r.revision, deliveredRevision: r.delivered_revision, channelId: r.channel_id,
      messageId: r.message_id, intent: !!r.intent, deliveryStatus: r.delivery_status, lastError: r.last_error };
  }
  card(id: string): DailyGoalCard | null { const r = this.db.prepare("SELECT * FROM daily_goal_cards WHERE id=?").get(id); return r ? this.decodeCard(r) : null; }
  cardByMessage(messageId: string): DailyGoalCard | null { const r = this.db.prepare("SELECT * FROM daily_goal_cards WHERE message_id=?").get(messageId); return r ? this.decodeCard(r) : null; }
  pendingCards(now: number): DailyGoalCard[] {
    return this.db.prepare(`SELECT * FROM daily_goal_cards WHERE delivered_revision<revision AND delivery_status IN ('pending','failed')
      AND next_attempt_at<=? ORDER BY rowid LIMIT 50`).all(now).map((r) => this.decodeCard(r));
  }
  /** 新規投稿の intent。 既に投稿 (または投稿を試みた) カードは通らない。 */
  claimCard(id: string, channelId: string): boolean {
    return this.db.prepare("UPDATE daily_goal_cards SET intent=1, channel_id=?, delivery_status='unknown' WHERE id=? AND intent=0 AND message_id IS NULL")
      .run(channelId, id).changes === 1;
  }
  saveCard(id: string, revision: number, channelId: string, messageId: string): void {
    this.db.prepare(`UPDATE daily_goal_cards SET channel_id=?, message_id=?, delivered_revision=MAX(delivered_revision, ?),
      delivery_status=CASE WHEN revision<=? THEN 'delivered' ELSE 'pending' END, last_error=NULL WHERE id=?`).run(channelId, messageId, revision, revision, id);
  }
  /** Discord が明確に拒否した (作られていない) ときだけ intent を戻す。 */
  cardRejected(id: string, error: string, now: number): void {
    this.db.prepare(`UPDATE daily_goal_cards SET intent=CASE WHEN message_id IS NULL THEN 0 ELSE intent END, delivery_status='failed',
      last_error=?, next_attempt_at=? WHERE id=?`).run(error.slice(0, 2000), now + 60_000, id);
  }
  cardUnknown(id: string, error: string): void {
    this.db.prepare("UPDATE daily_goal_cards SET delivery_status='unknown', last_error=? WHERE id=?").run(error.slice(0, 2000), id);
  }
  /** 結果不明の新規投稿 (intent=1, message 未保存) を照合待ちとして返す。 */
  unknownCards(): DailyGoalCard[] {
    return this.db.prepare("SELECT * FROM daily_goal_cards WHERE delivery_status='unknown' AND message_id IS NULL AND intent=1 ORDER BY rowid LIMIT 20")
      .all().map((r) => this.decodeCard(r));
  }
}
