/**
 * daily-goal-run の use case が要求する小さな port。
 *
 * @implements spec/feature/daily-goal-run.md — 状態の所有者 (起動 = agent-delegation / 自走 = autonomous-continuation)
 *
 * 実装 (DB・delegation service・event bus・社員名簿・Actio) は composition root が組み立てる。
 * 他ドメインの状態はここを通してだけ読み書きし、 DB 行を直接更新しない。
 */

import type { DailyGoalConfig } from "./config.js";
import type { EvidencePort } from "./evidence.js";
import type { GoalExtractionPort } from "./goal-extraction.js";
import type { MemoriaJournalPort } from "./memoria-journal.js";

export interface DailyGoalLaunchInput {
  runId: string;
  goalId: string;
  args: Record<string, string>;
  cwd: string;
  project: string;
  requesterDiscordUserId: string;
  sourceGuildId: string;
  sourceChannelId: string;
}

export type DailyGoalLaunchResult = { ok: true; runId: string } | { ok: false; error: string };

/** 起動の実体 (agent-delegation)。 runId は呼び出し側が先に保存した依頼の同一性。 */
export interface DelegationLaunchPort {
  launch(input: DailyGoalLaunchInput): Promise<DailyGoalLaunchResult>;
  /** 結果不明の照合。 run が無ければ null。 */
  findRun(runId: string): { id: string; status: string; childSessionId: string | null } | null;
}

export interface DailyGoalSessionView { id: string; status: string; metadata: string | null }

/** セッションの読み取りと、 方式・ゴール・自走の記録 (metadata の RMW)。 */
export interface DailyGoalSessionPort {
  find(sessionId: string): DailyGoalSessionView | null;
  /** metadata 文字列を更新する。 update は現在値から新しい値を作る純関数。 */
  updateMetadata(sessionId: string, update: (metadata: string | null) => string): void;
}

/** 回答待ちの判定 (CC-INV-08)。 */
export interface DailyGoalWaitingPort {
  /** 未回答の質問か人間待ちがあれば true。 確認できないときも true (送らない側に倒す)。 */
  isWaiting(sessionId: string): boolean;
  /** その質問がこのセッションの未回答の質問として実在するか。 */
  isUnansweredQuestion(sessionId: string, questionId: number): boolean;
  /** このセッションの人間待ちが active か。 */
  isHumanWaitActive(sessionId: string): boolean;
}

/** Goal & Go (autonomous-continuation) の予算と停止。 */
export interface DailyGoalAutonomyPort {
  /** 確認による予算のリセット (CC-WM-INV-03 で許す唯一の緩和)。 */
  resetBudget(sessionId: string): void;
  /** 止まる条件に当たった後の自走停止。 */
  disable(sessionId: string): void;
}

export interface DailyGoalInjectPort {
  inject(sessionId: string, text: string): void;
}

export interface DailyGoalProjectPort {
  /** プロジェクト名またはコードから登録済みの repo を引く。 一意に決まらなければ null。 */
  resolve(projectOrCode: string): { project: string; repoPath: string } | null;
}

export interface DailyGoalLog { info(message: string): void; warn(message: string): void }

export interface DailyGoalServiceDeps {
  repo: import("./repository.js").DailyGoalRepository;
  drafts: import("./draft-repository.js").DailyGoalDraftRepository;
  days: import("./day-repository.js").DailyGoalDayRepository;
  /** 投稿の読み取り (構造化した書式でない投稿だけに使う)。 */
  extraction: GoalExtractionPort;
  /** 日のまとめの記載先 (Memoria の日記とノート)。 */
  journal: MemoriaJournalPort;
  evidence: EvidencePort;
  delegation: DelegationLaunchPort;
  sessions: DailyGoalSessionPort;
  waiting: DailyGoalWaitingPort;
  autonomy: DailyGoalAutonomyPort;
  inject: DailyGoalInjectPort;
  projects: DailyGoalProjectPort;
  config: () => DailyGoalConfig;
  /** 専用セッションが報告 API を呼ぶための Cc の URL。 */
  baseUrl: string;
  newId?: () => string;
  log?: DailyGoalLog;
}
