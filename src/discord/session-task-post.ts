/**
 * セッション thread へ「タスク本文」を独立したメッセージとして投稿する — 文面組み立てと
 * ピン留め方針 (純関数)。
 *
 * 背景: 委託タスクの本文は起動コンテキスト message の `**起動時 Inject**` 節に
 * 作業ポリシーと混ぜて写していた。 このため
 *   - タスク本文が定型文に埋もれて「補足」に見える
 *   - 段階注入 (staged injection) の run では第 1 段階の調査ブリーフしか写らず、
 *     実装タスク本文を運ぶ第 2 段階 inject は Discord にまったく出ない
 *   - タスク無しで spawn した素のセッションは何も写らない
 * という 3 つの欠落が起きていた。 タスク本文は会話ログではなく作業の宣言なので、
 * 独立した message にし、 最初の 1 通だけ pin して定位置に置く。
 *
 * spec/feature/discord-session-task-post.md。
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { isBlankSessionTask } from "../shared/session-task.js";
import type { WebhookPool } from "./webhook-pool.js";

/** タスク本文 message を pin 済みかを記録する session metadata キー。 */
export const DISCORD_TASK_PINNED_KEY = "discord_task_pinned";

/** タスク本文 message を投稿済みかを記録する session metadata キー。 */
export const DISCORD_TASK_POSTED_KEY = "discord_task_posted";

/** タスク本文 message の種別。 見出しと pin 可否の判断に使う。 */
export type SessionTaskKind =
  /** spawn 時に渡したタスク本文 (段階注入なら第 1 段階の調査ブリーフ)。 */
  | "startup"
  /** 段階注入の第 2 段階。 第 1 段階で伏せていた実装タスク本文。 */
  | "followup"
  /** 委託元 (親セッション) からの追加指示。 */
  | "parent"
  /** Memoria id の追送など、 タスク本文ではない補足。 */
  | "supplement";

const HEADINGS: Record<SessionTaskKind, string> = {
  startup: "📋 **タスク**",
  followup: "📋 **タスク (第 2 段階: 実装)**",
  parent: "📮 **委託元からの追加指示**",
  supplement: "📎 **補足**",
};

/**
 * inject source (`delegation:<runId>:<suffix>`) を message 種別へ写す。
 * 委託由来でない source (`slack:<user>` / `discord-enter` 等) は null。
 */
export function taskKindForInjectSource(source: string | null | undefined): SessionTaskKind | null {
  const match = /^delegation:[^:]+:(.+)$/.exec((source ?? "").trim());
  switch (match?.[1]) {
    case "followup": return "followup";
    case "parent": return "parent";
    case "followup-memoria": return "supplement";
    default: return null;
  }
}

/**
 * 委託 inject の先頭に付く運搬用ヘッダ (`[delegation:<runId>] Parent instruction`) を落とす。
 * 種別は message の見出しが伝えるので、 Discord では二重に出さない。
 */
export function stripDelegationInjectHeader(text: string): string {
  return text.replace(/^\[delegation:[^\]]+\][^\n]*\n+/, "").trim();
}

/**
 * この message を pin するか。
 *
 * - 待機指示 (BLANK_SESSION_TASK) は作業の宣言ではないので pin しない (thread 上部を占有させない)。
 * - 補足・追加指示は最初のタスク本文ではないので pin しない。
 * - 既に pin 済みなら 2 通目以降は pin しない (「最初のタスク本文」だけを定位置に置く)。
 */
export function shouldPinSessionTask(input: {
  kind: SessionTaskKind;
  taskText: string;
  /** 旧 (段階注入) run で実装タスク本文がまだ届いていないか。 新規 run は常に false。 */
  stagedPending: boolean;
  alreadyPinned: boolean;
}): boolean {
  if (input.alreadyPinned) return false;
  if (isBlankSessionTask(input.taskText)) return false;
  if (input.kind === "supplement" || input.kind === "parent") return false;
  if (input.kind === "startup" && input.stagedPending) return false;
  return input.taskText.trim().length > 0;
}

/**
 * タスク本文 message の本文。 pin した 1 通目を見れば「何を頼まれたか」が分かる形にする。
 * 送信側 (webhook-pool) が Discord 上限で分割するので、 ここでは切り詰めない。
 */
export function buildSessionTaskMessage(input: {
  kind: SessionTaskKind;
  taskText: string;
}): { content: string; allowedMentions: { parse: [] } } {
  return {
    content: [HEADINGS[input.kind], "", input.taskText.trim()].join("\n"),
    allowedMentions: { parse: [] },
  };
}

/** pin は best-effort。 権限不足で失敗しても投稿自体は成立させる。 */
export type SessionTaskPinPort = (channelId: string, messageId: string) => Promise<boolean>;

export interface PostSessionTaskInput {
  sessionId: string;
  channelId: string;
  kind: SessionTaskKind;
  taskText: string;
  stagedPending: boolean;
  alreadyPinned: boolean;
  webhooks: Pick<WebhookPool, "getForSession" | "send">;
  sessionsRepo: Pick<SessionsRepo, "mergeMetadata">;
  pin: SessionTaskPinPort;
  log: { warn: (message: string) => void };
}

/**
 * タスク本文を session thread へ 1 通投稿する。 pin 対象なら pin し、 pin 済みの事実を
 * session metadata へ焼く (再起動をまたいで 2 通目を pin しないため)。
 */
export async function postSessionTaskBody(input: PostSessionTaskInput): Promise<boolean> {
  const taskText = input.taskText.trim();
  if (!taskText) return false;
  const client = await input.webhooks.getForSession(input.sessionId);
  if (!client) return false;
  const sent = await input.webhooks.send(
    client,
    buildSessionTaskMessage({ kind: input.kind, taskText }),
  );
  if (!sent) return false;

  const metadata: Record<string, unknown> = { [DISCORD_TASK_POSTED_KEY]: true };
  if (shouldPinSessionTask({
    kind: input.kind,
    taskText,
    stagedPending: input.stagedPending,
    alreadyPinned: input.alreadyPinned,
  })) {
    const pinned = await input.pin(input.channelId, sent.id).catch(() => false);
    if (pinned) metadata[DISCORD_TASK_PINNED_KEY] = true;
    else input.log.warn(`session task pin failed session=${input.sessionId} message=${sent.id}`);
  }
  input.sessionsRepo.mergeMetadata(input.sessionId, metadata);
  return true;
}
