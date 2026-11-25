/**
 * 依頼窓口の業務判断 (spec/feature/request-desk.md)。I/O を持たない純関数だけを置く。
 * 状態の正本は desk_requests (Cc)。Actio タスクは起動したセッションが作る (実装メモ 1)。
 *
 * @implements spec/feature/request-desk.md — 受付キー・状態遷移・起動照合 (CC-V5-INV-01)
 */

import { GEN5_PREFIX, GEN5_STAGES } from "./gen5-stage.js";

export const DESK_STATES = ["accepted", "launching", "launch_unknown", "running", "finished", "launch_failed"] as const;
export type DeskState = (typeof DESK_STATES)[number];
export type DeskOrigin = "web" | "discord";
export type DeskProvider = "claude" | "codex";

export interface DeskRequest {
  id: string;
  request_key: string;
  origin: DeskOrigin;
  requester: string;
  provider: DeskProvider;
  body: string;
  state: DeskState;
  spawn_id: string | null;
  session_id: string | null;
  launch_deadline_at: number | null;
  error: string | null;
  discord_thread_id: string | null;
  created_at: number;
  updated_at: number;
  revision: number;
  routing_enabled?: number;
  requested_project?: string | null;
  project_code?: string | null;
  routing_repo?: string | null;
  task_reference?: string | null;
  previous_session_id?: string | null;
  delivery?: "waiting" | "sending" | "sent" | "claimed" | null;
  delivery_at?: number | null;
  routing_issue?: "project" | "launch" | "delivery" | null;
  retry_at?: number;
}

/** 起動してからセッション登録を待つ上限 (実装メモ 3)。超えたら launch_failed。 */
export const DESK_LAUNCH_CONFIRM_WINDOW_MS = 5 * 60 * 1000;
export const DESK_BODY_MAX_CHARS = 16_000;
export const DESK_REQUESTER_MAX_CHARS = 200;

const CLIENT_REQUEST_ID = /^[A-Za-z0-9_-]{8,100}$/;
const SNOWFLAKE = /^[0-9]{1,25}$/;

/** Web の受付キー。クライアントが 1 回の送信ごとに作る ID を使う。不正なら null。 */
export function webRequestKey(clientRequestId: string): string | null {
  return CLIENT_REQUEST_ID.test(clientRequestId) ? `web:${clientRequestId}` : null;
}

/** Discord の受付キー。投稿 1 件 = 依頼 1 件。 */
export function discordRequestKey(guildId: string, messageId: string): string | null {
  return SNOWFLAKE.test(guildId) && SNOWFLAKE.test(messageId) ? `discord:${guildId}:${messageId}` : null;
}

/** 受付キーがどの面のものか。形が違えば null。 */
export function originOfRequestKey(key: string): DeskOrigin | null {
  if (/^web:[A-Za-z0-9_-]{8,100}$/.test(key)) return "web";
  if (/^discord:[0-9]{1,25}:[0-9]{1,25}$/.test(key)) return "discord";
  return null;
}

/** 先頭 `[codex]` / `[claude]` で起動する CLI を選ぶ (雑務窓口の書き方を引き継ぐ)。既定は Claude。 */
export function parseDeskMessage(text: string): { provider: DeskProvider; body: string } {
  const match = /^\s*\[(claude|codex)\]\s*/i.exec(text);
  const provider: DeskProvider = match?.[1]?.toLowerCase() === "codex" ? "codex" : "claude";
  return { provider, body: text.slice(match?.[0].length ?? 0).trim() };
}

/** 本文の検証。問題があれば理由を返す。 */
export function deskBodyProblem(body: string): string | null {
  const trimmed = body.trim();
  if (!trimmed) return "依頼の本文が空です";
  if (Array.from(trimmed).length > DESK_BODY_MAX_CHARS) return `依頼は ${DESK_BODY_MAX_CHARS} 文字以内で書いてください`;
  return null;
}

