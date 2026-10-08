/**
 * 本社が拠点から event-rejected を受けたときの扱い (spec/feature/cc-workload-security.md「配送結果の区別」)。
 *
 * - 送っていない seq の拒否は信じない (ack と同じく、未配送分を消させない)。
 * - 拒否された依頼は outbox から退避表へ移し、ack 扱いで黙って消さない。
 * - 通知には本文 (title/body/text) を出さず、依頼種別と宛先 thread だけを載せる。
 */

import type { FederationRejectedEventsRepo } from "../db/federation-rejected-events-repo.js";

export interface EventRejectionInput {
  siteId: string;
  seq: number;
  reason: string;
  /** この接続で送って ack/拒否をまだ受けていない seq。 */
  inFlight: readonly number[];
  rejectedEvents?: FederationRejectedEventsRepo;
  report(message: string, detail: Record<string, unknown>): void;
}

export type EventRejectionResult =
  | { status: "ignored" }
  | { status: "settled"; inFlight: number[]; retained: boolean };

export function settleRejectedEvent(input: EventRejectionInput): EventRejectionResult {
  if (!input.inFlight.includes(input.seq)) return { status: "ignored" };
  const moved = input.rejectedEvents?.moveFromOutbox(input.siteId, input.seq, input.reason) ?? null;
  input.report(
    `拠点 ${input.siteId} が本社からの依頼を実行しませんでした (${input.reason})。`
      + (moved ? "依頼は退避表に保存しています。照合してから再依頼してください" : "退避表が無いため依頼は outbox に残っています"),
    { site_id: input.siteId, seq: input.seq, reason: input.reason, ...(moved ? rejectedEventSummary(moved.payload) : {}) },
  );
  return { status: "settled", inFlight: input.inFlight.filter(seq => seq !== input.seq), retained: Boolean(moved) };
}

/** 通知用の要約。本文 (title/body/text) は含めない。 */
export function rejectedEventSummary(payload: string): { kind?: string; guild_id?: string; channel_id?: string } {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    const pick = (key: string) => (typeof value[key] === "string" ? (value[key] as string) : undefined);
    return { kind: pick("type"), guild_id: pick("guild_id"), channel_id: pick("channel_id") };
  } catch {
    return {};
  }
}
