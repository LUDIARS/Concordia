/**
 * bug-bounty の use case が他ドメインを使う口 (spec/feature/bug-bounty.md §12)。
 *
 * Actio・Revisor・委託の起動・個人の AI 予算・通知は port 越しに使い、bug-bounty から他ドメインの表を
 * 直接書かない。 実装 (adapter) は bootstrap が組み立てる。
 *
 * @implements SPEC-BOUNTY-TRIAGE
 * @implements SPEC-BOUNTY-FIX
 * @implements SPEC-BOUNTY-CLOSE
 */

import type {
  BountyReportEventInput,
  BountyReportPatch,
  BountyReportRow,
} from "../db/bounty-reports-repo.js";
import type { BountyReporterRow } from "../db/bounty-reporters-repo.js";
import type { BountyReportStatus } from "./report-state.js";

/** 台帳 (BountyReportsRepo) のうち use case が使う部分。 */
export interface BountyLedger {
  find(id: string): BountyReportRow | null;
  transition(input: {
    id: string;
    from: BountyReportStatus;
    to: BountyReportStatus;
    patch?: BountyReportPatch;
    event: Omit<BountyReportEventInput, "from_value" | "to_value">;
  }, now?: number): boolean;
  update(input: {
    id: string;
    patch: BountyReportPatch;
    expectStatus?: BountyReportStatus;
    event?: BountyReportEventInput;
  }, now?: number): boolean;
  recordEvent(reportId: string, event: BountyReportEventInput, now?: number): void;
  listByStatus(statuses: readonly BountyReportStatus[], limit: number): BountyReportRow[];
  listOpenForProject(project: string | null, excludeId: string, limit: number): BountyReportRow[];
  countHotfixesSince(project: string, since: number): number;
  listAwaitingDeployByFixPr(project: string, prs: readonly string[]): BountyReportRow[];
}

export interface BountyReporterLookup {
  find(id: string): BountyReporterRow | null;
}

/** project registry の見え方。 */
export interface BountyProjectsPort {
  /** 登録済みのコード。 */
  registered(): readonly string[];
  /** 会社の関係プロジェクト。 本社は null (制限なし)、 会社が登録に無ければ []。 */
  companyProjects(companyId: string | null): readonly string[] | null;
  /** 作業領域 (委託の cwd)。 未登録は null。 */
  repoPath(code: string): string | null;
  /** Revisor registry workflow (`revisor` / `github`)。 不明は null。 */
  revisorWorkflow(code: string): string | null;
}

export type BountyRunStatus =
  | "queued" | "launching" | "pending" | "spawned" | "spawn_failed" | "running" | "blocked" | "completed" | "failed";

/** 委託の起動と照会。 起動は予約した run id で行い、結果不明のときは照会してから増やす。 */
export interface BountyDelegationPort {
  launch(input: {
    runId: string;
    callName: string;
    cwd: string;
    project: string;
    args: Record<string, unknown>;
    branch?: string;
    /** 修正の委託に紐付ける Actio タスク (`actio:<id>`)。 */
    taskflowReference?: string;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  findRun(runId: string): { status: BountyRunStatus; childSessionId: string | null } | null;
}

export type BountyActioError =
  /** Actio に届かない。 定期の再試行で作り直す。 */
  | "actio_unavailable"
  /** Actio の投入先が決まらない (未登録)。 権限者が直してから再試行する。 */
  | "no_binding"
  /** 所属チームが 0 件または複数。 */
  | "team_ambiguous"
  /** 責任者を決められない。 */
  | "assignee_unresolved"
  /** Actio が要求を拒んだ。 */
  | "rejected";

/** 自動で再試行してよい失敗。 */
export const RETRYABLE_ACTIO_ERRORS: readonly BountyActioError[] = ["actio_unavailable"];

export interface BountyActioPort {
  /**
   * バウンティのイシューを作る (`source: concordia.bounty.v1` / `sourceRef: 報告 id` / 種別 `issue`)。
   * Actio の source / sourceRef の一意制約で、再送しても同じタスクが返る。
   */
  createIssueTask(input: {
    reportId: string;
    project: string;
    subsidiaryId: string | null;
    title: string;
    description: string;
  }): Promise<{ ok: true; taskRef: string } | { ok: false; error: BountyActioError; detail: string }>;
  /** タスクの状態。 読めなければ null。 */
  taskStatus(input: { taskRef: string; project: string; subsidiaryId: string | null }): Promise<string | null>;
}

/** 修正の PR の辿り方 (§6 SPEC-BOUNTY-FIX-LINK)。 */
export interface BountyPrLookupPort {
  /** そのセッションが出した、そのプロジェクトの PR の番号 (新しいもの)。 無ければ null。 */
  prOfSession(sessionId: string, project: string): string | null;
  /** その Actio タスクを task-link で持つセッション。 */
  sessionsOfTask(taskRef: string): readonly string[];
}

/** 報告者・権限者への通知。 本文に原文を入れない。 届かなくても状態は戻さない (CC-INV-06)。 */
export interface BountyNotifierPort {
  /** 受付口へ返す (Discord は構造化フィールドで本人だけを mention、セッションは inject)。 */
  replyToReporter(report: BountyReportRow, message: string): Promise<boolean>;
  /** 権限者へ知らせる。 */
  notifyAuthority(message: string): Promise<boolean>;
}

/** 個人の AI 予算の報奨の口 (personal-budget/reward-service.ts の PersonalBudgetRewardPort と同じ形)。 */
export interface BountyRewardPort {
  requestReward(request: {
    kind: "bounty";
    sourceRef: string;
    /** 個人の AI 予算が識別できるのは Discord / Slack の人だけ。 それ以外は null で渡し、予算側が理由付きで見送る。 */
    recipient: { subsidiaryId: string | null; platform: "discord" | "slack" | null; platformUserId: string | null };
    severity?: "s1" | "s2" | "s3" | "s4" | null;
  }):
    | { status: "granted" | "existing"; entry: { tokens: number } }
    | { status: "skipped"; reason: string; detail: string };
  revokeReward(request: { kind: "bounty"; sourceRef: string; reason: string }):
    | { status: "revoked" | "existing"; entry: { tokens: number } }
    | { status: "not_granted" };
}

/** 委託の run が終わったか。 */
export function isTerminalRunStatus(status: BountyRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "spawn_failed";
}
