/**
 * デイリーゴール自走 (WM-2) の業務用語と状態。
 *
 * @implements spec/feature/daily-goal-run.md — 用語 / 状態の所有者
 *
 * 型だけを持つ。 判断は *-policy.ts、 手順は service.ts、 保存は repository.ts。
 */

/** その日のうちに AI が実行してよい操作。 確定時に人間が明示したものだけ (CC-DG-INV-04)。 */
export interface GoalPermissions {
  merge: boolean;
  test: boolean;
  service: boolean;
  deploy: boolean;
}

export const PERMISSION_KEYS = ["merge", "test", "service", "deploy"] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];

export const PERMISSION_LABELS: Record<PermissionKey, string> = {
  merge: "マージ",
  test: "テスト",
  service: "サービス操作",
  deploy: "反映",
};

/** 登録した人間の本人性。 デイリーゴールチャンネルの投稿から取る (bot / webhook は登録できない)。 */
export interface GoalConfirmer {
  platform: "discord";
  userId: string;
  guildId: string;
  channelId: string;
  messageId?: string;
}

/** confirmed = 登録済み・起動前。 deadline = 締切 (翌朝の業務日境界) で止めた。 */
export type DailyGoalStatus = "confirmed" | "running" | "achieved" | "exhausted" | "stopped" | "deadline" | "lost";

/** 起動の結果。 unknown は「起動を要求したが結果を確認できていない」 (CC-INV-03)。 */
export type LaunchState = "none" | "intent" | "launched" | "unknown";

export type StopReason = "goal_reached" | "exhausted" | "human_stop" | "deadline" | "session_lost";

export interface DailyGoal {
  id: string;
  /** ローカル日付 YYYY-MM-DD。 */
  date: string;
  project: string;
  repoPath: string;
  goalText: string;
  acceptance: string[];
  actioTaskIds: string[];
  permissions: GoalPermissions;
  confirmedBy: GoalConfirmer;
  confirmedAt: number;
  status: DailyGoalStatus;
  sessionId?: string;
  runId?: string;
  launchState: LaunchState;
  launchedAt?: number;
  launchError?: string;
  nextLaunchAt?: number;
  stopReason?: StopReason;
  stoppedBy?: string;
  /** 「やり切り」で認めた残り。 日のまとめに載せる (翌日のゴールには自動でしない、CC-DG-INV-08)。 */
  remaining?: RemainingItem[];
  /** 登録元の投稿 (message id)。 同じ投稿から 2 件目を作らない (CC-DG-INV-02)。 */
  sourceMessageId?: string;
  /** 受入条件ごとに Cc が実在を確かめた証跡の参照 (到達の照合・締切停止の記録)。 */
  acceptanceProgress?: Record<string, string[]>;
  createdAt: number;
}

/** 投稿から読み取ったもの。 quotes は各項目の根拠となる本文の引用 (extraction-guard が検査する)。 */
export interface ExtractedGoal {
  project?: string;
  goalText?: string;
  acceptance: string[];
  permissions: GoalPermissions;
  actioTaskIds: string[];
  /** キーは `project` / `goalText` / `acceptance.<n>` / `permissions.<key>`。 */
  quotes: Record<string, string>;
}

/** 登録に要る 3 項目。 どれかが欠ければ下書きにする (CC-DG-INV-01 / CC-DG-INV-09)。 */
export type PostField = "project" | "goal" | "acceptance";

export const POST_FIELD_LABELS: Record<PostField, string> = {
  project: "プロジェクト",
  goal: "ゴール (その日に達成すること)",
  acceptance: "受入条件 (何がそろったら達成か)",
};

export type DraftStatus = "open" | "registered" | "expired";

/** 投稿から読み取ったが登録に足りないもの。 聞き返しのスレッドで埋める。 */
export interface DailyGoalDraft {
  id: string;
  businessDate: string;
  sourceMessageId: string;
  authorUserId: string;
  guildId: string;
  channelId: string;
  threadId?: string;
  /** 元投稿と、 聞き返しスレッドでの元投稿者の返信 (順に)。 */
  textParts: string[];
  extracted: ExtractedGoal | null;
  missing: PostField[];
  status: DraftStatus;
  goalId?: string;
  createdAt: number;
  updatedAt: number;
}

export type ReminderState = "none" | "queued" | "posted";
export type CloseState = "none" | "stopping" | "summarized" | "journaled" | "posted" | "skipped";
/** Memoria への記載の状態。 intent / unknown は結果不明で、 照合してから再送する (CC-INV-03)。 */
export type JournalState = "none" | "intent" | "unknown" | "written" | "unwritten" | "skipped";

/** 業務日ごとの目標なし・9:00 の通知・4:00 のまとめと記載の状態。 */
export interface DailyGoalDay {
  businessDate: string;
  noGoalBy?: string;
  noGoalAt?: number;
  reminderState: ReminderState;
  reminderMessageId?: string;
  summaryTitle?: string;
  summaryMarkdown?: string;
  closeState: CloseState;
  diaryState: JournalState;
  noteState: JournalState;
  diaryUrl?: string;
  noteId?: string;
  noteUrl?: string;
  error?: string;
  nextAttemptAt: number;
  updatedAt: number;
}

/** 登録・停止・再送を行う操作者。 role は社員名簿の役職 (未登録は null = ヒラ社員相当)。 */
export interface GoalActor {
  platform: "discord";
  userId: string;
  guildId: string;
  channelId: string;
  messageId?: string;
  isBot: boolean;
  isWebhook: boolean;
  role: "staff" | "manager" | "executive" | null;
}

/** 証跡 1 件。 key は安定 ID (例 `commit:<sha>` / `pr:<origin>#12:merged` / `actio:<id>:done`)。 */
export interface EvidenceItem {
  key: string;
  kind: "commit" | "pr" | "revisor" | "actio";
  summary: string;
  at: number | null;
}

/** Cc が集めた証跡と、 Actio task の状態のスナップショット。 */
export interface EvidenceSnapshot {
  items: EvidenceItem[];
  /** taskId → 状態 (pending / delegated / done / cancelled / unknown)。 */
  taskStatuses: Record<string, string>;
  /** 収集できなかった情報源 (結果不明を空の成功にしない)。 */
  unavailable: string[];
}

/** deadline = 締切で止める直前に集めた最後の証跡。 */
export type CheckpointKind = "progress" | "completion" | "skipped_waiting" | "deadline";

/** 確認への判断。 go = 続行、 reached / exhausted = 止まる、 waiting = 回答待ち。 */
export type CheckpointDecision = "go" | "reached" | "exhausted" | "waiting" | "pending" | "deadline";

export interface DailyGoalCheckpoint {
  id: string;
  goalId: string;
  at: number;
  kind: CheckpointKind;
  evidence: EvidenceSnapshot;
  progress: boolean;
  report: string | null;
  decision: CheckpointDecision;
}

export type RemainingItem =
  | { item: string; class: "unachievable"; reason: string }
  | { item: string; class: "human_judgment"; questionId?: number; humanWait?: boolean }
  | { item: string; class: "doable"; note?: string };

export class DailyGoalConflict extends Error {
  constructor(message: string, readonly code: string = "conflict") {
    super(message);
    this.name = "DailyGoalConflict";
  }
}
