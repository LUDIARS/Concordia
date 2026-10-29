/**
 * お知らせへのサービスの応答の解釈 (spec/feature/discord-chat-relay.md §お知らせチャンネル、 DCR-INV-15)。
 *
 * `{"replies":[{"text"}],"linePush":[{"text"}]}`。 replies は人の発言への応答と同じ形 (replies.ts)、
 * linePush は省略可で 0〜3 件、 各 text は 1〜1000 字。
 *
 * @implements spec/feature/discord-chat-relay.md — お知らせチャンネル
 */

import { parseDiscordRelayReplies, type DiscordRelayReply } from "./replies.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:7f488420 */
import augurContract_a4206bc0 from './notice-answer.contract.js'; /* augur-inject:contract-predicate:ac9b042e */

export interface DiscordNoticeLinePush {
  text: string;
}

export interface DiscordNoticeAnswer {
  replies: DiscordRelayReply[];
  linePush: DiscordNoticeLinePush[];
}

export const MAX_NOTICE_LINE_PUSH = 3;
export const MAX_NOTICE_LINE_PUSH_LENGTH = 1000;

/** 形が違えば null (呼び出し側は投稿も push もしない)。 */
export function parseDiscordNoticeAnswer(body: Uint8Array): DiscordNoticeAnswer | null {
  const replies = parseDiscordRelayReplies(body);
  if (replies === null) return null;
  // replies を読めたので本文は JSON オブジェクト。
  const value = JSON.parse(Buffer.from(body).toString("utf8")) as Record<string, unknown>;
  const linePush = parseLinePush(value.linePush);
  return linePush === null ? null : { replies, linePush };
}
// @ts-expect-error augur-inject
parseDiscordNoticeAnswer = contract(parseDiscordNoticeAnswer, { ...augurContract_a4206bc0, contractId: 'dcr-C-8', mode: 'observe', sample: 1, where: 'src/discord-chat-relay/notice-answer.ts:25', rule: 'contract-wrap', id: 'a4206bc0' }); /* augur-inject:contract-wrap:a4206bc0 */

function parseLinePush(value: unknown): DiscordNoticeLinePush[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_NOTICE_LINE_PUSH) return null;
  const pushes: DiscordNoticeLinePush[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const { text } = item as { text?: unknown };
    if (typeof text !== "string" || text.length < 1 || text.length > MAX_NOTICE_LINE_PUSH_LENGTH) return null;
    pushes.push({ text });
  }
  return pushes;
}
