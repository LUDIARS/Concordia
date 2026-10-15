/**
 * 巡回チャットの組み立て (composition root から呼ぶ adapter 配線)。
 *
 * - 素材元 allowlist: Tendentia 公開ランキング (接続先は Excubitor topology の `TENDENTIA_URL`)、
 *   Corpus 継承サービスの活動ログ (契約未確認のため contract-unverified で選択不可)
 * - chat 投稿は既存 ChatRepo + chat.posted (配達は既存 egress)
 * - 反応は所有 repo (chat_message_reactions) の人数集計、 配達照合は discord_message_map の読取
 */

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ChatChannel, ChatMessageRow, ChatRepo } from "../db/chat-repo.js";
import { makeChatMessageReactionsRepo, makeDiscordMessageMapRepo } from "../db/discord-repo.js";
import { RuleConversationsRepo } from "../db/rule-conversations-repo.js";
import { RuleRunsRepo } from "../db/rule-runs-repo.js";
import { RuleServiceEventsRepo } from "../db/rule-service-events-repo.js";
import { RuleVersionsRepo } from "../db/rule-versions-repo.js";
import type { RuleRow, RulesRepo } from "../db/rules-repo.js";
import { PatrolLearningRepo } from "../db/patrol-learning-repo.js";
import { runLearningPass, type LearningPassReport } from "./patrol-learning-loop.js";
import { validateRuleDefinition } from "./rule-validation.js";
import { parseActionConfig } from "./patrol-config.js";
import { resolveChannelFor } from "./patrol-channel.js";
import { eventBus } from "../events.js";
import { runClaude } from "./claude-runner.js";
import { MaterialSourceRegistry } from "./material-registry.js";
import { TENDENTIA_SOURCE_ID, makeTendentiaSource } from "./material-tendentia.js";
import { PATROL_AUTHOR_LABEL, dayStartSec, type PatrolOwnersPort, type PatrolPorts } from "./patrol-ports.js";
import type { ExternalChannelPoster } from "./patrol-external-delivery.js";
import { renderPatrol } from "./render-patrol.js";

export const CORPUS_ACTIVITY_SOURCE_ID = "corpus-activity";

export interface PatrolRuntime {
  ports: Omit<PatrolPorts, "runtimeDisabled">;
  versions: RuleVersionsRepo;
  /** 学習の pass (engine が 1 分ごとに回す)。 */
  learning: { repo: PatrolLearningRepo; run: () => Promise<LearningPassReport> };
  /** 巡回の投稿先 (個別チャンネル) なら、 その会話を記録する chat channel。 */
  channelFor: (discordChannelId: string) => string | null;
  api: {
    runs: RuleRunsRepo;
    conversations: RuleConversationsRepo;
    events: RuleServiceEventsRepo;
    sources: MaterialSourceRegistry;
    learning: PatrolLearningRepo;
  };
}

export function buildMaterialRegistry(env: { tendentiaUrl: string | null }): MaterialSourceRegistry {
  return new MaterialSourceRegistry([
    {
      sourceId: TENDENTIA_SOURCE_ID,
      label: "Tendentia 公開トレンド",
      kind: "trend",
      serviceCode: "Td",
      scopes: ["*"],
      unavailable: env.tendentiaUrl ? null : "not-configured",
      source: env.tendentiaUrl ? makeTendentiaSource({ baseUrl: env.tendentiaUrl }) : null,
    },
    {
      // Corpus 本体に共通の活動 feed を確認できていない (spec/feature/patrol-chat.md §4)。
      // 所有サービスの活動 API / scope / 保持期間を確認するまで選択不可。 mock で対応済みと偽らない。
      sourceId: CORPUS_ACTIVITY_SOURCE_ID,
      label: "Corpus 継承サービスの活動ログ",
      kind: "activity",
      serviceCode: "Co",
      scopes: [],
      unavailable: "contract-unverified",
      source: null,
    },
  ]);
}

