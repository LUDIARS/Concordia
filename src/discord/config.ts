import type { ForumChannel, Guild, GuildForumTagData } from "discord.js";
import { ChannelType } from "discord.js";
import type { DiscordConfigRepo } from "../db/discord-repo.js";
import { META_CHANNEL_KIND, type MetaChannelKind } from "./types.js";
import {
  MAX_FORUM_TAGS,
  SESSION_WORK_TAG_NAMES,
  SESSION_RUNTIME_RULE_TAG_NAMES,
  desiredSessionForumTagNames,
  mergeForumSiteTags,
  type ForumSiteTagSkipReason,
  type ForumTemplateTagSource,
} from "./forum-template-tags.js";
import { CONCORDIA_MANAGED_FORUM_TAG_NAME } from "./forum-system-tag.js";
import { reportError } from "../errors.js";

export interface DiscordConfigSnapshot {
  guildId: string;
  forumMode: boolean;
  sessionForumId: string;
  testForumId: string;
  taskWorkflowForumId: string;
  metaCategoryId: string;
  sessionsCategoryId: string;
  statusCategoryId: string;
  archiveCategoryId: string;
  costChannelId: string;
  activityChannelId: string;
  monitorChannelId: string;
  prQueueChannelId: string;
  errorCategoryId: string;
  errorChannelId: string;
  metaChannels: Record<MetaChannelKind, string>;
}

const META_CATEGORY_KEY = "meta_category_id";
const SESSION_FORUM_KEY = "session_forum_id";
const TEST_FORUM_KEY = "test_forum_id";
const TASK_WORKFLOW_FORUM_KEY = "task_workflow_forum_id";
const SESSIONS_CATEGORY_KEY = "sessions_category_id";
const STATUS_CATEGORY_KEY = "status_category_id";
const ARCHIVE_CATEGORY_KEY = "archive_category_id";
const COST_CHANNEL_KEY = "cost_channel_id";
const ACTIVITY_CHANNEL_KEY = "activity_channel_id";
const MONITOR_CHANNEL_KEY = "monitor_channel_id";
const PR_QUEUE_CHANNEL_KEY = "pr_queue_channel_id";
const ERROR_CATEGORY_KEY = "error_category_id";
const ERROR_CHANNEL_KEY = "error_channel_id";

const CATEGORY_NAMES = {
  meta: "meta",
  sessions: "sessions",
  status: "状態",
  archive: "archive",
  error: "エラー",
} as const;

const FORUM_NAMES = {
  session: "Session",
  test: "Test",
  taskWorkflow: "TaskWorkflow",
} as const;

export const SESSION_FORUM_TOPIC = [
  "新規投稿からCcセッションを起動します。",
  "1. タイトルを「[project code] 作業概要」にし、本文へ依頼内容・完了条件を書く。",
  "2. 投稿内容からCcが起動テンプレを選択し、Ccがセッションをspawnします。",
  "3. 起動後は状態・会話・結果を同じスレッドへ紐付けます。",
  "対象projectが不明な場合は起動せず、追記を依頼します。",
].join("\n");

const TASK_WORKFLOW_FORUM_TOPIC =
  "Delegation runごとの進行・状態・結果を1スレッドに集約します。Sessionフォーラムの新規投稿から直接作る場所ではありません。";

export const TEST_FORUM_TOPIC =
  "Open/Draft PR の現在の head commit と worktree を起動時に同期します。更新・close・merge・worktree削除で古いスレッドを閉じます。";

export const SESSION_STATE_TAG_NAMES = {
  working: "作業中",
  active: "待機",
  lost: "lost",
} as const;

const META_CHANNEL_NAMES: Record<MetaChannelKind, string> = {
  chitchat: "雑談",
  consultation: "相談",
  houkoku: "houkoku",
  boyaki: "ぼやき",
  system: "system",
};

/**
 * レイアウト生成オプション。 子会社 Bot は本社のような雑談 (meta) / pr-queue / errors を
 * 持たず、 受付 + セッション系だけの slim 構成にする (ユーザ要望)。 省略時は全部作る (本社)。
 */
export interface EnsureLayoutOptions {
  /** Session / TaskWorkflow forum を使うか。Phase 3 以降の既定は true。 */
  forumMode?: boolean;
  /** meta カテゴリ配下の雑談系チャンネル (雑談/相談/houkoku/ぼやき/system) を作るか。 既定 true。 */
  includeMetaChannels?: boolean;
  /** pr-queue チャンネルを作るか。 既定 true。 */
  includePrQueue?: boolean;
  /** 「エラー」 カテゴリ + errors チャンネルを作るか。 既定 true。 */
  includeErrors?: boolean;
  /** Bot 起動時に Session forum へ不足分を補う delegation template tags。 */
  sessionForumTemplates?: readonly ForumTemplateTagSource[];
  /** Villa から解決した、active 拠点だけのPC名タグ。 */
  sessionForumSiteTags?: readonly string[];
}

