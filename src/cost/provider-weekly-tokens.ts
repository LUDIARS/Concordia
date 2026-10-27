/**
 * このホストのローカル Claude Code / Codex が直近 7 暦日 (今日含む) に消費したトークンを provider 別に出す。
 *
 * 拠点が本社へ送る週間使用量 (SPEC-FED-SITE-USAGE) の集計点。 窓の切り方は org-cost の「週間」と同じで、
 * 各 JSONL エントリのタイムスタンプで数える (セッション開始日で按分しない)。
 *
 * @implements spec/feature/federation-link.md SPEC-FED-SITE-USAGE
 */

import type { SessionsRepo } from "../db/sessions-repo.js";
import { localWeekStartSec } from "./org-cost.js";
import { readSessionWindowedTotals, type SessionWindowReader } from "./windowed-usage.js";

export interface ProviderWeeklyTokens {
  /** 集計窓 [startSec, endSec) (epoch 秒)。 */
  startSec: number;
  endSec: number;
  /** provider ("claude-code" / "codex-cli" 等) → 窓内の消費トークン。 */
  tokens: Map<string, number>;
}

export async function collectProviderWeeklyTokens(
  sessionsRepo: Pick<SessionsRepo, "listSessionsSeenSince">,
  nowMs: number = Date.now(),
  reader: SessionWindowReader = readSessionWindowedTotals,
): Promise<ProviderWeeklyTokens> {
  const startSec = localWeekStartSec(nowMs);
  // endSec は now を含めるため +1 (半開区間 [start, end))。
  const endSec = Math.floor(nowMs / 1000) + 1;
  const tokens = new Map<string, number>();
  for (const session of sessionsRepo.listSessionsSeenSince(startSec)) {
    const used = (await reader(session, [{ key: "w", startSec, endSec }])).w ?? 0;
    if (used > 0) tokens.set(session.provider, (tokens.get(session.provider) ?? 0) + used);
  }
  return { startSec, endSec, tokens };
}
