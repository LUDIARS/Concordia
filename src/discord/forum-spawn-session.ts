import type { Guild } from "discord.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { SessionRelayState } from "../platform/chat-read-model.js";
import {
  buildForumStarterContent,
  fetchForumSessionThread,
  updateForumSessionState,
} from "./forum-session.js";
import type { WebhookPool } from "./webhook-pool.js";
import { buildDiscordWebhookIdentity } from "./webhook-identity.js";

export interface ForumSpawnSessionDeps {
  guild: Guild;
  sessionForumId: string;
  repo: DiscordSessionChannelsRepo;
  webhooks: WebhookPool;
  log: { info: (message: string) => void };
}

export interface BindForumSpawnSessionInput {
  sessionId: string;
  threadId: string;
  provider: string | null;
  repoPath: string;
  branch: string | null;
  callName: string | null;
  state: SessionRelayState | null;
}

export interface ResolveForumSpawnSourceInput {
  hasDelegationRun: boolean;
  hasTestSurface: boolean;
  sourceGuildId: string | null | undefined;
  sourceChannelId: string | null | undefined;
}

/**
 * 素の forum spawn が state に運んだ発火元スレッドを解決する。
 * delegation run / Test Forum はそれぞれ専用の surface 解決経路を持つため対象外。
 */
export async function resolveForumSpawnSourceThread(
  deps: Pick<ForumSpawnSessionDeps, "guild" | "sessionForumId">,
  input: ResolveForumSpawnSourceInput,
): Promise<{ threadId: string } | null> {
  if (
    input.hasDelegationRun
    || input.hasTestSurface
    || input.sourceGuildId !== deps.guild.id
    || !input.sourceChannelId
  ) {
    return null;
  }
  // 取得失敗を「発火元ではない」に読み替えると別スレッドを誤作成するため、呼び出し元へ返す。
  const source = await deps.guild.channels.fetch(input.sourceChannelId);
  if (!source?.isThread() || source.parentId !== deps.sessionForumId) return null;
  return { threadId: source.id };
}

/**
 * ユーザーが作成した Forum thread を session に紐付ける。
 * starter はユーザーの指示として保持し、別の webhook message を status surface にする。
 */
export async function bindForumSpawnSession(
  deps: ForumSpawnSessionDeps,
  input: BindForumSpawnSessionInput,
): Promise<"created" | "existing"> {
  const existing = deps.repo.findBySessionId(input.sessionId);
  if (existing?.surface_message_id && existing.webhook_id && existing.webhook_token) {
    deps.log.info(
      `forum-spawn session already bound session=${input.sessionId} thread=${existing.channel_id}`,
    );
    return "existing";
  }

  const threadId = existing?.channel_id ?? input.threadId;
  const thread = await fetchForumSessionThread(deps.guild, threadId);
  if (!thread || thread.parentId !== deps.sessionForumId) {
    throw new Error(`spawn source thread is unavailable: ${threadId}`);
  }

  const identity = buildDiscordWebhookIdentity({
    model: input.state?.model,
    provider: input.provider ?? input.state?.provider,
    callName: input.callName,
    configuredName: input.state?.webhookName,
    currentTask: input.state?.currentTask,
    roleLabel: input.state?.roleLabel,
    fallbackName: input.provider,
    delegationEmoji: input.state?.delegationEmoji,
  });
  const surface = await deps.webhooks.createForumSessionSurface(
    deps.sessionForumId,
    thread.id,
    {
      content: buildForumStarterContent(deps.guild.id, {
        sessionId: input.sessionId,
        repoPath: input.repoPath,
        branch: input.branch,
        model: input.state?.model ?? null,
        effortLevel: input.state?.effortLevel ?? null,
        fastMode: input.state?.fastMode ?? null,
      }),
      username: identity.username,
      ...(identity.avatarURL ? { avatarURL: identity.avatarURL } : {}),
      allowedMentions: { parse: [] },
    },
  );
  if (!surface) throw new Error("Session forum webhook status surface create failed");

  deps.repo.upsert({
    session_id: input.sessionId,
    channel_id: thread.id,
    channel_kind: "thread",
    status: "active",
    display_state: "active",
    agent_type: input.provider,
    name_body: input.state?.currentTask ?? input.state?.roleLabel ?? "session",
    delegation_emoji: input.state?.delegationEmoji ?? null,
    surface_message_id: surface.messageId,
  });
  deps.repo.setWebhook(input.sessionId, surface.webhookId, surface.webhookToken);
  await updateForumSessionState(thread, "active");
  deps.log.info(
    `forum-spawn ${existing ? "repaired" : "bound"} session=${input.sessionId} thread=${thread.id} run=${input.state?.delegationRunId ?? "null"}`,
  );
  return "created";
}
