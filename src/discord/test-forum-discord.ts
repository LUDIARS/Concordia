/**
 * Test Forum 投稿の Discord 側 (作成 / 編集リフレッシュ / クローズ)。
 * @implements spec/feature/revisor-test-forum-sync.md — Source and lifecycle
 */
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  StringSelectMenuBuilder,
  type AnyThreadChannel,
  type ForumChannel,
  type Guild,
  type MessageActionRowComponentBuilder,
} from "discord.js";
import type { DiscordTestSurfaceRow } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrDetail } from "../pr/revisor-test-workflow-client.js";
import {
  buildTestControlId,
  describeRunConfig,
  providerChoiceValue,
  TEST_PROVIDER_CHOICES,
  testControlLayout,
  testEffortChoices,
} from "./test-forum-controls.js";
import type {
  TestForumCandidate,
  TestForumSurfaceAdapter,
  TestSurfaceCloseReason,
} from "./test-forum-reconcile.js";
import { reconcileTestForumTagIds } from "./test-forum-status-tags.js";

// 投稿本文には PR タイトル・説明・判断事項がそのまま載る。 これらは Revisor 経由の
// 外部由来テキストなので、 `@everyone` 等が混ざっても誰にも通知が飛ばないようにする
// (Bot 発言の既定作法: ingress.ts / forum-spawn-session.ts と同じ)。
const NO_MENTIONS = { parse: [] as never[] };

