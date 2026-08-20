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
  TestForumTerminalPr,
  TestSurfaceCloseReason,
} from "./test-forum-reconcile.js";
import { reconcileTestForumTagIds } from "./test-forum-status-tags.js";
import { writeKeepingArchiveState } from "./thread-archive.js";

// 投稿本文には PR タイトル・説明・判断事項がそのまま載る。 これらは Revisor 経由の
// 外部由来テキストなので、 `@everyone` 等が混ざっても誰にも通知が飛ばないようにする
// (Bot 発言の既定作法: ingress.ts / forum-spawn-session.ts と同じ)。
const NO_MENTIONS = { parse: [] as never[] };
/** Discord REST の Unknown Channel。削除済み thread だけを正常な欠落として扱う。 */
const UNKNOWN_CHANNEL_ERROR_CODE = 10_003;

function isUnknownChannelError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === UNKNOWN_CHANNEL_ERROR_CODE || code === String(UNKNOWN_CHANNEL_ERROR_CODE);
}

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

function blockquote(value: string, max: number): string {
  return clip(redactSecrets(value), max)
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
}

/** Revisor のマスクが不完全でも、Discord へ資格情報を転載しないための最後の境界。 */
function redactSecrets(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:sk|gh[pousr]|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b(api[_-]?key|access[_-]?token|token|secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
      "$1=[REDACTED]",
    );
}

function failureDetailLines(detail: RevisorLocalPrDetail): string[] {
  const lines: string[] = [];
  if (detail.reviewError) {
    lines.push("**審査エラー**");
    lines.push(blockquote(detail.reviewError, 500));
  }
  if (detail.blockers.length > 0) {
    lines.push("**審査失敗の理由**");
    for (const blocker of detail.blockers.slice(0, 8)) lines.push(`- ${clip(redactSecrets(blocker), 220)}`);
    if (detail.blockers.length > 8) lines.push(`- 他 ${detail.blockers.length - 8} 件`);
  }
  if (detail.failedTests.length > 0) {
    lines.push("**失敗したテスト**");
    for (const test of detail.failedTests.slice(0, 3)) {
      const exitCode = test.exitCode === null ? "" : ` (exit ${test.exitCode})`;
      const reason = test.reason ? ` — ${clip(redactSecrets(test.reason), 160)}` : "";
      lines.push(`- ${clip(redactSecrets(test.name), 100)}${exitCode}${reason}`);
      if (test.output?.text) {
        const tail = test.output.truncated ? "[末尾のみ・秘匿値はマスク済み]\n" : "[秘匿値はマスク済み]\n";
        lines.push(blockquote(`${tail}${test.output.text}`, 650));
      }
    }
    if (detail.failedTests.length > 3) lines.push(`- 他 ${detail.failedTests.length - 3} 件`);
  }
  return lines;
}

