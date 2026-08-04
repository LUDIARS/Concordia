/**
 * Test Forum 投稿の Discord 側 (作成 / 編集リフレッシュ / クローズ)。
 * @implements spec/feature/revisor-test-forum-sync.md — Source and lifecycle
 */
import { ChannelType, type AnyThreadChannel, type Guild } from "discord.js";
import type { DiscordTestSurfaceRow } from "../db/discord-test-surfaces-repo.js";
import type { RevisorLocalPrDetail } from "../pr/revisor-test-workflow-client.js";
import type {
  TestForumCandidate,
  TestForumSurfaceAdapter,
  TestSurfaceCloseReason,
} from "./test-forum-reconcile.js";

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

export function starterContent(candidate: TestForumCandidate): string {
  const lines = [
    `**Test candidate** ${candidate.url ? `[#${candidate.prNumber}](${candidate.url})` : `#${candidate.prNumber}`}`,
    `**Repo** \`${candidate.repoOrigin}\``,
    `**Head** \`${candidate.headBranch ?? "-"}\` @ \`${candidate.headSha}\``,
    ...(candidate.detail ? detailLines(candidate.detail) : []),
    "Revisor で Open / Test OK になったため掲載されました。内容が変わると Cc がこの投稿を編集で更新し、マージ・取り下げ・再審査で対象外になると閉じます。",
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

export function createTestForumDiscordAdapter(
  guild: Guild,
  forumId: string,
): TestForumSurfaceAdapter {
  return {
    async create(candidate) {
      const forum = guild.channels.cache.get(forumId);
      if (!forum || forum.type !== ChannelType.GuildForum) {
        throw new Error(`Test forum is unavailable: ${forumId || "(empty id)"}`);
      }
      const thread = await forum.threads.create({
        name: threadName(candidate),
        message: { content: starterContent(candidate), allowedMentions: NO_MENTIONS },
        reason: `Concordia test candidate ${candidate.repoOrigin}#${candidate.prNumber}@${candidate.headSha}`,
      });
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
