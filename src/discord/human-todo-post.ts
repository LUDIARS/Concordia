/**
 * 「人間のやること」の報告をセッション thread へ投稿し、ピン留めを差し替える Discord adapter。
 *
 * - report: メンション付きで投稿し、新しい投稿をピン留めする。前回の報告のピンは外す
 *   (thread のピンに古い一覧を残さない)。
 * - resolved: メンション無しで解消を知らせ、前回の報告のピンを外す。
 * - 送信に失敗した report は control 側の記録を戻し、次の自動確認で再送させる。
 * - 本文には人や AI の書いた文が入るので、メンションは allowedMentions で指定した
 *   1 人だけに絞る (本文中の @ 表記は発火させない)。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2 人間のやることの報告
 */
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { ConcordiaEvent } from "../events.js";
import { releaseHumanTodoReport } from "../control/human-todo-report.js";
import type { WebhookPool } from "./webhook-pool.js";

/** 現在ピン留めしている報告の場所を記録する session metadata キー。 */
export const DISCORD_HUMAN_TODO_PIN_KEY = "discord_human_todo_pin";

type HumanTodoChange = Extract<ConcordiaEvent, { type: "session.human_todos_changed" }>;

export interface HumanTodoPin {
  channel_id: string;
  message_id: string;
}

export interface HumanTodoPostDeps {
  webhooks: Pick<WebhookPool, "getForSession" | "send">;
  sessions: Pick<SessionsRepo, "findSession" | "updateMetadata">;
  channelIdForSession: (sessionId: string) => string | null;
  pin: (channelId: string, messageId: string) => Promise<boolean>;
  unpin: (channelId: string, messageId: string) => Promise<boolean>;
  /** 管理画面で設定した通知先。未設定なら依頼者へメンションする。 */
  resolveMentionUserId?: () => string | null;
  log: { warn: (message: string) => void };
}

const DISCORD_USER_ID = /^\d{17,20}$/;

export function readHumanTodoPin(metadata: string | null): HumanTodoPin | null {
  try {
    const value = (JSON.parse(metadata ?? "{}") as Record<string, unknown>)[DISCORD_HUMAN_TODO_PIN_KEY];
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    return typeof row.channel_id === "string" && typeof row.message_id === "string"
      ? { channel_id: row.channel_id, message_id: row.message_id }
      : null;
  } catch {
    return null;
  }
}

/** メンション先を 1 人に決める。設定値 → セッションの依頼者の順。不正値は使わない。 */
export function resolveHumanTodoMention(input: {
  configured: string | null;
  metadata: string | null;
}): string | null {
  if (input.configured && DISCORD_USER_ID.test(input.configured)) return input.configured;
  try {
    const requester = (JSON.parse(input.metadata ?? "{}") as Record<string, unknown>).discord_requester_user_id;
    return typeof requester === "string" && DISCORD_USER_ID.test(requester) ? requester : null;
  } catch {
    return null;
  }
}

/** 投稿できたら true。送れなかった report は記録を戻して false を返す。 */
export async function postHumanTodoChange(deps: HumanTodoPostDeps, ev: HumanTodoChange): Promise<boolean> {
  const session = deps.sessions.findSession(ev.target_session_id);
  if (!session) return false;
  const release = () => {
    if (ev.change === "report" && ev.digest) releaseHumanTodoReport(deps.sessions, ev.target_session_id, ev.digest);
  };
  const client = await deps.webhooks.getForSession(ev.target_session_id);
  if (!client) {
    release();
    return false;
  }
  let configured: string | null = null;
  try {
    configured = deps.resolveMentionUserId?.() ?? null;
  } catch {
    // 設定の読み取り失敗でも、依頼者宛て・メンション無しで本文は届ける。
  }
  const mention = ev.change === "report" ? resolveHumanTodoMention({ configured, metadata: session.metadata }) : null;
  const sent = await deps.webhooks.send(client, {
    content: `${mention ? `<@${mention}> ` : ""}${ev.text}`,
    username: "Concordia 自動巡回",
    allowedMentions: mention ? { parse: [], users: [mention] } : { parse: [] },
  });
  if (!sent) {
    release();
    deps.log.warn(`human todo post failed session=${ev.target_session_id} change=${ev.change}`);
    return false;
  }

  const previous = readHumanTodoPin(session.metadata);
  if (previous) {
    const unpinned = await deps.unpin(previous.channel_id, previous.message_id).catch(() => false);
    if (!unpinned) deps.log.warn(`human todo unpin failed session=${ev.target_session_id} message=${previous.message_id}`);
  }
  let next: HumanTodoPin | null = null;
  if (ev.change === "report") {
    const channelId = sent.channelId ?? deps.channelIdForSession(ev.target_session_id);
    const pinned = channelId ? await deps.pin(channelId, sent.id).catch(() => false) : false;
    if (pinned && channelId) next = { channel_id: channelId, message_id: sent.id };
    else deps.log.warn(`human todo pin failed session=${ev.target_session_id} message=${sent.id}`);
  }
  deps.sessions.updateMetadata(ev.target_session_id, (metadata) => ({ ...metadata, [DISCORD_HUMAN_TODO_PIN_KEY]: next }));
  return true;
}