function detailLines(detail: RevisorLocalPrDetail, includeFailureDetails = false): string[] {
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
  lines.push(`**マージ可否** ${detail.mergeable ? "マージOK" : "保留"}`);
  if (includeFailureDetails || detail.decisionState === "failed") {
    lines.push(...failureDetailLines(detail));
  } else if (detail.blockers.length > 0) {
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

export function checkStatusLabel(
  checkStatus: string,
  detail: RevisorLocalPrDetail | null = null,
): string {
  if (checkStatus === "action_required" && detail?.decisionState === "failed") {
    return "審査失敗";
  }
  return CHECK_STATUS_LABELS[checkStatus] ?? checkStatus;
}

export function statusChangeMessage(candidate: TestForumCandidate): string {
  if (candidate.checkStatus === "test_ok") {
    // 操作面は detail が明示的に mergeable と判定した場合だけ出す。詳細を取得できない
    // 途中状態で「マージOK」と案内すると、実際には実行できない操作を約束してしまう。
    const mergeable = candidate.detail?.mergeable === true;
    return [
      "✅ 審査を通過しました (Test OK)。",
      mergeable
        ? "🧪 テスト開始OK: 操作面の「テスト開始」で確認セッションを起動できます。"
        : "🧪 テスト開始OK: このスレッドへ確認指示を投稿するとセッションを起動できます。",
      !mergeable
        ? "⏸️ マージ保留: Revisor のブロック理由を解消してください。"
        : "🔀 マージOK: 確認後、操作面の「マージ」で squash merge できます。",
    ].join("\n");
  }
  if (candidate.checkStatus === "failed" || candidate.detail?.decisionState === "failed") {
    return clip([
      "❌ 審査に失敗しました。対応セッションは以下の投稿内容を先に確認してください。",
      ...(candidate.detail ? failureDetailLines(candidate.detail) : []),
    ].join("\n"), 2000);
  }
  const blockers = (candidate.detail?.blockers ?? []).slice(0, 3).map((b) => `> ${clip(b, 200)}`).join("\n");
  return `⚠️ 審査は完了しましたが人間の判断が必要です。\n${blockers}`;
}

/**
 * 「🔀 マージOK」を知らせる投稿に添えるマージボタン。
 *
 * 案内文は「操作面の『マージ』で squash merge できます」と言うが、 操作面の主ボタンが
 * マージに変わるのはテスト開始後で、 Test OK 直後には押せる場所が無かった。 案内した
 * 操作をその場で押せるように、 通知そのものにボタンを載せる。 Revisor が mergeable と
 * 判定していないときは何も出さない (実行できない操作を約束しない)。
 */
export function statusChangeComponents(
  candidate: TestForumCandidate,
  surfaceId: number,
): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
  if (candidate.checkStatus !== "test_ok" || candidate.detail?.mergeable !== true) return [];
  return [
    new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buildTestControlId("merge", surfaceId))
        .setLabel("マージ")
        .setEmoji("🔀")
        .setStyle(ButtonStyle.Success),
    ),
  ];
}

export function mergedMessage(terminal: TestForumTerminalPr): string {
  // Source の差し替え時にも外部文字列を無制限に Discord へ渡さない。Git SHA-1 / SHA-256
  // 以外は表示せず、Markdown 注入と 2,000 文字上限超過による close の永久失敗を防ぐ。
  const mergeCommitSha = terminal.mergeCommitSha?.trim();
  const commit = mergeCommitSha && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(mergeCommitSha)
    ? `\n統合コミット: \`${mergeCommitSha}\``
    : "";
  return `✅ #${terminal.prNumber} をマージしました。テスト・QA セッションを終了して、このスレッドを閉じます。${commit}`;
}

