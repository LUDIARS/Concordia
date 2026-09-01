/**
 * Forum spawn の許可ボタン。
 *
 * Session forum へ spawn 権限の無いメンバーがスレッドを立てたとき、平文の拒否で
 * 終わらせず「管理職以上が押すと起動する」承認カードをスレッド内へ出す
 * (2026-09-01 neco 指示: 子会社 forum spawn の導入と同時に、権限なし投稿は
 * 管理者以上が押して効果のある許可ボタンにする)。
 *
 * `/spawn` の執行役員一回許可 (spawn-approval.ts) と違い、承認対象は「このスレッド 1 件」
 * であり、承認者がボタンを押した時点で Cc がそのまま spawn を続行する (再実行は不要)。
 * 押下者の判定は社員名簿の session_spawn capability (管理職以上) を配線する。
 */

import { randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
} from "discord.js";
import type { ApprovedForumSpawnContent } from "./forum-spawn.js";

const CUSTOM_ID_PREFIX = "forum-spawn-approval:";
const REQUEST_TTL_MS = 60 * 60 * 1000;

export interface PendingForumSpawnApproval {
  guildId: string;
  threadId: string;
  requesterUserId: string;
  approvedContent: ApprovedForumSpawnContent;
  createdAt: number;
}

export type ForumSpawnApprovalStore = Map<string, PendingForumSpawnApproval>;

export interface ForumSpawnApprovalRequestDeps {
  store: ForumSpawnApprovalStore;
  /** スレッドへ承認カード (本文 + ボタン行) を投稿する。 bot client 経由 (webhook はボタン不可)。 */
  postCard: (
    threadId: string,
    content: string,
    components: ActionRowBuilder<ButtonBuilder>[],
  ) => Promise<void>;
  now?: () => number;
}

/** スレッド 1 件の承認要求を積み、承認カードを投稿する。 同一スレッドの pending は再掲しない。 */
export async function requestForumSpawnApproval(
  deps: ForumSpawnApprovalRequestDeps,
  thread: { id: string; guildId: string; ownerId: string; approvedContent: ApprovedForumSpawnContent },
): Promise<void> {
  const now = deps.now?.() ?? Date.now();
  pruneForumSpawnApprovals(deps.store, now);
  const duplicate = [...deps.store.values()].some(
    (pending) => pending.threadId === thread.id && pending.guildId === thread.guildId,
  );
  if (duplicate) return;

  const token = uniqueToken(deps.store);
  deps.store.set(token, {
    guildId: thread.guildId,
    threadId: thread.id,
    requesterUserId: thread.ownerId,
    approvedContent: {
      title: thread.approvedContent.title,
      body: thread.approvedContent.body,
      tagState: {
        appliedTags: [...thread.approvedContent.tagState.appliedTags],
        availableTags: thread.approvedContent.tagState.availableTags.map((tag) => ({ ...tag })),
      },
    },
    createdAt: now,
  });
  try {
    await deps.postCard(
      thread.id,
      `<@${thread.ownerId}> にはセッション起動権限がありません。` +
        "管理職以上が「起動を許可」を押すと、この投稿内容でセッションを起動します (1時間で失効)。",
      [approvalButtons(token)],
    );
  } catch (error) {
    // 承認面が出せなければ pending を残さない (押せないボタンの幽霊を作らない)。
    deps.store.delete(token);
    throw error;
  }
}

export function isForumSpawnApprovalInteraction(interaction: Interaction): boolean {
  return interaction.isButton() && interaction.customId.startsWith(CUSTOM_ID_PREFIX);
}

export interface ForumSpawnApprovalDispatchDeps {
  store: ForumSpawnApprovalStore | undefined;
  /** 押下者が承認できるか (社員名簿 session_spawn = 管理職以上)。 未配線は deny (fail-closed)。 */
  isApproverAllowed?: (userId: string) => boolean;
  /** 承認されたスレッドで spawn を続行する (bot.ts が thread 再取得 + executeForumSpawn を配線)。 */
  executeSpawn?: (
    threadId: string,
    approvedContent: ApprovedForumSpawnContent,
  ) => Promise<{ ok: boolean; error?: string }>;
  log: { info: (message: string) => void; warn: (message: string) => void };
  now?: () => number;
}

