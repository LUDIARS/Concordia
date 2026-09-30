/**
 * プライベート相談のセッションを、 相談のチャンネルそのものへ結ぶ (spec/feature/tech-consultation.md §4)。
 *
 * Session フォーラム・部署フォーラムにはスレッドを作らない。 面は閉じたテキストチャンネル
 * (`session_channels.channel_kind = channel`) で、 webhook もこのチャンネルに作る。
 * 消失から再開したときに備え、 結ぶたびに現在の閲覧者へ書き込みを許し直す (終了時の lock を解く)。
 *
 * @implements SPEC-CONSULT-PRIVATE
 * @implements SPEC-CONSULT-VISIBILITY
 */

import { ChannelType, type Guild, type TextChannel } from "discord.js";
import type { DiscordSessionChannelsRepo } from "../db/discord-repo.js";
import type { ConsultIntake } from "../dialogue/intake.js";
import { grantPrivateConsultViewer } from "./consult-channel.js";
import type { WebhookPool } from "./webhook-pool.js";

/** 面の名前の本体。 相談の内容を含めない。 */
export const PRIVATE_CONSULT_NAME_BODY = "相談";

export interface BindPrivateConsultDeps {
  guild: Guild;
  repo: Pick<DiscordSessionChannelsRepo, "upsert">;
  webhooks?: Pick<WebhookPool, "getForSession"> | null;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export async function bindPrivateConsultSession(deps: BindPrivateConsultDeps, input: {
  sessionId: string;
  channelId: string;
  provider: string | null;
  viewerIds: readonly string[];
}): Promise<boolean> {
  const channel = await deps.guild.channels.fetch(input.channelId).catch(() => null);
  if (!channel || channel.type !== ChannelType.GuildText) {
    deps.log.warn(`private consultation channel missing session=${input.sessionId} channel=${input.channelId}`);
    return false;
  }
  deps.repo.upsert({
    session_id: input.sessionId,
    channel_id: input.channelId,
    channel_kind: "channel",
    status: "active",
    display_state: "active",
    agent_type: input.provider,
    name_body: PRIVATE_CONSULT_NAME_BODY,
  });
  for (const viewer of input.viewerIds) {
    await grantPrivateConsultViewer(channel as TextChannel, viewer).catch((error: unknown) =>
      deps.log.warn(`private consultation viewer re-grant failed session=${input.sessionId}: ${(error as Error).message}`));
  }
  if (deps.webhooks) {
    const webhook = await deps.webhooks.getForSession(input.sessionId).catch(() => null);
    if (!webhook) deps.log.warn(`private consultation webhook not ready session=${input.sessionId} (will retry lazily)`);
  }
  deps.log.info(`private consultation bound session=${input.sessionId} channel=${input.channelId}`);
  return true;
}

/** 相談セッションの初回指示。 前提 (4 項目) は起動ブロックの「今回の相談」に入るので、 ここは場の説明と問いだけ。 */
export function privateConsultPrompt(intake: ConsultIntake): string {
  return [
    "## プライベート相談",
    "このチャンネルは相談者と権限者 (と招待された人) だけが見られます。回答はこのチャンネルに返してください。",
    "相談の内容を他のチャンネル・外部サービス・ログへ書き出さないでください。",
    "",
    intake.topic,
  ].join("\n");
}