export async function ensureDiscordLayout(
  guild: Guild,
  repo: DiscordConfigRepo,
  opts: EnsureLayoutOptions = {},
): Promise<DiscordConfigSnapshot> {
  const includeMetaChannels = opts.includeMetaChannels ?? true;
  const includePrQueue = opts.includePrQueue ?? true;
  const includeErrors = opts.includeErrors ?? true;
  const forumMode = opts.forumMode ?? true;
  const sessionForumTagNames = opts.sessionForumTemplates
    ? desiredSessionForumTagNames(opts.sessionForumTemplates)
    : [
        ...SESSION_WORK_TAG_NAMES,
        ...Object.values(SESSION_STATE_TAG_NAMES),
        ...SESSION_RUNTIME_RULE_TAG_NAMES,
        CONCORDIA_MANAGED_FORUM_TAG_NAME,
      ];
  // 拠点タグは「あれば良い」枠。必須タグと同列にすると、Villa 側で PC が増えた瞬間に
  // タグ上限で ensureForumTags が throw し、レイアウト同期ごと止まる。
  const sessionForumSiteTagNames = mergeSessionForumSiteTags(sessionForumTagNames, opts.sessionForumSiteTags ?? []);

  // meta カテゴリ自体は子会社でも作る (受付 (intake) チャンネルの親になるため)。
  const metaCategoryId = await ensureCategory(guild, repo, META_CATEGORY_KEY, CATEGORY_NAMES.meta);
  // Forum mode では legacy sessions/archive カテゴリを新規生成しない。既存 channel の
  // 余生と stale sweep のため、存在する場合だけ id を解決して snapshot に残す。
  const sessionsCategoryId = findExistingCategory(guild, repo, SESSIONS_CATEGORY_KEY, CATEGORY_NAMES.sessions);
  const statusCategoryId = await ensureCategory(guild, repo, STATUS_CATEGORY_KEY, CATEGORY_NAMES.status);
  const archiveCategoryId = findExistingCategory(guild, repo, ARCHIVE_CATEGORY_KEY, CATEGORY_NAMES.archive);
  const sessionForumId = forumMode
    ? await ensureForum(
        guild,
        repo,
        SESSION_FORUM_KEY,
        FORUM_NAMES.session,
        SESSION_FORUM_TOPIC,
        sessionForumTagNames,
        sessionForumSiteTagNames,
      )
    : "";
  const testForumId = forumMode
    ? await ensureForum(
        guild,
        repo,
        TEST_FORUM_KEY,
        FORUM_NAMES.test,
        TEST_FORUM_TOPIC,
      )
    : "";
  const taskWorkflowForumId = forumMode
    ? await ensureForum(
        guild,
        repo,
        TASK_WORKFLOW_FORUM_KEY,
        FORUM_NAMES.taskWorkflow,
        TASK_WORKFLOW_FORUM_TOPIC,
        [
          ...Object.values(SESSION_STATE_TAG_NAMES),
          ...SESSION_RUNTIME_RULE_TAG_NAMES,
          CONCORDIA_MANAGED_FORUM_TAG_NAME,
        ],
      )
    : "";
  // コストはカテゴリ外のルートチャンネル。既存配置も ensure 時にルートへ戻す。
  const costChannelId = await ensureTextChannel(guild, repo, COST_CHANNEL_KEY, "コスト", null);
  const activityChannelId = await ensureTextChannel(guild, repo, ACTIVITY_CHANNEL_KEY, "activity", statusCategoryId);
  const monitorChannelId = await ensureTextChannel(guild, repo, MONITOR_CHANNEL_KEY, "concordia-monitor", statusCategoryId);
  // pr-queue / errors / 雑談系 (meta) は子会社では作らない (空 id を返し、 消費側はガードで skip)。
  const prQueueChannelId = includePrQueue
    ? await ensureTextChannel(guild, repo, PR_QUEUE_CHANNEL_KEY, "pr-queue", statusCategoryId)
    : "";
  // 「エラー」 カテゴリ + errors チャンネル: 監視ロガー検知 / Discord 操作失敗の転記先.
  const errorCategoryId = includeErrors ? await ensureCategory(guild, repo, ERROR_CATEGORY_KEY, CATEGORY_NAMES.error) : "";
  const errorChannelId = includeErrors
    ? await ensureTextChannel(guild, repo, ERROR_CHANNEL_KEY, "errors", errorCategoryId)
    : "";

  const metaChannels: Record<MetaChannelKind, string> = {} as Record<MetaChannelKind, string>;
  if (includeMetaChannels) {
    for (const k of META_CHANNEL_KIND) {
      const desired = META_CHANNEL_NAMES[k];
      const id = await ensureTextChannel(guild, repo, `${k}_channel_id`, desired, metaCategoryId);
      metaChannels[k] = id;
      // 既存 channel の表示ラベルを desired に揃える (旧 romaji 名 → 日本語ラベルへ rename).
      // id 解決済みなので routing には影響しない (表示名のみ). best-effort.
      const ch = guild.channels.cache.get(id);
      if (ch && ch.type === ChannelType.GuildText && ch.name !== desired) {
        try {
          await ch.edit({ name: desired, reason: "meta channel label sync" });
        } catch {
          /* rename rate limit 等は無視。 次回 ensureDiscordLayout で再試行される。 */
        }
      }
    }
  }

  repo.set("guild_id", guild.id);
  return {
    guildId: guild.id,
    forumMode,
    sessionForumId,
    testForumId,
    taskWorkflowForumId,
    metaCategoryId,
    sessionsCategoryId,
    statusCategoryId,
    archiveCategoryId,
    costChannelId,
    activityChannelId,
    monitorChannelId,
    prQueueChannelId,
    errorCategoryId,
    errorChannelId,
    metaChannels,
  };
}

