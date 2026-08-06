import type { SessionsRepo } from "../db/sessions-repo.js";
import type { WebhookPool } from "./webhook-pool.js";

export const DISCORD_STARTUP_CONTEXT_POSTED_KEY = "discord_startup_context_posted";

export interface SessionStartupContext {
  requesterUserId: string | null;
  startupInjectText: string;
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
  lines.push("**起動時 Inject**", input.startupInjectText.trim());
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
  const client = await input.webhooks.getForSession(input.sessionId);
  if (!client) return false;
  const sent = await input.webhooks.send(
    client,
    buildSessionStartupContextMessage(input.context),
  );
  if (!sent) return false;
  input.sessionsRepo.mergeMetadata(input.sessionId, {
    [DISCORD_STARTUP_CONTEXT_POSTED_KEY]: true,
  });
  return true;
}