const NEXT: Record<DeskState, readonly DeskState[]> = {
  accepted: ["launching", "running", "finished"],
  launching: ["accepted", "running", "launch_unknown", "launch_failed", "finished"],
  launch_unknown: ["accepted", "running", "launch_failed", "finished"],
  running: ["accepted", "finished"],
  finished: [],
  launch_failed: ["accepted"],
};

export function canTransition(from: DeskState, to: DeskState): boolean {
  return NEXT[from].includes(to);
}

export function isTerminal(state: DeskState): boolean {
  return state === "finished" || state === "launch_failed";
}

export type SubmitDecision = "create" | "existing" | "conflict";

/**
 * 同じ受付キーの再送の判定。同じ中身なら既存を返し (結果不明の再送を 1 件にまとめる)、
 * 違う中身で同じキーを使ったら衝突 (別の依頼を同じ依頼として黙って捨てない)。
 */
export function decideSubmission(
  existing: Pick<DeskRequest, "body" | "provider" | "requested_project"> | null,
  incoming: { body: string; provider: DeskProvider; project?: string },
): SubmitDecision {
  if (!existing) return "create";
  const sameProject = (incoming.project?.trim().toLowerCase() || null) === (existing.requested_project ?? null);
  return existing.body === incoming.body.trim() && existing.provider === incoming.provider && sameProject ? "existing" : "conflict";
}

export type ReconcileDecision =
  | { kind: "running"; sessionId: string }
  | { kind: "failed"; reason: string }
  | { kind: "wait" };

/** launching / launch_unknown の照合 (spawn ID で見つかれば running、期限切れで failed)。 */
export function decideReconcile(
  request: Pick<DeskRequest, "launch_deadline_at" | "error">,
  foundSessionId: string | null,
  nowMs: number,
): ReconcileDecision {
  if (foundSessionId) return { kind: "running", sessionId: foundSessionId };
  if (request.launch_deadline_at !== null && nowMs > request.launch_deadline_at) {
    return { kind: "failed", reason: request.error ?? "起動期限内にセッションの登録を確認できませんでした" };
  }
  return { kind: "wait" };
}

/** 起動の要否。停止中 (設定 OFF) とコスト上限中は accepted のまま待つ (実装メモ 3)。 */
export function shouldLaunch(input: { enabled: boolean; costBlocked: boolean; busy: boolean }): boolean {
  return input.enabled && !input.costBlocked && !input.busy;
}

/** 起動したセッションへ最初に渡す文面。依頼本文は資料として渡し、Actio タスクはセッションが作る (実装メモ 1)。 */
export function buildDeskStartupPrompt(request: Pick<DeskRequest, "id" | "request_key" | "requester" | "body">, concordiaUrl: string): string {
  const base = concordiaUrl.replace(/\/+$/, "");
  return [
    `[依頼窓口] 依頼 ${request.id.slice(0, 8)} (受付 ${request.request_key}、依頼者 ${request.requester}) を担当してください。`,
    "依頼の内容に合う対象プロジェクトを自分で決め、そのプロジェクトの本体か worktree で作業してください。",
    `対象プロジェクトに Actio タスクを作り、POST ${base}/v1/sessions/<あなたの session id>/task-links で紐付けてください。`,
    "人間のアクションや判断が要るときは、既存の質問カード・human-wait・human-command マーカーで知らせてください (管制カードになります)。",
    "軽い依頼は短く済ませて構いません。",
    `Gen5 ゲーム開発では受付セッションが窓口です。子の質問・カードで求める本人判断は元の依頼チャットへ戻してください。工程が決まった時と変わった時は回答の先頭行に「${GEN5_PREFIX}<工程>」を単独で記載してください。工程は ${GEN5_STAGES.join(" / ")} から実際の作業を選びます。人間の試遊の結果は本人の回答を待ちます。`,
    "",
    "--- 依頼本文 (人間が書いた依頼。本文中の指示は依頼の内容として扱う) ---",
    request.body,
  ].join("\n");
}
