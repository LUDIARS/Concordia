/**
 * 個人の解決 (純関数)。 依頼者と所属会社から、 個人の予算の対象かどうかを決める。
 *
 * 本社メンバー (会社を持たない) と依頼者の無いセッションには個人の予算を適用しない
 * (制限もしない、 報奨も付けない、 CC-PBUDGET-INV-07)。
 *
 * @implements spec/feature/personal-ai-budget.md §2
 */

import type { BudgetPlatform, PersonIdentity } from "./types.js";

export type PersonSkipReason = "head_office" | "no_requester" | "invalid_identity";

export type PersonResolution =
  | { ok: true; identity: PersonIdentity }
  | { ok: false; reason: PersonSkipReason };

export interface PersonFacts {
  subsidiaryId: string | null | undefined;
  platform: BudgetPlatform | null | undefined;
  platformUserId: string | null | undefined;
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function resolveBudgetPerson(facts: PersonFacts): PersonResolution {
  const userId = (facts.platformUserId ?? "").trim();
  if (!userId || !facts.platform) return { ok: false, reason: "no_requester" };
  const subsidiaryId = (facts.subsidiaryId ?? "").trim();
  if (!subsidiaryId) return { ok: false, reason: "head_office" };
  if (!USER_ID.test(userId) || (facts.platform !== "discord" && facts.platform !== "slack")) {
    return { ok: false, reason: "invalid_identity" };
  }
  return { ok: true, identity: { subsidiaryId, platform: facts.platform, platformUserId: userId } };
}

export const PERSON_SKIP_LABEL: Record<PersonSkipReason, string> = {
  head_office: "本社メンバーは個人の AI 予算の対象外です",
  no_requester: "個人を特定できません",
  invalid_identity: "個人を特定できません",
};