export async function dispatchForumSpawnApprovalInteraction(
  interaction: Interaction,
  deps: ForumSpawnApprovalDispatchDeps,
): Promise<void> {
  if (!interaction.isButton()) return;
  const parsed = parseCustomId(interaction.customId);
  if (!parsed) return;
  const now = deps.now?.() ?? Date.now();
  const store = deps.store;
  const pending = store?.get(parsed.token);
  if (!store || !pending || now - pending.createdAt > REQUEST_TTL_MS) {
    store?.delete(parsed.token);
    await interaction.reply({ content: "この承認要求は失効しています。", ephemeral: true });
    return;
  }
  if (interaction.guildId !== pending.guildId || interaction.channelId !== pending.threadId) {
    await interaction.reply({ content: "この承認要求は別のスレッドのものです。", ephemeral: true });
    return;
  }
  // 押下の効果は管理職以上 (session_spawn) に限る。 申請者本人の自己承認も不可
  // (そもそも権限が無いので通らないが、明示して監査文面を安定させる)。
  if (
    deps.isApproverAllowed?.(interaction.user.id) !== true
    || interaction.user.id === pending.requesterUserId
  ) {
    await interaction.reply({
      content: "このボタンは管理職以上のみ有効です (申請者本人は承認できません)。",
      ephemeral: true,
    });
    return;
  }

  store.delete(parsed.token);
  if (parsed.decision === "deny") {
    deps.log.info(`forum-spawn approval denied thread=${pending.threadId} by=${interaction.user.id}`);
    await interaction.update({
      content: `<@${pending.requesterUserId}> のセッション起動は却下されました (by <@${interaction.user.id}>)。`,
      components: [],
      allowedMentions: { parse: [] },
    });
    return;
  }

  await interaction.update({
    content: `セッション起動を許可しました (by <@${interaction.user.id}>)。起動処理を続行します…`,
    components: [],
    allowedMentions: { parse: [] },
  });
  if (!deps.executeSpawn) {
    deps.log.warn(`forum-spawn approval allow but executeSpawn unwired thread=${pending.threadId}`);
    await interaction.editReply({
      content: "セッション起動処理を利用できないため、起動しませんでした。",
      components: [],
    });
    return;
  }
  try {
    const result = await deps.executeSpawn(pending.threadId, pending.approvedContent);
    if (!result.ok) {
      deps.log.warn(`forum-spawn approved spawn failed thread=${pending.threadId}: ${result.error ?? "unknown"}`);
      await interaction.editReply({
        content: "承認後に投稿内容が変更されたか、起動準備に失敗したため起動しませんでした。必要なら新しいスレッドで再申請してください。",
        components: [],
      });
    }
  } catch (error) {
    deps.log.warn(`forum-spawn approved spawn threw thread=${pending.threadId}: ${(error as Error).message}`);
    await interaction.editReply({
      content: "セッション起動処理に失敗したため、起動しませんでした。必要なら新しいスレッドで再申請してください。",
      components: [],
    });
  }
}

export function pruneForumSpawnApprovals(store: ForumSpawnApprovalStore, now = Date.now()): void {
  for (const [token, pending] of store) {
    if (now - pending.createdAt > REQUEST_TTL_MS) store.delete(token);
  }
}

function uniqueToken(store: ForumSpawnApprovalStore): string {
  let token = randomUUID().replace(/-/g, "").slice(0, 16);
  while (store.has(token)) token = randomUUID().replace(/-/g, "").slice(0, 16);
  return token;
}

function parseCustomId(customId: string): { decision: "allow" | "deny"; token: string } | null {
  const match = /^forum-spawn-approval:(allow|deny):([^:]+)$/.exec(customId);
  if (!match) return null;
  return { decision: match[1] as "allow" | "deny", token: match[2]! };
}

function approvalButtons(token: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}allow:${token}`)
      .setLabel("起動を許可")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}deny:${token}`)
      .setLabel("却下")
      .setStyle(ButtonStyle.Danger),
  );
}
