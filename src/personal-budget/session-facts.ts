/**
 * セッション行から、 消費の計上に要る事実 (所属会社と依頼者) を読む (純関数)。
 *
 * 依頼者は session metadata の `discord_requester_user_id`、 所属会社は `subsidiary_id`。
 * どちらかが無いセッションは個人へ帰属しない (CC-PBUDGET-INV-07)。
 *
 * @implements SPEC-PBUDGET-CONSUME
 * @implements spec/feature/personal-ai-budget.md §3
 */

import type { ConsumptionSession } from "./consumption-service.js";

export interface SessionFactsRow {
  id: string;
  /** JSON 文字列。 壊れていれば依頼者なしとして扱う。 */
  metadata: string | null;
  /** epoch 秒。 */
  started_at: number;
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function consumptionSessionOf(row: SessionFactsRow): ConsumptionSession {
  let meta: Record<string, unknown> = {};
  try {
    const parsed = row.metadata ? JSON.parse(row.metadata) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
  } catch {
    // 壊れた metadata は依頼者なしとして扱う (数えない)。
  }
  const requesterUserId = text(meta.discord_requester_user_id);
  return {
    id: row.id,
    subsidiaryId: text(meta.subsidiary_id),
    requesterPlatform: requesterUserId ? "discord" : null,
    requesterUserId,
    startedAtMs: row.started_at * 1000,
  };
}
