/**
 * デイリーゴール (WM-2) の業務用語と状態。
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

/**
 * running = 見守り中 (登録した時点から)。 deadline = 締切 (翌朝の業務日境界) で止めた。
 * confirmed / exhausted / lost は 2026-10-14 より前の旧方式 (専用セッション) の行だけが持つ。
 */
export type DailyGoalStatus = "confirmed" | "running" | "achieved" | "exhausted" | "stopped" | "deadline" | "lost";

/** 見守り中として確認・締切の対象にする状態 (旧方式の confirmed を含む)。 */
export const ACTIVE_GOAL_STATUSES = ["confirmed", "running"] as const satisfies readonly DailyGoalStatus[];

export function isActiveGoal(goal: Pick<DailyGoal, "status">): boolean {
  return goal.status === "confirmed" || goal.status === "running";
}

/** exhausted / session_lost は旧方式の記録だけが持つ。 */
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
  /** 旧方式で紐付いた専用セッション。 証跡の branch を引くためだけに読む (新方式では持たない)。 */
  sessionId?: string;
  stopReason?: StopReason;
  stoppedBy?: string;
  /** 旧方式の「やり切り」で認めた残り。 日のまとめに載せる (翌日のゴールには自動でしない、CC-DG-INV-08)。 */
  remaining?: RemainingItem[];
  /** 登録元の投稿 (message id)。 同じ投稿から 2 件目を作らない (CC-DG-INV-02)。 */
  sourceMessageId?: string;
  /** 受入条件ごとに Cc が実在を確かめた証跡の参照 (到達の照合・締切停止の記録)。 */
  acceptanceProgress?: Record<string, string[]>;
  /** 不調の続き具合 (CC-DG-INV-12)。 続いている不調の始まりと、 その不調で通知した回数。 */
  alertStreakSince?: number;
  alertCount: number;
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

/** 判定の状態。 behind / stalled が「不調」 (通知の対象)。 */
export type ProgressVerdict = "on_track" | "behind" | "stalled";

export const PROGRESS_VERDICTS = ["on_track", "behind", "stalled"] as const satisfies readonly ProgressVerdict[];

export const VERDICT_LABELS: Record<ProgressVerdict, string> = {
  on_track: "順調",
  behind: "遅れ気味",
  stalled: "停滞",
};

/** 受入条件ごとの到達見込み。 reached は Cc が集めた証跡の根拠があるときだけ残る。 */
export type AcceptanceOutlook = "reached" | "likely" | "at_risk" | "unlikely";

export const ACCEPTANCE_OUTLOOKS = ["reached", "likely", "at_risk", "unlikely"] as const satisfies readonly AcceptanceOutlook[];

export const OUTLOOK_LABELS: Record<AcceptanceOutlook, string> = {
  reached: "到達",
  likely: "見込みあり",
  at_risk: "危うい",
  unlikely: "見込みなし",
};

export interface AcceptanceJudgment {
  item: string;
  outlook: AcceptanceOutlook;
  /** 根拠の証跡キー。 Cc が集めた証跡に実在するものだけ。 */
  refs: string[];
}

/** 1 回限りの判定を正規化したもの。 */
export interface ProgressJudgment {
  verdict: ProgressVerdict;
  reason: string;
  acceptance: AcceptanceJudgment[];
}

/**
 * judgment = ワンショット判定、 judge_failed = 判定できず、 deadline = 締切で止める直前に集めた最後の証跡。
 * progress / completion / skipped_waiting は旧方式の記録。
 */
export type CheckpointKind = "judgment" | "judge_failed" | "deadline" | "progress" | "completion" | "skipped_waiting";

/** 確認への判断。 go = 見守りを続ける、 reached = 到達で止める。 それ以外は旧方式の記録。 */
export type CheckpointDecision = "go" | "reached" | "exhausted" | "waiting" | "pending" | "deadline";

export interface DailyGoalCheckpoint {
  id: string;
  goalId: string;
  at: number;
  kind: CheckpointKind;
  evidence: EvidenceSnapshot;
  progress: boolean;
  /** 旧方式のセッションの報告、 または判定できなかった理由。 */
  report: string | null;
  decision: CheckpointDecision;
  /** kind=judgment の判定。 */
  judgment: ProgressJudgment | null;
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