/**
 * 素の `slice` はサロゲートペア (絵文字等) の途中で切れて壊れた文字を作り、
 * Discord に 400 で弾かれうる。 末尾が上位サロゲートなら 1 文字落として切る。
 */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(max - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

function threadName(candidate: TestForumCandidate): string {
  const repo = candidate.repoOrigin.split("/").pop() ?? candidate.repoOrigin;
  return clip(`[${repo} #${candidate.prNumber}] ${candidate.title}`.replace(/\s+/g, " "), 100);
}

function detailLines(detail: RevisorLocalPrDetail): string[] {
  const lines: string[] = [];
  if (detail.decisionLabel) lines.push(`**判定** ${detail.decisionLabel}`);
  if (detail.riskScore !== null) {
    const threshold = detail.riskThreshold !== null ? ` / 閾値 ${detail.riskThreshold}` : "";
    const band = detail.riskBandLabel ? ` (${detail.riskBandLabel})` : "";
    lines.push(`**マージリスク** ${detail.riskScore}${band}${threshold}`);
  }
  if (detail.testsRan !== null) {
    lines.push(`**テスト** ${detail.testsPassed ?? 0}/${detail.testsRan} passed`);
  }
  if (detail.securityStatus) lines.push(`**セキュリティスキャン** ${detail.securityStatus}`);
  lines.push(`**動作確認** ${detail.runtimeVerificationRequired ? "人間による動作確認が必要" : "登録テストで足りる"}`);
  if (detail.autoMerge) {
    lines.push(`**オートマージ** ${detail.autoMerge.merged ? "済み" : "見送り"} — ${detail.autoMerge.reason}`);
  }
  if (detail.blockers.length > 0) {
    lines.push("**判断事項**");
    // Discord のメッセージ上限 (2000 字) に収める。 判断事項が主役なので 8 件まで。
    for (const blocker of detail.blockers.slice(0, 8)) lines.push(`- ${clip(blocker, 180)}`);
    if (detail.blockers.length > 8) lines.push(`- 他 ${detail.blockers.length - 8} 件`);
  }
  if (detail.body) {
    lines.push("**PR 説明 (抜粋)**");
    lines.push(clip(detail.body, 400));
  }
  return lines;
}

const CHECK_STATUS_LABELS: Record<string, string> = {
  queued: "審査待ち",
  running: "審査中",
  test_ok: "Test OK",
  failed: "審査失敗",
  action_required: "人間の判断が必要",
};

export function checkStatusLabel(checkStatus: string): string {
  return CHECK_STATUS_LABELS[checkStatus] ?? checkStatus;
}

export function statusChangeMessage(candidate: TestForumCandidate): string {
  if (candidate.checkStatus === "test_ok") {
    return "✅ 審査を通過しました (Test OK)。操作面の「テスト開始」でセッションを起動、「マージ」で squash merge できます。";
  }
  if (candidate.checkStatus === "failed") {
    const reason = candidate.detail?.blockers[0] ? `\n> ${clip(candidate.detail.blockers[0], 300)}` : "";
    return `❌ 審査に失敗しました。${reason}`;
  }
  const blockers = (candidate.detail?.blockers ?? []).slice(0, 3).map((b) => `> ${clip(b, 200)}`).join("\n");
  return `⚠️ 審査は完了しましたが人間の判断が必要です。\n${blockers}`;
}

export function starterContent(candidate: TestForumCandidate): string {
  const lines = [
    `**Test candidate** ${candidate.url ? `[#${candidate.prNumber}](${candidate.url})` : `#${candidate.prNumber}`}`,
    `**Repo** \`${candidate.repoOrigin}\``,
    `**状態** ${checkStatusLabel(candidate.checkStatus)}`,
    `**Head** \`${candidate.headBranch}\` @ \`${candidate.headSha}\``,
    `**Spawn root** \`${candidate.repoRootPath}\``,
    `**Active worktree** ${candidate.worktreePath ? `\`${candidate.worktreePath}\`` : "テスト開始時に解決"}`,
    ...(candidate.detail ? detailLines(candidate.detail) : []),
    "Revisor に登録された時点で掲載されます。内容が変わると Cc がこの投稿を編集で更新し、マージ・取り下げで対象外になると閉じます。このスレッドに書き込むとテストセッションが対応します。",
  ];
  return clip(lines.join("\n"), 2000);
}

async function resolveThread(
  guild: Guild,
  threadId: string,
): Promise<AnyThreadChannel | null> {
  const cached = guild.channels.cache.get(threadId);
  const channel = cached ?? await guild.channels.fetch(threadId).catch(() => null);
  if (!channel) return null;
  if (channel.type !== ChannelType.PublicThread && channel.type !== ChannelType.PrivateThread) {
    throw new Error(`Test surface is not a thread: ${threadId}`);
  }
  return channel;
}

function findTestForum(guild: Guild, forumId: string): ForumChannel | null {
  const forum = guild.channels.cache.get(forumId);
  if (!forum || forum.type !== ChannelType.GuildForum) {
    return null;
  }
  return forum;
}

function appliedStatusTags(
  forum: ForumChannel | null,
  candidate: TestForumCandidate,
  current: readonly string[] = [],
): string[] | null {
  if (!forum || !forum.availableTags?.length) return null;
  return reconcileTestForumTagIds(
    forum.availableTags,
    current,
    candidate.checkStatus,
    candidate.detail?.mergeable === true,
  );
}

/** 操作面は状態遷移モジュールから組み立て、Discord API 固有の部品だけをここに閉じ込める。 */
export function renderTestForumControls(surface: DiscordTestSurfaceRow): {
  content: string;
  components: ActionRowBuilder<MessageActionRowComponentBuilder>[];
} {
  const layout = testControlLayout(surface.run_state);
  const config = { provider: surface.provider, model: surface.model, effort: surface.effort };
  const rows: ActionRowBuilder<MessageActionRowComponentBuilder>[] = [];
  if (layout.selectors) {
    const provider = new StringSelectMenuBuilder()
      .setCustomId(buildTestControlId("provider", surface.id))
      .setPlaceholder("テスト provider / model")
      .addOptions(TEST_PROVIDER_CHOICES.map((choice) => ({
        label: choice.label,
        value: choice.value,
        default: choice.value === providerChoiceValue(config),
      })));
    const effort = new StringSelectMenuBuilder()
      .setCustomId(buildTestControlId("effort", surface.id))
      .setPlaceholder("reasoning effort")
      .addOptions(testEffortChoices(config.provider)
        .map((value) => ({ label: value, value, default: value === config.effort })));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(provider));
    rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(effort));
  }
  if (layout.primary) {
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildTestControlId(layout.primary.action, surface.id))
        .setLabel(layout.primary.label)
        .setStyle(layout.primary.style === "primary" ? ButtonStyle.Primary : ButtonStyle.Success),
    ));
  }
  const state = surface.run_state === "starting" ? "\n**状態** テストセッションを起動しています…" : "";
  return { content: `${describeRunConfig(config)}${state}`, components: rows };
}

/**
 * 操作面の書き込み先スレッド。 Forum thread は無操作で自動 archive され、 archive 中は
 * 投稿も編集も拒否されるので (update と同じ理由)、 書き込む前に解除する。
 */
async function requireWritableThread(
  guild: Guild,
  threadId: string,
  reason: string,
): Promise<AnyThreadChannel> {
  const thread = await resolveThread(guild, threadId);
  if (!thread) throw new Error(`Test surface thread is unavailable: ${threadId}`);
  if (thread.archived) await thread.setArchived(false, reason);
  return thread;
}

/** Persisted controls_message_id identifies the one message whose controls change with run_state. */
export async function refreshTestForumControls(
  guild: Guild,
  surface: DiscordTestSurfaceRow,
): Promise<void> {
  if (!surface.controls_message_id) throw new Error(`Test surface controls message is missing: ${surface.id}`);
  const thread = await requireWritableThread(guild, surface.thread_id, "Concordia test controls refreshed");
  const message = await thread.messages.fetch(surface.controls_message_id);
  await message.edit(renderTestForumControls(surface));
}

export function createTestForumDiscordAdapter(
  guild: Guild,
  forumId: string,
): TestForumSurfaceAdapter {
  return {
    async create(candidate) {
      const forum = findTestForum(guild, forumId);
      if (!forum) throw new Error(`Test forum is unavailable: ${forumId || "(empty id)"}`);
      const statusTags = appliedStatusTags(forum, candidate);
      const thread = await forum.threads.create({
        name: threadName(candidate),
        message: { content: starterContent(candidate), allowedMentions: NO_MENTIONS },
        ...(statusTags ? { appliedTags: statusTags } : {}),
        reason: `Concordia test candidate ${candidate.repoOrigin}#${candidate.prNumber}@${candidate.headSha}`,
      });
      // 提出セッションを操作していた人たちに掲載を知らせる。 starter とは別メッセージに
      // するのは、 starter は常にメンション抑制 (外部由来テキスト) のため。
      // ここで throw すると thread は立ったのに DB 行が作られず、 次周期が同じ PR の
      // 投稿を二重に立ててしまう。 メンションは掲載の従なので best-effort に留める。
      if (candidate.mentionUserIds.length > 0) {
        const mentions = candidate.mentionUserIds.map((id) => `<@${id}>`).join(" ");
        await thread.send({
          content: `${mentions} ${candidate.repoOrigin} #${candidate.prNumber} が Revisor に登録されました (${checkStatusLabel(candidate.checkStatus)})。`,
          allowedMentions: { users: [...candidate.mentionUserIds] },
        }).catch(() => undefined);
      }
      return { threadId: thread.id };
    },
    async update(surface: DiscordTestSurfaceRow, candidate: TestForumCandidate) {
      const thread = await resolveThread(guild, surface.thread_id);
      if (!thread) return;
      // Forum thread は無操作で自動 archive される。 archive 中は編集も rename も
      // 拒否されるので、 掲載継続中の候補は先に解除してから書き換える。
      if (thread.archived) {
        await thread.setArchived(false, "Concordia test candidate refreshed");
      }
      const starter = await thread.fetchStarterMessage().catch(() => null);
      if (starter) {
        await starter.edit({ content: starterContent(candidate), allowedMentions: NO_MENTIONS });
      }
      const name = threadName(candidate);
      if (thread.name !== name) {
        await thread.setName(name, "Concordia test candidate refreshed");
      }
      const currentTags = thread.appliedTags ?? [];
      const tags = appliedStatusTags(findTestForum(guild, forumId), candidate, currentTags);
      if (tags && [...currentTags].sort().join("\0") !== [...tags].sort().join("\0")) {
        await thread.setAppliedTags(tags, "Concordia test candidate status refreshed");
      }
    },
    async render(surface) {
      const thread = await requireWritableThread(guild, surface.thread_id, "Concordia test controls posted");
      const message = await thread.send(renderTestForumControls(surface));
      return { controlsMessageId: message.id };
    },
    async postStatusChange(surface: DiscordTestSurfaceRow, candidate: TestForumCandidate) {
      const thread = await resolveThread(guild, surface.thread_id);
      if (!thread) return;
      await thread.send({ content: statusChangeMessage(candidate), allowedMentions: NO_MENTIONS });
    },
    async close(surface: DiscordTestSurfaceRow, reason: TestSurfaceCloseReason) {
      const thread = await resolveThread(guild, surface.thread_id);
      if (!thread) return;
      if (!thread.archived) {
        await thread.setArchived(true, `Concordia test candidate closed: ${reason}`);
      }
    },
  };
}
