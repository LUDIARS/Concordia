/**
 * 10 分毎の使用量サンプリング — 全 active セッションの「現在のコンテキスト占有」 と
 * 「累積消費トークン」 を subsidiary/provider タグ付きの行に変換する。
 *
 * provider JSONL を読む I/O は context-estimate / log-usage に集約済み。 ここは「集める」
 * 純ロジックに徹する (reader 差し替えでテストは I/O 無しで回る)。 永続化は
 * CostUsageSamplesRepo、 定期実行の配線は server.ts。
 */

import type { SessionRow } from "../shared/types.js";
import type { CostUsageSampleInput } from "../db/cost-usage-samples-repo.js";
import { estimateContextTokens } from "./context-estimate.js";
import { readSessionUsage } from "./log-usage.js";
import { readSubsidiaryId } from "../shared/subsidiary-id.js";

/** JSONL 読取の差し替え点 (テスト用)。 既定は実 reader。 */
export interface UsageSampleReader {
  context: (s: SessionRow) => number | null;
  cost: (s: SessionRow) => number;
}

const defaultReader: UsageSampleReader = {
  context: (s) => estimateContextTokens(s)?.tokens ?? null,
  cost: (s) => readSessionUsage(s)?.total ?? 0,
};

/**
 * active セッション群を 1 サンプル周期分の行に変換する。
 * context も cost も 0/null のセッション (まだ何も使っていない) は記録しない
 * (グラフに無意味な 0 点を撒かない)。
 */
export function collectUsageSamples(
  sessions: SessionRow[],
  nowSec: number,
  reader: UsageSampleReader = defaultReader,
): CostUsageSampleInput[] {
  const out: CostUsageSampleInput[] = [];
  for (const s of sessions) {
    const context = reader.context(s);
    const cost = reader.cost(s);
    if ((context === null || context <= 0) && cost <= 0) continue;
    out.push({
      ts: nowSec,
      session_id: s.id,
      subsidiary_id: readSubsidiaryId(s.metadata),
      provider: s.provider ?? null,
      context_tokens: context,
      cost_tokens: cost,
    });
  }
  return out;
}
