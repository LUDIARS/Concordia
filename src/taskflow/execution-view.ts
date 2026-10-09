/**
 * Taskflow 行の実行状況 (サイドカー可視化) を導出する純関数。
 *
 * タスクの業務状態 (`status`) とは独立に、委託 run・子セッション・PR・transcript の最新行から
 * 「受領したか / いま何をしているか / 最後の応答 / なぜ止まったか / 成果物」を組み立てる。
 * 保存しない読み取りモデルで、導出できない項目は null のまま返す。
 *
 * @implements spec/feature/task-workflow-v3.md CC-TF-EXEC-01
 */

import type { DelegationRunRow } from "../db/delegation-repo.js";
import type { PrRecordRow } from "../db/pr-records-repo.js";
import type { SessionRow } from "../shared/types.js";

export const LAST_RESPONSE_MAX_CHARS = 280;

export type TaskExecutionState =
  | "not_started"
  | "queued"
  | "launching"
  | "received"
  | "working"
  | "waiting"
  | "stopped"
  | "finished";

export interface TaskExecutionArtifact {
  kind: "pr" | "branch";
  label: string;
  url: string | null;
}

export interface TaskExecutionView {
  state: TaskExecutionState;
  received_at: number | null;
  current_action: { label: string; source: "tool" | "current_task"; at: number | null } | null;
  last_response: { text: string; at: number } | null;
  stop_reason: string | null;
  artifacts: TaskExecutionArtifact[];
}

/** 子セッションの transcript 最新行 (kind 別に 1 行ずつ)。 */
export interface TranscriptTail {
  lastText: { ts: number; payload: unknown } | null;
  lastToolUse: { ts: number; payload: unknown } | null;
}

export function buildTaskExecutionView(input: {
  run: Pick<DelegationRunRow, "status" | "error" | "spawn_branch"> | null;
  session: Pick<SessionRow, "status" | "started_at" | "ended_at" | "current_task"> | null;
  pr: Pick<PrRecordRow, "number" | "url" | "state"> | null;
  tail: TranscriptTail | null;
}): TaskExecutionView {
  const lastResponse = assistantText(input.tail?.lastText ?? null);
  return {
    state: deriveState(input.run, input.session),
    received_at: input.session?.started_at ?? null,
    current_action: currentAction(input.tail?.lastToolUse ?? null, input.session),
    last_response: lastResponse,
    stop_reason: stopReason(input.run, input.session),
    artifacts: artifacts(input.run, input.pr),
  };
}

function deriveState(
  run: Pick<DelegationRunRow, "status"> | null,
  session: Pick<SessionRow, "status"> | null,
): TaskExecutionState {
  if (run) {
    switch (run.status) {
      case "queued": return "queued";
      case "launching":
      case "pending": return "launching";
      case "spawn_failed":
      case "failed": return "stopped";
      case "blocked": return "waiting";
      case "completed": return "finished";
      case "spawned":
      case "running": break;
    }
  }
  if (!session) return run ? "launching" : "not_started";
  if (isClosed(session)) return run?.status === "completed" ? "finished" : "stopped";
  if (session.status === "blocked") return "waiting";
  return run?.status === "running" ? "working" : "received";
}

function stopReason(
  run: Pick<DelegationRunRow, "status" | "error"> | null,
  session: Pick<SessionRow, "status"> | null,
): string | null {
  if (run && ["failed", "spawn_failed", "blocked"].includes(run.status)) {
    return run.error?.trim() || `run ${run.status}`;
  }
  if (session && isClosed(session) && run?.status !== "completed") {
    return session.status === "lost" ? "子セッションとの接続が失われた" : "子セッションが完了報告の前に終了した";
  }
  return null;
}

function isClosed(session: Pick<SessionRow, "status">): boolean {
  return session.status === "ended" || session.status === "lost" || session.status === "abandoned";
}

function currentAction(
  toolUse: TranscriptTail["lastToolUse"],
  session: Pick<SessionRow, "current_task"> | null,
): TaskExecutionView["current_action"] {
  const name = toolName(toolUse?.payload);
  // tool の入力 (input_preview) は秘密やパスを含み得るので名前だけを出す (CC-TF-EXEC-INV-02)。
  if (name && toolUse) return { label: name, source: "tool", at: toolUse.ts };
  const task = session?.current_task?.trim();
  return task ? { label: task, source: "current_task", at: null } : null;
}

function toolName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const name = (payload as { name?: unknown }).name;
  return typeof name === "string" && name.trim() ? name.trim() : null;
}

function assistantText(frame: TranscriptTail["lastText"]): TaskExecutionView["last_response"] {
  if (!frame || !frame.payload || typeof frame.payload !== "object") return null;
  const value = frame.payload as { role?: unknown; text?: unknown };
  if (value.role !== "assistant" || typeof value.text !== "string") return null;
  const text = value.text.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const chars = [...text];
  return {
    text: chars.length > LAST_RESPONSE_MAX_CHARS ? `${chars.slice(0, LAST_RESPONSE_MAX_CHARS).join("")}…` : text,
    at: frame.ts,
  };
}

function artifacts(
  run: Pick<DelegationRunRow, "spawn_branch"> | null,
  pr: Pick<PrRecordRow, "number" | "url" | "state"> | null,
): TaskExecutionArtifact[] {
  const out: TaskExecutionArtifact[] = [];
  if (pr) out.push({ kind: "pr", label: `#${pr.number} · ${pr.state}`, url: pr.url });
  const branch = run?.spawn_branch?.trim();
  if (branch) out.push({ kind: "branch", label: branch, url: null });
  return out;
}
