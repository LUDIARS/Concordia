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
 *
 * 承認カードは **起動に要る情報が揃ってから** 出す (2026-09-03 neco 指示: 承認 → 関係
 * プロジェクト設定の順だと、承認後の内容変更として弾かれる)。 不足情報の聞き返し
 * (forum-spawn-intake.ts) とモデル/Effort の選択を先に済ませ、確定した関係プロジェクト /
 * モデル / effort / 補完済み本文をスナップショットとして承認対象にする。 カードには
 * その内容を人間向けに載せ、末尾の JSON ブロックで再起動後の復元にも使う。
 */

import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Interaction,
} from "discord.js";
import type { ApprovedForumSpawnContent } from "./forum-spawn.js";

const CUSTOM_ID_PREFIX = "forum-spawn-approval:";
const REQUEST_TTL_MS = 60 * 60 * 1000;
const CONTENT_FINGERPRINT_HEX_LENGTH = 32;
const DISCORD_MESSAGE_MAX_LENGTH = 2_000;
/** カード末尾の復元用 JSON ブロックのラベル。 */
const CARD_SNAPSHOT_LABEL = "起動内容 (再起動後の復元用)";
const consumedTokensByStore = new WeakMap<ForumSpawnApprovalStore, Map<string, number>>();

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
    approvedContent: cloneApprovedContent(thread.approvedContent),
    createdAt: now,
  });
  try {
    await deps.postCard(
      thread.id,
      buildForumSpawnApprovalCardContent(thread.ownerId, thread.approvedContent),
      [approvalButtons(token, forumSpawnApprovalFingerprint(thread.approvedContent))],
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
  /** 承認カード投稿者として許可する、この logical Bot 自身。未配線は fail-closed。 */
  approvalCardAuthorId?: string;
  /**
   * in-memory の pending が失われた承認カード (Cc 再起動でトークンが消える) の押下から、
   * スレッドの現在内容とカード末尾のスナップショット (関係プロジェクト / モデル / effort /
   * 追記本文) を合わせて、カードの内容指紋と一致する承認対象を復元する。
   * null = 復元不可 (スレッド消失 / 対象外)。
   */
  recoverApproval?: (threadId: string, snapshot: ForumSpawnApprovalCardSnapshot | null) => Promise<
    { requesterUserId: string; approvedContent: ApprovedForumSpawnContent } | null
  >;
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
  const card = readApprovalCard(interaction);
  if (!card || card.authorId !== deps.approvalCardAuthorId) {
    await interaction.reply({ content: "この承認要求は無効です。", ephemeral: true });
    return;
  }
  const now = deps.now?.() ?? Date.now();
  const store = deps.store;
  const stored = store?.get(parsed.token);
  const storedValid = stored !== undefined && isWithinApprovalTtl(stored.createdAt, now);
  if (stored && !storedValid) store?.delete(parsed.token);
  let pending: PendingForumSpawnApproval | null = storedValid ? stored ?? null : null;
  if (!pending) {
    // Cc 再起動で in-memory pending が消えてもカードは残る (2026-09-02 neco 報告:
    // 承認ボタンが「失効」— 実原因は失敗押下の消費ではなくデプロイ再起動の store 消失)。
    // カード (メッセージ) の作成時刻を TTL として引き継ぎ、期限内かつカード作成時の
    // 内容指紋と一致するときだけスレッド内容から承認対象を復元する。
    // 復元は bot 自身が投稿した、内容指紋つきの新形式カードだけに限定する。token が
    // memory から消えた後に、別 bot の同形式ボタンや編集後の本文を承認対象へ昇格させない。
    if (
      isWithinApprovalTtl(card.createdAt, now)
      && parsed.contentFingerprint
      && deps.recoverApproval
      && interaction.channelId
      && interaction.guildId
    ) {
      const recoveredPending = await deps
        .recoverApproval(interaction.channelId, parseForumSpawnApprovalCardSnapshot(card.content))
        .catch(() => null);
      if (
        recoveredPending
        && forumSpawnApprovalFingerprint(recoveredPending.approvedContent) === parsed.contentFingerprint
      ) {
        pending = {
          guildId: interaction.guildId,
          threadId: interaction.channelId,
          requesterUserId: recoveredPending.requesterUserId,
          approvedContent: recoveredPending.approvedContent,
          createdAt: card.createdAt,
        };
        deps.log.info(
          `forum-spawn approval recovered after store loss thread=${interaction.channelId} by=${interaction.user.id}`,
        );
      }
    }
    if (!pending) {
      await interaction.reply({ content: "この承認要求は失効しています。新しいスレッドで再申請してください。", ephemeral: true });
      return;
    }
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

  // interaction.update() より先に同期的に claim し、同じカードの並行押下が store-loss
  // 復元を経由して二重 spawn になるのを防ぐ。消費済み token は store ごとに TTL 保持する。
  if (!store || !claimApprovalToken(store, parsed.token, now)) {
    await interaction.reply({ content: "この承認要求は失効しています。", ephemeral: true });
    return;
  }
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
    if (!isWithinApprovalTtl(pending.createdAt, now)) store.delete(token);
  }
}

function uniqueToken(store: ForumSpawnApprovalStore): string {
  let token = randomUUID().replace(/-/g, "").slice(0, 16);
  while (store.has(token)) token = randomUUID().replace(/-/g, "").slice(0, 16);
  return token;
}

/**
 * 再起動後もカード作成時の承認対象を検証できる、custom-id 用の短い内容指紋。
 * 情報充足後に確定した関係プロジェクト / モデル / effort / テンプレも含める
 * (承認したのは「この内容で起動すること」なので、選択の差し替えも改変として弾く)。
 */
export function forumSpawnApprovalFingerprint(content: ApprovedForumSpawnContent): string {
  return createHash("sha256")
    .update(JSON.stringify({
      title: content.title,
      body: content.body,
      appliedTags: [...content.tagState.appliedTags].sort(),
      project: content.project ?? null,
      model: content.model ?? null,
      effort: content.effort ?? null,
      template: content.template ?? null,
    }), "utf8")
    .digest("hex")
    .slice(0, CONTENT_FINGERPRINT_HEX_LENGTH);
}

/** カード末尾の base64url 化 JSON に載せる、スレッド本文からは復元できない承認対象の差分。 */
export interface ForumSpawnApprovalCardSnapshot {
  project?: string;
  model?: string;
  effort?: string;
  template?: string;
  /** 不足情報の回答で starter 本文の後ろに足した部分 (`supplementForumSpawnBody` の追記)。 */
  additions?: string;
}

/**
 * 承認カードの本文。 承認者が「何を起動するか」を見て押せるように、確定した関係プロジェクト /
 * モデル / effort / 追記本文を人間向けに載せ、末尾に復元用の base64url 化 JSON を添える。
 */
export function buildForumSpawnApprovalCardContent(
  requesterUserId: string,
  content: ApprovedForumSpawnContent,
): string {
  const snapshot = approvalCardSnapshot(content);
  const additions = snapshot.additions;
  let rendered = renderForumSpawnApprovalCardContent(requesterUserId, content, additions, snapshot);
  if (rendered.length > DISCORD_MESSAGE_MAX_LENGTH && additions) {
    // 追記は承認者に必ず見せる。二重掲載で上限を超えるときだけ JSON 側から外し、
    // 再起動後の復元を fail-closed にする (in-memory pending からの承認は継続できる)。
    const snapshotWithoutAdditions = { ...snapshot };
    delete snapshotWithoutAdditions.additions;
    rendered = renderForumSpawnApprovalCardContent(
      requesterUserId,
      content,
      additions,
      snapshotWithoutAdditions,
    );
  }
  if (rendered.length > DISCORD_MESSAGE_MAX_LENGTH) {
    throw new Error("forum spawn approval content exceeds Discord message limit");
  }
  return rendered;
}

function renderForumSpawnApprovalCardContent(
  requesterUserId: string,
  content: ApprovedForumSpawnContent,
  additions: string | undefined,
  snapshot: ForumSpawnApprovalCardSnapshot,
): string {
  const lines = [
    `<@${requesterUserId}> にはセッション起動権限がありません。`
      + "管理職以上が「起動を許可」を押すと、以下の内容でセッションを起動します (1時間で失効)。",
    "",
    `- 関係プロジェクト: **${content.project ?? "(投稿から解決)"}**`,
    content.model
      ? `- モデル: **${content.model}**${content.effort ? ` / effort: **${content.effort}**` : ""}`
      : content.template
        ? `- 起動テンプレ: **${content.template}**`
        : "- モデル: (投稿から解決)",
  ];
  if (additions) {
    lines.push("- 追記された内容:", "```", additions.replace(/```/g, "` ` `"), "```");
  }
  lines.push(`${CARD_SNAPSHOT_LABEL}: \`${encodeApprovalCardSnapshot(snapshot)}\``);
  return lines.join("\n");
}

/** カード本文から復元用スナップショットを読む。 無い / 壊れている場合は null。 */
export function parseForumSpawnApprovalCardSnapshot(content: string | null): ForumSpawnApprovalCardSnapshot | null {
  if (!content) return null;
  const marker = `${CARD_SNAPSHOT_LABEL}: \``;
  const start = content.lastIndexOf(marker);
  if (start < 0) return null;
  const jsonStart = start + marker.length;
  const end = content.indexOf("`", jsonStart);
  if (end < 0) return null;
  const serialized = content.slice(jsonStart, end);
  let parsed: unknown;
  try {
    // 旧カードの平文 JSON も読み続ける。新形式は Markdown の区切り文字を含まない
    // base64url とし、追記中のバッククォートで途中切断されないようにする。
    const json = serialized.startsWith("{")
      ? serialized
      : Buffer.from(serialized, "base64url").toString("utf8");
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const snapshot: ForumSpawnApprovalCardSnapshot = {};
  for (const key of ["project", "model", "effort", "template", "additions"] as const) {
    const value = record[key];
    if (typeof value === "string" && value) snapshot[key] = value;
  }
  return snapshot;
}

function encodeApprovalCardSnapshot(snapshot: ForumSpawnApprovalCardSnapshot): string {
  return Buffer.from(JSON.stringify(snapshot), "utf8").toString("base64url");
}

function approvalCardSnapshot(content: ApprovedForumSpawnContent): ForumSpawnApprovalCardSnapshot {
  const snapshot: ForumSpawnApprovalCardSnapshot = {};
  if (content.project) snapshot.project = content.project;
  if (content.model) snapshot.model = content.model;
  if (content.effort) snapshot.effort = content.effort;
  if (content.template) snapshot.template = content.template;
  const starter = content.starterBody ?? content.body;
  if (content.body !== starter && content.body.startsWith(starter)) {
    const additions = content.body.slice(starter.length).trim();
    if (additions) snapshot.additions = additions;
  }
  return snapshot;
}

function cloneApprovedContent(content: ApprovedForumSpawnContent): ApprovedForumSpawnContent {
  return {
    title: content.title,
    body: content.body,
    ...(content.starterBody !== undefined ? { starterBody: content.starterBody } : {}),
    tagState: {
      appliedTags: [...content.tagState.appliedTags],
      availableTags: content.tagState.availableTags.map((tag) => ({ ...tag })),
    },
    ...(content.project ? { project: content.project } : {}),
    ...(content.model ? { model: content.model } : {}),
    ...(content.effort ? { effort: content.effort } : {}),
    ...(content.template ? { template: content.template } : {}),
  };
}

function readApprovalCard(interaction: Interaction): { createdAt: number; authorId: string; content: string | null } | null {
  const message = (interaction as {
    message?: { createdTimestamp?: unknown; author?: { id?: unknown }; content?: unknown };
  }).message;
  return typeof message?.createdTimestamp === "number"
    && Number.isFinite(message.createdTimestamp)
    && typeof message.author?.id === "string"
    ? {
      createdAt: message.createdTimestamp,
      authorId: message.author.id,
      content: typeof message.content === "string" ? message.content : null,
    }
    : null;
}

function isWithinApprovalTtl(createdAt: number, now: number): boolean {
  const age = now - createdAt;
  return age >= 0 && age <= REQUEST_TTL_MS;
}

function claimApprovalToken(store: ForumSpawnApprovalStore, token: string, now: number): boolean {
  let consumed = consumedTokensByStore.get(store);
  if (!consumed) {
    consumed = new Map();
    consumedTokensByStore.set(store, consumed);
  }
  for (const [consumedToken, consumedAt] of consumed) {
    if (!isWithinApprovalTtl(consumedAt, now)) consumed.delete(consumedToken);
  }
  if (consumed.has(token)) return false;
  consumed.set(token, now);
  store.delete(token);
  return true;
}

function parseCustomId(customId: string): {
  decision: "allow" | "deny";
  token: string;
  contentFingerprint: string | null;
} | null {
  const match = new RegExp(
    `^forum-spawn-approval:(allow|deny):([^:]+)(?::([a-f0-9]{${CONTENT_FINGERPRINT_HEX_LENGTH}}))?$`,
  ).exec(customId);
  if (!match) return null;
  return {
    decision: match[1] as "allow" | "deny",
    token: match[2]!,
    contentFingerprint: match[3] ?? null,
  };
}

function approvalButtons(token: string, contentFingerprint: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}allow:${token}:${contentFingerprint}`)
      .setLabel("起動を許可")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${CUSTOM_ID_PREFIX}deny:${token}:${contentFingerprint}`)
      .setLabel("却下")
      .setStyle(ButtonStyle.Danger),
  );
}
