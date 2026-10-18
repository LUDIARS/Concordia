/**
 * 巡回チャットの application use case が使う port (spec/feature/patrol-chat.md §8)。
 * 業務判断 (patrol-policy) は純関数、 手順 (execute / cycle / inbound / delivery) はここの port だけに依存する。
 */

import type { ChatMessageRow } from "../db/chat-repo.js";
import type { RuleConversationsRepo } from "../db/rule-conversations-repo.js";
import type { RuleRunsRepo } from "../db/rule-runs-repo.js";
import type { RuleServiceEventsRepo } from "../db/rule-service-events-repo.js";
import type { RuleRow, RulesRepo } from "../db/rules-repo.js";
import type { MaterialSourceRegistry } from "./material-registry.js";
import type { SubsidiaryPatrolDefaults } from "./patrol-config.js";
import type { RecentTopic } from "./patrol-topics.js";
import type { RenderInput, RenderResult } from "./render-patrol.js";
import type { KnowledgeQuery } from "./knowledge-select.js";
import type { KnowledgeChunk } from "./knowledge-types.js";

/** 巡回の bot 発言に付ける metadata.source。 自分の出力を素材・返信として再投入しない目印 (CC-PATROL-04)。 */
export const PATROL_MESSAGE_SOURCE = "patrol";
export const PATROL_AUTHOR_LABEL = "巡回チャット";

/** 1 run の所有期限。 生成上限 30 秒より十分長く取る。 */
export const PATROL_LEASE_SEC = 120;
/** 投稿後この秒数を過ぎても配達の記録が見つからなければ delivery_unknown にする。 */
export const DELIVERY_UNKNOWN_AFTER_SEC = 600;

export interface PatrolChatPort {
  insert(input: {
    channel: string;
    text: string;
    in_reply_to: number | null;
    /** 投稿者名。 省略時は PATROL_AUTHOR_LABEL。 */
    author_label?: string;
    metadata: Record<string, unknown>;
  }): ChatMessageRow;
  findById(id: number): ChatMessageRow | null;
  /**
   * 同じ宛先で afterId より後の人間の発言数 (bot / system / 巡回自身を除く)。
   * externalChannelId を指定すればその個別チャンネルの発言だけ、 null なら本社の発言だけ。
   */
  countHumanAfter(channel: string, afterId: number, externalChannelId: string | null): number;
}

export interface PatrolReactionsPort {
  reactorsByMessage(messageId: number): { distinct: number; fine: number; bad: number };
}

export interface PatrolDeliveryPort {
  /** 外部 (Discord) に届いた message の ID。 未記録なら null。 */
  findExternalId(chatMessageId: number): string | null;
}

/** rule の持ち主 (子会社) の既定値と稼働状態。 spec/plan/2026-10-15-patrol-subsidiary-rules-design.md §2。 */
export interface PatrolOwnersPort {
  defaults(subsidiaryId: string): SubsidiaryPatrolDefaults | null;
  /** 子会社が存在して有効か。 */
  active(subsidiaryId: string): boolean;
}

/** 持ち主の既定値 (本社の rule・未配線なら null)。 */
export function ownerDefaultsOf(ports: Pick<PatrolPorts, "owners">, rule: Pick<RuleRow, "subsidiary_id">): SubsidiaryPatrolDefaults | null {
  return rule.subsidiary_id ? ports.owners?.defaults(rule.subsidiary_id) ?? null : null;
}

/** 持ち主の子会社が止まっていれば理由を返す。 */
export function ownerStopReason(
  ports: Pick<PatrolPorts, "owners">,
  rule: Pick<RuleRow, "subsidiary_id">,
  defaults: SubsidiaryPatrolDefaults | null,
): string | null {
  if (!rule.subsidiary_id) return null;
  if (ports.owners && !ports.owners.active(rule.subsidiary_id)) return "owner subsidiary disabled";
  if (defaults?.paused) return "owner subsidiary paused";
  return null;
}

export interface PatrolPorts {
  /** 子会社の既定値・稼働状態。 未配線なら子会社の rule も全体の既定値で動く。 */
  owners?: PatrolOwnersPort;
  /** 直近 3 日に話した内容 (投稿した素材の題・会話の話題キーワード)。 未配線なら減点しない。 */
  topicMemory?: (ruleId: string, nowSec: number) => RecentTopic[];
  /** 知識の断片の選択 (spec/feature/patrol-chat.md「知識」)。 未配線なら知識なしで話す。 */
  knowledge?: { select(query: KnowledgeQuery): KnowledgeChunk[] };
  rules: Pick<RulesRepo, "find" | "setNextDue" | "markAttempt" | "log">;
  runs: RuleRunsRepo;
  conversations: RuleConversationsRepo;
  events: RuleServiceEventsRepo;
  sources: MaterialSourceRegistry;
  chat: PatrolChatPort;
  reactions: PatrolReactionsPort | null;
  delivery: PatrolDeliveryPort | null;
  render: (input: RenderInput) => Promise<RenderResult>;
  /** chat.posted を起床通知として流す (配達は既存 egress)。 */
  emitChatPosted: (msg: ChatMessageRow) => void;
  runtimeDisabled: () => boolean;
  nowMs: () => number;
  random: () => number;
  newId: () => string;
  leaseOwner: string;
}

export function nowSecOf(ports: Pick<PatrolPorts, "nowMs">): number {
  return Math.floor(ports.nowMs() / 1000);
}

/** ローカル日付の 0 時 (日次上限の起点)。 */
export function dayStartSec(nowSec: number): number {
  const d = new Date(nowSec * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}
