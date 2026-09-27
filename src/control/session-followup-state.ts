/** @implements spec/feature/shared-startup-context.md — state-dependent periodic guidance */
import { fileURLToPath } from "node:url";
import { DELEGATION_RUN_STATUSES } from "../db/delegation-repo.js";
import type { ProjectStartupWorkflow } from "./project-startup-workflow.js";

export interface SessionFollowupSnapshot {
  workflow: ProjectStartupWorkflow;
  tasks: readonly { status: string }[];
  /** Newest first; historical failures must not override a later completed run. */
  delegations: readonly { status: string }[];
  prs: readonly { status: string; checkStatus: string }[];
}

export type SessionFollowupState = "task-active" | "delegation-wait" | "review-needed" | "review-wait"
  | "review-failed" | "merge-confirmation" | "reflection-needed" | "unknown" | "task-blocked";

/**
 * Every delegation status that means "the child may still be working".
 *
 * Derived from DELEGATION_RUN_STATUSES minus the terminal ones so that adding a
 * status upstream cannot silently drop a live child out of `delegation-wait` —
 * that is precisely the state whose whole purpose is to stop the parent from
 * re-implementing work a running child already owns.
 */
const TERMINAL_DELEGATION_STATUSES = new Set<string>(["completed", "failed", "spawn_failed"]);
const IN_FLIGHT_DELEGATION_STATUSES = new Set<string>(
  DELEGATION_RUN_STATUSES.filter((status) => !TERMINAL_DELEGATION_STATUSES.has(status)),
);

export function selectSessionFollowupState(snapshot: SessionFollowupSnapshot): SessionFollowupState {
  // An open or active task may advance while another task's review or child is waiting.
  if (snapshot.tasks.some((task) => task.status === "open" || task.status === "in_progress")) return "task-active";
  const open = snapshot.prs.filter((pr) => pr.status === "open");
  if (open.some((pr) => ["failed", "action_required"].includes(pr.checkStatus))) return "review-failed";
  if (open.some((pr) => pr.checkStatus === "test_ok")) return "merge-confirmation";
  if (open.length) return "review-wait";
  if (snapshot.delegations.some((run) => IN_FLIGHT_DELEGATION_STATUSES.has(run.status))) return "delegation-wait";
  if (snapshot.tasks.some((task) => task.status === "unknown")) return "unknown";
  if (snapshot.tasks.some((task) => task.status === "blocked")) return "task-blocked";
  if (snapshot.prs.some((pr) => pr.status === "merged")) return "reflection-needed";
  if (snapshot.delegations[0]?.status === "failed") return "review-failed";
  if (snapshot.tasks.length || snapshot.delegations[0]?.status === "completed") return "review-needed";
  return "unknown";
}

export function renderSessionFollowup(snapshot?: SessionFollowupSnapshot): string {
  const state = snapshot ? selectSessionFollowupState(snapshot) : "unknown";
  const skill = fileURLToPath(new URL("../../skills/session-followup/SKILL.md", import.meta.url));
  return [
    "[自動確認] Cc の作業状態に応じた確認です。",
    `workflow=${snapshot?.workflow ?? "unknown"}; state=${state}`,
    ...(!snapshot ? ["Actio・審査・委託状態は取得できていません。保存済みのタスク参照から再照合してください。"] : []),
    "Actio タスクの現状態を正本として確認し、人間の指示と task link の対応を混ぜないでください。",
    ...(state === "task-blocked" ? ["blocked タスクは依存待ち・人間判断待ちを照合し、待機中の同じ依頼を重複実行しないでください。"] : []),
    ...(state === "reflection-needed" ? ["PR の merged だけでループを完了にしないでください。対象変更の反映、Actio の残タスク、次の GO または人間判断待ちを確認してください。"] : []),
    `固定手順: ${JSON.stringify(skill)} の該当stateだけ読んでください。`,
    "これは終了指示でも新たな実行許可でもありません。人間の確認待ちは維持し、既存の明示許可がある操作はその範囲で継続してください。",
    "マージまで許可された委託は、通常のマージ許可を再質問せず、競合修正・再審査・対応PRのマージ結果確認まで続けてください。Test OKだけでは完了にしません。",
    "審査中は通知を待ち、重複提出・結果不明の再送・審査ゲート回避をしないでください。未許可のsession-end・push・テストや範囲拡張は行いません。",
  ].join("\n");
}