/** chat 行の metadata から個別チャンネル指定を読む。 */
export function externalChannelOf(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const id = (JSON.parse(metadata) as { patrol_discord_channel_id?: unknown }).patrol_discord_channel_id;
    return typeof id === "string" && /^\d{17,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

function usernameOf(msg: ChatMessageRow): string | null {
  try {
    const name = (JSON.parse(msg.metadata ?? "{}") as { webhook_username?: unknown }).webhook_username;
    if (typeof name === "string" && name.trim()) return name.trim();
  } catch {
    // metadata が読めなければ author_label を使う
  }
  return msg.author_label?.trim() || null;
}

/** chat 行の metadata から rule の持ち主 (子会社 ID) を読む。 本社は null。 */
export function ownerSubsidiaryOf(metadata: string | null): string | null {
  try {
    const id = (JSON.parse(metadata ?? "{}") as { patrol_subsidiary_id?: unknown }).patrol_subsidiary_id;
    return typeof id === "string" && id !== "" ? id : null;
  } catch {
    return null;
  }
}

export async function deliverExternal(
  poster: ExternalChannelPoster | null,
  messageMap: { put(discordMessageId: string, chatMessageId: number): void },
  msg: ChatMessageRow,
  channelId: string,
  log?: { warn: (msg: string) => void },
  /** rule の持ち主の guild (本社 rule は本社 guild)。 解決できなければ送らない。 */
  ownerGuild?: (subsidiaryId: string | null) => string | null,
): Promise<boolean> {
  if (!poster) {
    log?.warn(`patrol: external channel delivery is not wired (chat #${msg.id} → ${channelId})`);
    return false;
  }
  let allowedGuildIds: string[] | undefined;
  if (ownerGuild) {
    const guild = ownerGuild(ownerSubsidiaryOf(msg.metadata));
    if (!guild) {
      log?.warn(`patrol: owner guild unresolved (chat #${msg.id} → ${channelId}); not sent`);
      return false;
    }
    allowedGuildIds = [guild];
  }
  try {
    const { messageId } = await poster({
      channelId, content: msg.text, username: usernameOf(msg), ...(allowedGuildIds ? { allowedGuildIds } : {}),
    });
    messageMap.put(messageId, msg.id);
    return true;
  } catch (err) {
    log?.warn(`patrol: external channel delivery failed (chat #${msg.id} → ${channelId}): ${(err as Error).message}`);
    return false;
  }
}

export function buildPatrolRuntime(deps: {
  db: Database.Database;
  chat: ChatRepo;
  rules: RulesRepo;
  tendentiaUrl: string | null;
  /** 個別チャンネル指定の配送。 未注入なら個別指定の投稿は送らず delivery_unknown になる。 */
  externalPoster?: ExternalChannelPoster | null;
  log?: { warn: (msg: string) => void };
  /** rule の持ち主 (子会社) の既定値と稼働状態。 */
  owners?: PatrolOwnersPort;
  /** 持ち主の guild (null = 本社 guild)。 個別チャンネルの配送先を持ち主の guild に限る。 */
  ownerGuild?: (subsidiaryId: string | null) => string | null;
}): PatrolRuntime {
  const runs = new RuleRunsRepo(deps.db);
  const conversations = new RuleConversationsRepo(deps.db);
  const events = new RuleServiceEventsRepo(deps.db);
  const versions = new RuleVersionsRepo(deps.db);
  const sources = buildMaterialRegistry({ tendentiaUrl: deps.tendentiaUrl });
  const reactions = makeChatMessageReactionsRepo(deps.db);
  const messageMap = makeDiscordMessageMapRepo(deps.db);
  const learningRepo = new PatrolLearningRepo(deps.db);
  const ports: Omit<PatrolPorts, "runtimeDisabled"> = {
    ...(deps.owners ? { owners: deps.owners } : {}),
    // 直近 3 日に話した内容: 投稿した素材の題と、 会話の断片の話題キーワード。 何日前かはローカル日付で数える。
    topicMemory: (ruleId, nowSec) => {
      const since = dayStartSec(nowSec) - 2 * 86400;
      const ageDays = (ts: number) => Math.round((dayStartSec(nowSec) - dayStartSec(ts)) / 86400);
      return [
        ...runs.recentPostedTitles(ruleId, since).map((r) => ({ text: r.title, ageDays: ageDays(r.created_at) })),
        ...learningRepo.recentKeywords(ruleId, since).map((r) => ({ text: r.keyword, ageDays: ageDays(r.created_at) })),
      ];
    },
    rules: deps.rules,
    runs,
    conversations,
    events,
    sources,
    chat: {
      insert: (input) => deps.chat.insert({
        channel: input.channel as ChatChannel,
        session_id: null,
        author_label: input.author_label ?? PATROL_AUTHOR_LABEL,
        text: input.text,
        in_reply_to: input.in_reply_to,
        is_actionable: false,
        metadata: JSON.stringify({ ...input.metadata }),
      }),
      findById: (id) => deps.chat.findById(id),
      countHumanAfter: (channel, afterId, externalChannelId) => deps.chat.countHumanAfter(channel, afterId, externalChannelId),
    },
    reactions,
    delivery: { findExternalId: (chatMessageId) => messageMap.findDiscordId(chatMessageId) },
    render: (input) => renderPatrol(input, (prompt, opts) => runClaude(prompt, opts)),
    emitChatPosted: (msg) => {
      const externalChannelId = externalChannelOf(msg.metadata);
      if (externalChannelId) {
        // 個別チャンネル指定の投稿は本社の chat 配信 (Discord meta / Slack) に流さず、 直接送る。
        // 成功時だけ discord_message_map に記録し、 配達照合 (patrol-maintenance) が delivered にする。
        void deliverExternal(deps.externalPoster ?? null, messageMap, msg, externalChannelId, deps.log, deps.ownerGuild);
        return;
      }
      eventBus.emit({
        type: "chat.posted",
        message_id: msg.id,
        channel: msg.channel,
        author_label: msg.author_label,
        session_id: msg.session_id,
        ts: msg.ts,
        is_actionable: false,
        scope: "world",
      });
    },
    nowMs: () => Date.now(),
    random: () => Math.random(),
    newId: () => randomUUID(),
    leaseOwner: `cc:${process.pid}:${randomUUID().slice(0, 8)}`,
  };
  // 学習 (spec/plan/2026-10-15-patrol-learning-design.md)。 返信の周期とは別の流れで engine が回す。
  const inherit = (rule: RuleRow) => (rule.subsidiary_id ? deps.owners?.defaults(rule.subsidiary_id) ?? null : null);
  // 巡回の投稿先チャンネル → rule。 有効な巡回 rule の実効投稿先 (子会社の既定値を含む) から引く。
  const ruleForChannel = (discordChannelId: string): RuleRow | null => {
    for (const rule of deps.rules.list({ enabled: true, execution_mode: "patrol" })) {
      const parsed = parseActionConfig(rule.action_config, inherit(rule));
      if (parsed.ok && parsed.config.discord_channel_id === discordChannelId) return rule;
    }
    return null;
  };
  const learning = {
    repo: learningRepo,
    run: () => runLearningPass({
      repo: learningRepo,
      rules: deps.rules,
      versions,
      reactions,
      runner: (prompt, opts) => runClaude(prompt, opts),
      validate: (rule, actionConfigJson, tickSec) => validateRuleDefinition(
        { ...rule, action_config: actionConfigJson, tick_sec: tickSec, cooldown_sec: tickSec },
        sources,
        inherit(rule),
      ),
      inherit,
      ruleForChannel,
      nowMs: () => Date.now(),
      newId: () => randomUUID(),
      ...(deps.log ? { log: deps.log } : {}),
    }),
  };
  const channelFor = (discordChannelId: string): string | null => {
    const rule = ruleForChannel(discordChannelId);
    return rule ? resolveChannelFor(rule) : null;
  };
  return { ports, versions, learning, channelFor, api: { runs, conversations, events, sources, learning: learningRepo } };
}
