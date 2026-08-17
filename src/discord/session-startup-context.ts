import type { SessionsRepo } from "../db/sessions-repo.js";
import type { WebhookPool } from "./webhook-pool.js";

export const DISCORD_STARTUP_CONTEXT_POSTED_KEY = "discord_startup_context_posted";

export interface SessionStartupContext {
  requesterUserId: string | null;
  /**
   * 作業ポリシー等の定型 inject。 タスク本文はここに混ぜない
   * (session-task-post.ts が独立 message として投稿し pin する)。
   */
  startupInjectText: string | null;
  surfaceLabel: "Session" | "TaskWorkflow";
  sessionChannelId: string;
  sourceGuildId: string | null;
  sourceChannelId: string | null;
}

export function buildSessionStartupContextMessage(input: SessionStartupContext): {
  content: string;
  allowedMentions: { parse: []; users: string[] };
} {
  const lines: string[] = [];
  if (input.requesterUserId) {
    lines.push(
      `<@${input.requesterUserId}> このセッションを起動しました。` +
      "通知を受け取るには、このスレッドをフォローしてください。",
    );
  }
  if (input.surfaceLabel === "TaskWorkflow") {
    lines.push(`**起動セッション** <#${input.sessionChannelId}>`);
  }
  if (input.sourceGuildId && input.sourceChannelId) {
    lines.push(
      `**委託元フォーラム投稿** ` +
      `https://discord.com/channels/${input.sourceGuildId}/${input.sourceChannelId}`,
    );
  }
  const policy = input.startupInjectText?.trim();
  if (policy) lines.push("**起動時 Inject**", policy);
  return {
    content: lines.join("\n\n"),
    allowedMentions: {
      parse: [],
      users: input.requesterUserId ? [input.requesterUserId] : [],
    },
  };
}

export async function postSessionStartupContext(input: {
  sessionId: string;
  context: SessionStartupContext;
  webhooks: Pick<WebhookPool, "getForSession" | "send">;
  sessionsRepo: Pick<SessionsRepo, "mergeMetadata">;
}): Promise<boolean> {
  const message = buildSessionStartupContextMessage(input.context);
  // タスク本文を別 message に分けた結果、 写す補足が何も無いことがある。 空 message は
  // Discord が拒否するので投稿しないが、 「済み」は立てる — 立てないとセッション登録の
  // たびに再入して失敗ログを吐き続ける。
  if (!message.content.trim()) {
    input.sessionsRepo.mergeMetadata(input.sessionId, {
      [DISCORD_STARTUP_CONTEXT_POSTED_KEY]: true,
    });
    return true;
  }
  const client = await input.webhooks.getForSession(input.sessionId);
  if (!client) return false;
  const sent = await input.webhooks.send(client, message);
  if (!sent) return false;
  input.sessionsRepo.mergeMetadata(input.sessionId, {
    [DISCORD_STARTUP_CONTEXT_POSTED_KEY]: true,
  });
  return true;
}