const SITE_TAG_SKIP_REASONS: Record<ForumSiteTagSkipReason, string> = {
  too_long: "Discord のタグ名上限を超えています",
  conflict: "既存タグと衝突しています",
  limit: "Discord Forum のタグ上限に達しています",
};

/**
 * 同じ skip 理由の再報告を抑える窓。
 *
 * ensureDiscordLayout は monitor / pr-queue の定期更新から繰り返し呼ばれるので、
 * 素通しすると 1 台の長すぎる PC 名で errors チャンネルが同じ警告に埋まる。
 * 恒久抑止にしないのは、解消されないまま忘れられるのを防ぐため。
 */
const SITE_TAG_SKIP_REPORT_TTL_MS = 60 * 60 * 1000;
const siteTagSkipReportedAt = new Map<string, number>();

function reportSiteTagSkip(name: string, reason: ForumSiteTagSkipReason): void {
  const key = `${reason}:${name}`;
  const now = Date.now();
  const last = siteTagSkipReportedAt.get(key);
  if (last !== undefined && now - last < SITE_TAG_SKIP_REPORT_TTL_MS) return;
  siteTagSkipReportedAt.set(key, now);
  for (const [k, ts] of siteTagSkipReportedAt) {
    if (now - ts >= SITE_TAG_SKIP_REPORT_TTL_MS) siteTagSkipReportedAt.delete(k);
  }
  reportError("discord", `拠点タグを作成しません: ${SITE_TAG_SKIP_REASONS[reason]} (${name})`);
}

/** 採用できる拠点タグ名だけを返し、落としたものは理由つきで報告する。 */
function mergeSessionForumSiteTags(baseNames: readonly string[], siteNames: readonly string[]): string[] {
  const merged = mergeForumSiteTags(baseNames, siteNames);
  for (const { name, reason } of merged.skipped) reportSiteTagSkip(name, reason);
  return merged.accepted;
}

function findExistingCategory(
  guild: Guild,
  repo: DiscordConfigRepo,
  key: string,
  name: string,
): string {
  const cached = repo.get(key);
  if (cached) {
    const ch = guild.channels.cache.get(cached);
    if (ch?.type === ChannelType.GuildCategory) return cached;
  }
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (!existing) return "";
  repo.set(key, existing.id);
  return existing.id;
}

async function ensureForum(
  guild: Guild,
  repo: DiscordConfigRepo,
  key: string,
  name: string,
  topic: string,
  requiredTagNames: readonly string[] = [],
  optionalTagNames: readonly string[] = [],
): Promise<string> {
  const cached = repo.get(key);
  let forum = cached ? guild.channels.cache.get(cached) : null;
  if (forum?.type !== ChannelType.GuildForum) {
    forum = guild.channels.cache.find((c) => c.type === ChannelType.GuildForum && c.name === name) ?? null;
  }
  if (!forum) {
    forum = await guild.channels.create({ name, type: ChannelType.GuildForum, topic });
  }
  repo.set(key, forum.id);
  const forumChannel = forum as ForumChannel;
  if (forumChannel.topic !== topic) {
    await forumChannel.edit({ topic, reason: "Concordia forum details sync" });
  }
  await ensureForumTags(forumChannel, requiredTagNames, optionalTagNames);
  return forum.id;
}