export function starterContent(candidate: TestForumCandidate): string {
  const lines = [
    `**Test candidate** ${candidate.url ? `[#${candidate.prNumber}](${candidate.url})` : `#${candidate.prNumber}`}`,
    `**Repo** \`${candidate.repoOrigin}\``,
    `**状態** ${checkStatusLabel(candidate.checkStatus, candidate.detail)}`,
    `**Head** \`${candidate.headBranch}\` @ \`${candidate.headSha}\``,
    `**Spawn root** \`${candidate.repoRootPath}\``,
    `**Active worktree** ${candidate.worktreePath ? `\`${candidate.worktreePath}\`` : "テスト開始時に解決"}`,
    ...(candidate.detail
      ? detailLines(candidate.detail, candidate.checkStatus === "failed")
      : []),
    "Revisor に登録された時点で掲載されます。内容が変わると Cc がこの投稿を編集で更新し、マージ・取り下げで対象外になると閉じます。このスレッドに書き込むとテストセッションが対応します。",
  ];
  return clip(lines.join("\n"), 2000);
}

async function resolveThread(
  guild: Guild,
  threadId: string,
): Promise<AnyThreadChannel | null> {
  const cached = guild.channels.cache.get(threadId);
  const channel = cached ?? await guild.channels.fetch(threadId).catch((error: unknown) => {
    // Unknown Channel は既に削除済みなので cleanup を続ける。一時的な REST 障害や
    // rate limit は投げ直し、reconcile が DB を close せず次周期に再試行できるようにする。
    if (isUnknownChannelError(error)) return null;
    throw error;
  });
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
 * 操作面のスレッドへ書き込む。 Forum thread は無操作で自動 archive され、 archive 中は
 * 投稿も編集も拒否されるので、 書き込む前に解除する。 閉じていたスレッドは書き終えたら
 * 閉じ直す (Discord は書き込みで勝手に open へ戻すため)。
 */
async function writeToSurfaceThread<T>(
  guild: Guild,
  threadId: string,
  reason: string,
  write: (thread: AnyThreadChannel) => Promise<T>,
): Promise<T> {
  const thread = await resolveThread(guild, threadId);
  if (!thread) throw new Error(`Test surface thread is unavailable: ${threadId}`);
  return writeKeepingArchiveState(thread, reason, () => write(thread));
}

/** Persisted controls_message_id identifies the one message whose controls change with run_state. */
export async function refreshTestForumControls(
  guild: Guild,
  surface: DiscordTestSurfaceRow,
): Promise<void> {
  if (!surface.controls_message_id) throw new Error(`Test surface controls message is missing: ${surface.id}`);
  await writeToSurfaceThread(guild, surface.thread_id, "Concordia test controls refreshed", async (thread) => {
    const message = await thread.messages.fetch(surface.controls_message_id!);
    await message.edit(renderTestForumControls(surface));
  });
}

async function clearTestForumControls(
  guild: Guild,
  surface: DiscordTestSurfaceRow,
): Promise<void> {
  if (!surface.controls_message_id) return;
  await writeToSurfaceThread(guild, surface.thread_id, "Concordia test controls removed", async (thread) => {
    const message = await thread.messages.fetch(surface.controls_message_id!);
    await message.edit({ content: "この候補の操作面は現在利用できません。", components: [] });
  });
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
          content: `${mentions} ${candidate.repoOrigin} #${candidate.prNumber} が Revisor に登録されました (${checkStatusLabel(candidate.checkStatus, candidate.detail)})。`,
          allowedMentions: { users: [...candidate.mentionUserIds] },
        }).catch(() => undefined);
      }
      return { threadId: thread.id };
    },
    async update(surface: DiscordTestSurfaceRow, candidate: TestForumCandidate) {
      const thread = await resolveThread(guild, surface.thread_id);
      if (!thread) return;
      // Forum thread は無操作で自動 archive される。 archive 中は編集も rename も
      // 拒否されるので、 掲載継続中の候補は先に解除してから書き換え、 閉じていたものは
      // 書き終えたら閉じ直す。
      await writeKeepingArchiveState(thread, "Concordia test candidate refreshed", async () => {
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
      });
    },
    async render(surface) {
      const message = await writeToSurfaceThread(
        guild,
        surface.thread_id,
        "Concordia test controls posted",
        (thread) => thread.send(renderTestForumControls(surface)),
      );
      return { controlsMessageId: message.id };
    },
    async clearControls(surface) {
      await clearTestForumControls(guild, surface);
    },
    async postStatusChange(surface: DiscordTestSurfaceRow, candidate: TestForumCandidate) {
      const thread = await resolveThread(guild, surface.thread_id);
      if (!thread) return;
      // 送信そのものが Discord 側で unarchive を起こすので、閉じていたなら閉じ直す。
      await writeKeepingArchiveState(thread, "Concordia test candidate status posted", () =>
        thread.send({
          content: statusChangeMessage(candidate),
          components: statusChangeComponents(candidate, surface.id),
          allowedMentions: NO_MENTIONS,
        }));
    },
    async postMerged(surface: DiscordTestSurfaceRow, terminal: TestForumTerminalPr) {
      // 削除済み thread は既に閉じたものとして扱い、QA/session と DB の cleanup を止めない。
      // 存在する thread の unarchive/send 失敗は throw のままにして次周期で再試行する。
      const thread = await resolveThread(guild, surface.thread_id);
      if (!thread) return;
      if (thread.archived) {
        await thread.setArchived(false, "Concordia merged test candidate notice");
      }
      await thread.send({ content: mergedMessage(terminal), allowedMentions: NO_MENTIONS });
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
