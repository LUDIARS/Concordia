/**
 * 報告用プライベートチャンネルを Bot が作る (spec/feature/private-channels.md §3)。
 *
 * - 本社 runtime だけが扱う。 依頼イベントと起動時の reconcile で pending を処理し、 1 本の列で直列に行う。
 * - チャンネル id を記録済みなら作り直さず (CC-PRIVCH-INV-02)、 閲覧者の overwrite を置き直して続きをする。
 * - 初回投稿を送ってから ready にする。 失敗したら failed と理由を残す (自動では再試行しない)。
 * - 作成・閲覧者の overwrite は相談と共通の private-channel-discord.ts を使う (CC-PRIVCH-INV-01)。
 *
 * @implements SPEC-PRIVCH-PROVISION
 */

import { ChannelType, type Guild, type TextChannel } from "discord.js";
import { viewerIdsOf, type PrivateChannelsRepo } from "../db/private-channels-repo.js";
import {
  createPrivateChannel,
  ensurePrivateCategory,
  grantPrivateViewer,
  type PrivateCategoryStore,
} from "./private-channel-discord.js";

export interface PrivateChannelProvisionerDeps {
  guild: Guild;
  repo: Pick<PrivateChannelsRepo,
    "find" | "listPending" | "recordChannel" | "recordInitialMessage" | "markReady" | "markFailed">;
  categoryStore: PrivateCategoryStore;
  log: { info: (message: string) => void; warn: (message: string) => void };
}

export interface PrivateChannelProvisioner {
  /** 1 件を処理する (列に積む)。 */
  provision(id: string): Promise<void>;
  /** pending をすべて処理する (起動時)。 */
  reconcile(): Promise<void>;
}

/** 失敗理由の長さ上限 (API で返すので短く)。 */
const MAX_ERROR = 300;

export function createPrivateChannelProvisioner(deps: PrivateChannelProvisionerDeps): PrivateChannelProvisioner {
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (id: string): Promise<void> => {
    const run = queue.then(() => provisionOne(deps, id));
    // 1 件の失敗で列を止めない (理由は provisionOne が記録する)。
    queue = run.catch(() => undefined);
    return run;
  };
  return {
    provision: enqueue,
    reconcile: async () => {
      for (const row of deps.repo.listPending()) await enqueue(row.id);
    },
  };
}

async function provisionOne(deps: PrivateChannelProvisionerDeps, id: string): Promise<void> {
  const row = deps.repo.find(id);
  if (!row || row.status !== "pending") return;
  const viewers = viewerIdsOf(row);
  if (viewers.length === 0) {
    deps.repo.markFailed(id, "no viewers");
    return;
  }
  try {
    let channel: TextChannel;
    if (row.channel_id) {
      // 前回の途中で止まった: 作り直さず、 閉じた状態を置き直してから続きをする。
      const existing = await deps.guild.channels.fetch(row.channel_id).catch(() => null);
      if (!existing || existing.type !== ChannelType.GuildText) {
        deps.repo.markFailed(id, "recorded channel is missing");
        return;
      }
      channel = existing as TextChannel;
      for (const viewer of viewers) await grantPrivateViewer(channel, viewer, "private channel resumed");
    } else {
      const categoryId = await ensurePrivateCategory(deps.guild, deps.categoryStore);
      channel = await createPrivateChannel(deps.guild, { categoryId, name: row.name, viewerIds: viewers, reason: "private channel" });
      deps.repo.recordChannel(id, { guild_id: deps.guild.id, channel_id: channel.id });
    }
    if (row.initial_text && !row.initial_message_id) {
      const message = await channel.send({ content: row.initial_text, allowedMentions: { parse: [] } });
      deps.repo.recordInitialMessage(id, message.id);
    }
    deps.repo.markReady(id);
    deps.log.info(`private channel ready id=${id} channel=${channel.id}`);
  } catch (error) {
    const reason = (error as Error).message.slice(0, MAX_ERROR);
    deps.repo.markFailed(id, reason);
    deps.log.warn(`private channel failed id=${id}: ${reason}`);
  }
}
