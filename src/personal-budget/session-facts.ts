/**
 * セッション行から、 消費の計上に要る事実 (所属会社と依頼者) を読む (純関数)。
 *
 * 依頼者は session metadata の `discord_requester_user_id`、 所属会社は `subsidiary_id`。
 * 自分の依頼者が無い委託の子は、 親から引き継いだ組 (`personal_budget_requester`) を読む。
 * 引き継いだ組は帰属専用で、 メンションや返信の権限には使わない (メンションは
 * `discord_requester_user_id` だけを見る)。 どちらも無いセッションは個人へ帰属しない (CC-PBUDGET-INV-07)。
 *
 * @implements SPEC-PBUDGET-CONSUME
 * @implements spec/feature/personal-ai-budget.md §3
 */

import type { ConsumptionSession } from "./consumption-service.js";

/** 委託の子へ引き継いだ依頼者を置く session metadata のキー。 帰属専用。 */
export const INHERITED_REQUESTER_METADATA_KEY = "personal_budget_requester";

/** 消費を帰属させる依頼者 (会社と Discord のユーザー id の組)。 */
export interface BudgetRequester {
  subsidiaryId: string;
  discordUserId: string;
}

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

function parseMetadata(metadata: string | null): Record<string, unknown> {
  try {
    const parsed = metadata ? JSON.parse(metadata) as unknown : null;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // 壊れた metadata は依頼者なしとして扱う (数えない)。
  }
  return {};
}

function inheritedRequesterOf(meta: Record<string, unknown>): BudgetRequester | null {
  const value = meta[INHERITED_REQUESTER_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const subsidiaryId = text(record.subsidiary_id);
  const discordUserId = text(record.discord_user_id);
  return subsidiaryId && discordUserId ? { subsidiaryId, discordUserId } : null;
}

/**
 * セッションの消費を帰属させる依頼者。 自分の依頼者と会社の組を先に見て、 無ければ親から引き継いだ組を見る。
 * 組が揃わなければ null (本社・依頼者なし)。
 */
export function budgetRequesterOf(metadata: string | null): BudgetRequester | null {
  const meta = parseMetadata(metadata);
  const subsidiaryId = text(meta.subsidiary_id);
  const discordUserId = text(meta.discord_requester_user_id);
  if (subsidiaryId && discordUserId) return { subsidiaryId, discordUserId };
  return inheritedRequesterOf(meta);
}

export function consumptionSessionOf(row: SessionFactsRow): ConsumptionSession {
  const meta = parseMetadata(row.metadata);
  const ownRequester = text(meta.discord_requester_user_id);
  const inherited = ownRequester ? null : inheritedRequesterOf(meta);
  const requesterUserId = ownRequester ?? inherited?.discordUserId ?? null;
  return {
    id: row.id,
    subsidiaryId: inherited ? inherited.subsidiaryId : text(meta.subsidiary_id),
    requesterPlatform: requesterUserId ? "discord" : null,
    requesterUserId,
    startedAtMs: row.started_at * 1000,
  };
}
