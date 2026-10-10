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

/** 確定した人間の本人性。 Discord の操作から取る (bot / webhook は確定できない)。 */
export interface GoalConfirmer {
  platform: "discord";
  userId: string;
  guildId: string;
  channelId: string;
  messageId?: string;
}

export type DailyGoalStatus = "confirmed" | "running" | "achieved" | "exhausted" | "stopped" | "lost";

/** 起動の結果。 unknown は「起動を要求したが結果を確認できていない」 (CC-INV-03)。 */
export type LaunchState = "none" | "intent" | "launched" | "unknown";

export type StopReason = "goal_reached" | "exhausted" | "human_stop" | "session_lost";

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
  /** 「やり切り」で認めた残り。 翌朝の候補の材料 (自動でゴールにはしない、CC-DG-INV-08)。 */
  remaining?: RemainingItem[];
  createdAt: number;
}

/** 確定前の入力。 欠けがあれば確定しない。 */
export interface GoalDraft {
  project?: string | null;
  repoPath?: string | null;
  goalText?: string | null;
  acceptance?: readonly string[] | null;
  actioTaskIds?: readonly string[] | null;
  permissions?: Partial<Record<PermissionKey, boolean | null | undefined>> | null;
}

export type DraftField = "project" | "goalText" | "acceptance" | "actioTaskIds" | PermissionKey;

export const DRAFT_FIELD_LABELS: Record<DraftField, string> = {
  project: "プロジェクト",
  goalText: "ゴール文",
  acceptance: "受入条件 (1 件以上)",
  actioTaskIds: "対応する Actio task (1 件以上)",
  merge: "許可範囲: マージの可否",
  test: "許可範囲: テストの可否",
  service: "許可範囲: サービス操作の可否",
  deploy: "許可範囲: 反映の可否",
};

/** 確定・停止を行う操作者。 role は社員名簿の役職 (未登録は null = ヒラ社員相当)。 */
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

export type CheckpointKind = "progress" | "completion" | "skipped_waiting";

/** 確認への判断。 go = 続行、 reached / exhausted = 止まる、 waiting = 回答待ち。 */
export type CheckpointDecision = "go" | "reached" | "exhausted" | "waiting" | "pending";

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

/** ゴール候補 (案)。 人間が確定するまでゴールではない (CC-DG-INV-01)。 */
export interface GoalCandidate {
  id: string;
  date: string;
  project: string;
  repoPath: string;
  suggestedGoal: string;
  suggestedAcceptance: string[];
  actioTaskIds: string[];
  actioTasks: Array<{ id: string; title: string; status: string; dueAt: string | null }>;
  carryover: Array<{ goalId: string; item: string; class: RemainingItem["class"]; reason?: string }>;
  continuing: Array<{ goalId: string; goalText: string }>;
  createdAt: number;
}

export class DailyGoalConflict extends Error {
  constructor(message: string, readonly code: string = "conflict") {
    super(message);
    this.name = "DailyGoalConflict";
  }
}
