// session.registered / lost / ended に応じて Discord channel を CRUD する.
//
// 5min cooldown (実測値は 5-10 分。 Discord API は 2 rename / 10min と公称) を
// DB の last_rename_ts で守る. cooldown 内の rename は skip され、 次回 event
// で再試行される. 短期 idle↔active 振動は emoji 変更しない (= rename しない).

import type { Guild } from "discord.js";
import { ChannelType } from "discord.js";
import type { DiscordConfigSnapshot } from "./config.js";
import type {
  DiscordSessionChannelsRepo,
  DiscordSessionStatus,
} from "../db/discord-repo.js";
import { applyStatusEmoji, sessionChannelSlug } from "./formatter.js";

const RENAME_COOLDOWN_SEC = 5 * 60;

export interface SessionChannelDeps {
  guild: Guild;
  layout: DiscordConfigSnapshot;
  repo: DiscordSessionChannelsRepo;
  log: { info: (m: string) => void; warn: (m: string) => void };
}

/** session.registered → channel 作成 + 🟢 prefix + active マーク. */
export async function onSessionRegistered(
  deps: SessionChannelDeps,
  input: { sessionId: string; agentType: string | null; roleLabel: string | null; personaDisplayName: string | null },
): Promise<void> {
  const existing = deps.repo.findBySessionId(input.sessionId);
  if (existing) return; // 既知 (再 register など)

  const base = sessionChannelSlug(input.agentType, input.roleLabel);
  const name = applyStatusEmoji(base, "active");
  try {
    const created = await deps.guild.channels.create({
      name,
      type: ChannelType.GuildText,
      parent: deps.layout.sessionsCategoryId,
      topic: input.personaDisplayName
        ? `${input.personaDisplayName} — session ${input.sessionId}`
        : `session ${input.sessionId}`,
    });
    deps.repo.upsert({
      session_id: input.sessionId,
      channel_id: created.id,
      status: "active",
    });
    deps.log.info(`session-channel: created #${created.name} for ${input.sessionId}`);
  } catch (e) {
    deps.log.warn(`session-channel: create failed for ${input.sessionId}: ${(e as Error).message}`);
  }
}

/** session.lost / session.ended → emoji 変更 + 必要なら archive 移動. */
export async function onSessionStatusChanged(
  deps: SessionChannelDeps,
  input: { sessionId: string; status: DiscordSessionStatus },
): Promise<void> {
  const row = deps.repo.findBySessionId(input.sessionId);
  if (!row) return;
  if (row.status === input.status) return;

  // DB の status は先に更新 (後続の cooldown で rename が成功しなくても status は正しい)
  deps.repo.setStatus(input.sessionId, input.status);

  // rename rate limit guard
  if (!deps.repo.tryClaimRename(input.sessionId, RENAME_COOLDOWN_SEC)) {
    deps.log.info(
      `session-channel: rename deferred for ${input.sessionId} (cooldown < ${RENAME_COOLDOWN_SEC}s)`,
    );
    return;
  }

  const ch = deps.guild.channels.cache.get(row.channel_id);
  if (!ch || ch.type !== ChannelType.GuildText) {
    deps.log.warn(`session-channel: channel ${row.channel_id} not found`);
    return;
  }

  const newName = applyStatusEmoji(ch.name, input.status);
  const parentId =
    input.status === "ended" ? deps.layout.archiveCategoryId : deps.layout.sessionsCategoryId;

  try {
    await ch.edit({
      name: newName,
      parent: parentId,
      reason: `session ${input.sessionId} → ${input.status}`,
    });
    deps.log.info(`session-channel: ${input.sessionId} renamed to #${newName} (parent=${parentId})`);
  } catch (e) {
    deps.log.warn(`session-channel: rename failed for ${input.sessionId}: ${(e as Error).message}`);
  }
}

/** /rename で決まったタイトルを Discord 側にも反映する (topic 更新)。 */
export async function onSessionTitleChanged(
  deps: SessionChannelDeps,
  input: { sessionId: string; title: string },
): Promise<void> {
  const row = deps.repo.findBySessionId(input.sessionId);
  if (!row) return;
  const ch = deps.guild.channels.cache.get(row.channel_id);
  if (!ch || ch.type !== ChannelType.GuildText) return;
  try {
    const baseName = titleToChannelBase(input.title);
    const nextName = applyStatusEmoji(baseName, row.status);
    const patch: { topic: string; reason: string; name?: string } = {
      topic: `${input.title.slice(0, 120)} | session ${input.sessionId}`,
      reason: `session title updated: ${input.sessionId}`,
    };
    if (deps.repo.tryClaimRename(input.sessionId, RENAME_COOLDOWN_SEC)) {
      patch.name = nextName;
    } else {
      deps.log.info(
        `session-channel: title rename deferred for ${input.sessionId} (cooldown < ${RENAME_COOLDOWN_SEC}s)`,
      );
    }
    await ch.edit(patch);
    deps.log.info(
      `session-channel: title updated for ${input.sessionId} topic=ok name=${patch.name ?? "(unchanged)"}`,
    );
  } catch (e) {
    deps.log.warn(`session-channel: title update failed for ${input.sessionId}: ${(e as Error).message}`);
  }
}

function titleToChannelBase(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9\u3040-\u30ff\u3400-\u9fff-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 88);
  return s || "session";
}
