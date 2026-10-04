/**
 * セッションの行から、 報告の受付が見る形 (有効か・所属会社・依頼者) を読む adapter
 * (spec/feature/bug-bounty.md §3 §4)。
 *
 * 「あらゆるセッションから有効」: 本社・子会社・委託の子・相談を問わず、 終了・消失していない
 * セッションは報告できる。 所属会社と依頼者は session metadata (起動時に Cc が焼いた値) から読み、
 * 壊れた metadata は本社所属・依頼者なしとして扱う。
 *
 * @implements SPEC-BOUNTY-INTAKE
 * @implements SPEC-BOUNTY-REPORTER
 */

import { readSubsidiaryId } from "../shared/subsidiary-id.js";
import type { BountySessionView } from "./intake-service.js";

/** 報告を受けない状態。 blocked (人の判断待ち) は動いているセッションなので受ける。 */
const INACTIVE_STATUSES: ReadonlySet<string> = new Set(["ended", "lost", "abandoned"]);

export function bountySessionView(session: {
  id: string;
  status: string;
  ended_at: number | null;
  metadata: string | null;
}): BountySessionView {
  return {
    id: session.id,
    active: session.ended_at === null && !INACTIVE_STATUSES.has(session.status),
    companyId: readSubsidiaryId(session.metadata),
    requesterDiscordUserId: readRequesterDiscordUserId(session.metadata),
  };
}

function readRequesterDiscordUserId(metadata: string | null): string | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const value = (parsed as { discord_requester_user_id?: unknown }).discord_requester_user_id;
    return typeof value === "string" && value.trim() ? value.trim() : null;
  } catch {
    // 壊れた metadata は依頼者なし (受取人なし) として扱う。
    return null;
  }
}