/**
 * 不足タグを補う。required は入らなければ throw (設定不備として気付かせる) だが、
 * optional (拠点タグ) は入る分だけ作って残りは warn する — 外部 (Villa) 由来で増減する
 * 名前のために、必須タグごとレイアウト同期が落ちるのを避ける。
 */
async function ensureForumTags(
  forum: ForumChannel,
  requiredTagNames: readonly string[],
  optionalTagNames: readonly string[] = [],
): Promise<void> {
  const isMissing = (name: string): boolean => !forum.availableTags.some((tag) => tag.name === name);
  const missingRequired = requiredTagNames.filter(isMissing);
  if (missingRequired.length > 0 && forum.availableTags.length + missingRequired.length > MAX_FORUM_TAGS) {
    throw new Error(
      `Discord forum ${forum.name} has no room for required tags: ${missingRequired.join(", ")}`,
    );
  }
  const room = Math.max(0, MAX_FORUM_TAGS - forum.availableTags.length - missingRequired.length);
  const missingOptional = optionalTagNames.filter(isMissing);
  for (const name of missingOptional.slice(room)) reportSiteTagSkip(name, "limit");
  const missing = [...missingRequired, ...missingOptional.slice(0, room)];
  if (missing.length === 0) return;
  const tags: GuildForumTagData[] = [
    ...forum.availableTags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      moderated: tag.moderated,
      emoji: tag.emoji ?? undefined,
    })),
    ...missing.map((tagName) => ({ name: tagName, moderated: false })),
  ];
  await forum.setAvailableTags(tags, "Concordia forum layout sync");
}

/**
 * 子会社 Bot の受付 (intake) チャンネルを guild 内に自動作成する (無ければ作る・冪等)。
 * 受付チャンネルは手動設定不要 — 子会社 Bot 起動時にこの helper で勝手に用意する。
 * meta カテゴリ配下に「受付」テキストチャンネルを 1 本だけ確保し、 その id を返す。
 */
export async function ensureIntakeChannel(
  guild: Guild,
  repo: DiscordConfigRepo,
  parentId: string,
): Promise<string> {
  return ensureTextChannel(guild, repo, "intake_channel_id", "受付", parentId);
}

/**
 * 本社サーバ内の軽量窓口 (desk) の依頼チャンネルを確保する (無ければ作る・冪等)。
 * 子会社の受付チャンネルと違い本社 guild 内に作るので、 窓口ごとに config key と
 * チャンネル名を分ける (既定名「タスク依頼」)。 spec/feature/subsidiary-delegation.md §9。
 */
/** 本社内 desk の依頼チャンネル名の既定 (窓口名が空のとき使う)。 */
export const DEFAULT_DESK_CHANNEL_NAME = "タスク依頼";

export async function ensureDeskChannel(
  guild: Guild,
  repo: DiscordConfigRepo,
  deskId: string,
  channelName: string,
  parentId: string,
): Promise<string> {
  return ensureTextChannel(guild, repo, `desk_channel_id:${deskId}`, channelName, parentId);
}

async function ensureCategory(guild: Guild, repo: DiscordConfigRepo, key: string, name: string): Promise<string> {
  const cached = repo.get(key);
  if (cached) {
    const ch = guild.channels.cache.get(cached);
    if (ch?.type === ChannelType.GuildCategory) return cached;
  }
  const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
  if (existing) {
    repo.set(key, existing.id);
    return existing.id;
  }
  const created = await guild.channels.create({ name, type: ChannelType.GuildCategory });
  repo.set(key, created.id);
  return created.id;
}

async function ensureTextChannel(
  guild: Guild,
  repo: DiscordConfigRepo,
  key: string,
  name: string,
  parentId: string | null,
): Promise<string> {
  const cached = repo.get(key);
  if (cached) {
    const ch = guild.channels.cache.get(cached);
    if (ch && (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement)) {
      if (ch.parentId !== parentId) await ch.edit({ parent: parentId, reason: `${name} channel category sync` });
      return cached;
    }
  }
  const existing = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name,
  );
  if (existing) {
    if (existing.parentId !== parentId && existing.type === ChannelType.GuildText) {
      await existing.edit({ parent: parentId, reason: `${name} channel category sync` });
    }
    repo.set(key, existing.id);
    return existing.id;
  }
  const created = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    ...(parentId ? { parent: parentId } : {}),
  });
  repo.set(key, created.id);
  return created.id;
}

