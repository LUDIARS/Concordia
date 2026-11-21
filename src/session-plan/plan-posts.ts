/**
 * セッションのプランから、 セッションの状態の 1 行と Discord へ出す本文と作者ラベルを作る
 * (spec/feature/session-plan-discord.md)。 純関数のみ。
 *
 * @implements SPEC-SESSION-PLAN-DISCORD
 */

import type { SessionPlanState, SessionPlanStep } from "./plan-state.js";

const STEP_MARK: Record<SessionPlanStep["status"], string> = {
  completed: "✅",
  in_progress: "▶",
  pending: "⏳",
};

/** 送り手の provider ごとの投稿の作者ラベル。 表に無い provider は Claude 系として扱う (従来どおり)。 */
const AUTHOR_LABELS: Readonly<Record<string, string>> = {
  "antigravity-cli": "agy プラン",
};
export const DEFAULT_SESSION_PLAN_AUTHOR_LABEL = "Claude プラン";

/** プラン投稿の作者ラベル。 */
export function sessionPlanAuthorLabel(provider: string | null | undefined): string {
  return (provider ? AUTHOR_LABELS[provider] : undefined) ?? DEFAULT_SESSION_PLAN_AUTHOR_LABEL;
}

function progress(steps: readonly SessionPlanStep[]): string {
  return `${steps.filter((step) => step.status === "completed").length}/${steps.length}`;
}

/** プランに合わせたセッションの状態 (1 行)。 プランもサマリも無ければ null。 */
export function sessionPlanStatus(state: SessionPlanState): string | null {
  if (state.phase === "waiting") return "回答待ち";
  if (state.phase === "summary") return "完了";
  if (state.steps.length === 0) return null;
  const index = state.steps.findIndex((step) => step.status === "in_progress");
  if (index >= 0) return `作業中 (${index + 1}/${state.steps.length}): ${state.steps[index]!.content}`;
  return state.steps.every((step) => step.status === "completed")
    ? `全ステップ完了 (${progress(state.steps)})`
    : `待機中 (${progress(state.steps)})`;
}

function planLines(steps: readonly SessionPlanStep[]): string[] {
  return steps.map((step) => `${STEP_MARK[step.status]} ${step.content}`);
}

function workingPost(state: SessionPlanState, status: string): string {
  return [`📋 **プラン** — ${status}`, ...planLines(state.steps)].join("\n");
}

function summaryPost(state: SessionPlanState, status: string): string {
  const summary = state.summary;
  const lines = [`📝 **サマリ** — ${status}`];
  if (summary) lines.push(summary.recap);
  if (state.steps.length > 0) lines.push("", ...planLines(state.steps));
  if (summary?.ask) {
    lines.push("", `❓ ${summary.ask}`);
    if (summary.choices.length > 0) lines.push(`選択肢: ${summary.choices.join(" / ")}`);
  }
  return lines.join("\n");
}

/**
 * 状態が変わったときに Discord へ出す本文。 変わっていなければ null (同じ内容を重ねて出さない)。
 * サマリ (wrap_up) は内容が同じでも毎回出す — ターンの区切りなので。
 */
export function sessionPlanPost(previous: SessionPlanState | null, next: SessionPlanState): string | null {
  const status = sessionPlanStatus(next);
  if (status === null) return null;
  if (next.phase !== "working") return summaryPost(next, status);
  const unchanged = previous !== null
    && previous.phase === "working"
    && sessionPlanStatus(previous) === status
    && JSON.stringify(previous.steps) === JSON.stringify(next.steps);
  return unchanged ? null : workingPost(next, status);
}
