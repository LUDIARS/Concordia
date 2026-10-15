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
import type { ChatChannel, ChatRepo } from "../db/chat-repo.js";
import { makeChatMessageReactionsRepo, makeDiscordMessageMapRepo } from "../db/discord-repo.js";
import { RuleConversationsRepo } from "../db/rule-conversations-repo.js";
import { RuleRunsRepo } from "../db/rule-runs-repo.js";
import { RuleServiceEventsRepo } from "../db/rule-service-events-repo.js";
import { RuleVersionsRepo } from "../db/rule-versions-repo.js";
import type { RulesRepo } from "../db/rules-repo.js";
import { eventBus } from "../events.js";
import { runClaude } from "./claude-runner.js";
import { MaterialSourceRegistry } from "./material-registry.js";
import { TENDENTIA_SOURCE_ID, makeTendentiaSource } from "./material-tendentia.js";
import { PATROL_AUTHOR_LABEL, type PatrolPorts } from "./patrol-ports.js";
import { renderPatrol } from "./render-patrol.js";

export const CORPUS_ACTIVITY_SOURCE_ID = "corpus-activity";

export interface PatrolRuntime {
  ports: Omit<PatrolPorts, "runtimeDisabled">;
  versions: RuleVersionsRepo;
  api: {
    runs: RuleRunsRepo;
    conversations: RuleConversationsRepo;
    events: RuleServiceEventsRepo;
    sources: MaterialSourceRegistry;
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

export function buildPatrolRuntime(deps: {
  db: Database.Database;
  chat: ChatRepo;
  rules: RulesRepo;
  tendentiaUrl: string | null;
}): PatrolRuntime {
  const runs = new RuleRunsRepo(deps.db);
  const conversations = new RuleConversationsRepo(deps.db);
  const events = new RuleServiceEventsRepo(deps.db);
  const versions = new RuleVersionsRepo(deps.db);
  const sources = buildMaterialRegistry({ tendentiaUrl: deps.tendentiaUrl });
  const reactions = makeChatMessageReactionsRepo(deps.db);
  const messageMap = makeDiscordMessageMapRepo(deps.db);
  const ports: Omit<PatrolPorts, "runtimeDisabled"> = {
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
      countHumanAfter: (channel, afterId) => deps.chat.countHumanAfter(channel, afterId),
    },
    reactions,
    delivery: { findExternalId: (chatMessageId) => messageMap.findDiscordId(chatMessageId) },
    render: (input) => renderPatrol(input, (prompt, opts) => runClaude(prompt, opts)),
    emitChatPosted: (msg) => eventBus.emit({
      type: "chat.posted",
      message_id: msg.id,
      channel: msg.channel,
      author_label: msg.author_label,
      session_id: msg.session_id,
      ts: msg.ts,
      is_actionable: false,
      scope: "world",
    }),
    nowMs: () => Date.now(),
    random: () => Math.random(),
    newId: () => randomUUID(),
    leaseOwner: `cc:${process.pid}:${randomUUID().slice(0, 8)}`,
  };
  return { ports, versions, api: { runs, conversations, events, sources } };
}
