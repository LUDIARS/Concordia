/**
 * Concordia モニター用「チャンネル別 コンテキスト / コスト」集計。
 *
 * active なセッションを Discord セッションチャンネルに紐付け、 各セッションの
 *  - コンテキストの重さ (= 最新ターンの入力トークン。 ウィンドウがどれだけ重いか)
 *  - かかったコスト       (= 累積消費トークン input+output)
 * を JSONL ログから読んで「重い順」に並べる。 モニターから Lictor の近況 (current_task
 * 一覧) を外し、 代わりにこの 2 指標を出すためのデータ点 (kazumimitarai 要望)。
 *
 * provider JSONL を読む I/O は log-usage.ts に集約済み。 ここは「集める / 並べる / 描く」
 * の純粋ロジックに徹する (reader を差し替えればテストは I/O 無しで回る)。
 */

import type { SessionRow } from "../shared/types.js";
import { readSessionUsage } from "./log-usage.js";
import { estimateContextTokens } from "./context-estimate.js";

/** 1 セッション (= 1 チャンネル) のコンテキスト/コスト行。 */
export interface ChannelCostRow {
  sessionId: string;
  /** 紐付く Discord チャンネル id。 未マッピングなら null (session id 表示にフォールバック)。 */
  channelId: string | null;
  provider: string;
  /** 現在のコンテキスト占有トークン。 不明なら null。 */
  contextTokens: number | null;
  /** 累積消費トークン (input+output)。 */
  costTokens: number;
}

/** JSONL 読取の差し替え点 (テスト用)。 既定は log-usage.ts の実 reader。 完全非同期契約。 */
export interface ChannelCostReader {
  context: (s: SessionRow) => Promise<number | null>;
  cost: (s: SessionRow) => Promise<number>;
}

const defaultReader: ChannelCostReader = {
  context: async (s) => (await estimateContextTokens(s))?.tokens ?? null,
  cost: async (s) => (await readSessionUsage(s))?.total ?? 0,
};

/**
 * active セッション群を channel に紐付け、 context/cost を読んで「重い順」に並べる。
 * 並び順: コンテキスト降順 (null は末尾) → 同点はコスト降順。
 */
export async function collectChannelCostRows(
  sessions: SessionRow[],
  channelOf: (sessionId: string) => string | null,
  reader: ChannelCostReader = defaultReader,
): Promise<ChannelCostRow[]> {
  const rows: ChannelCostRow[] = [];
  for (const s of sessions) {
    rows.push({
      sessionId: s.id,
      channelId: channelOf(s.id),
      provider: s.provider,
      contextTokens: await reader.context(s),
      costTokens: await reader.cost(s),
    });
  }
  rows.sort(
    (a, b) => (b.contextTokens ?? -1) - (a.contextTokens ?? -1) || b.costTokens - a.costTokens,
  );
  return rows;
}

/** トークン数を k/M のコンパクト表記に (45.2k / 1.23M / 940)。 null は「—」。 */
export function fmtTokensCompact(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return "—";
  const v = Math.max(0, Math.floor(n));
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(1)}k`;
  return `${(v / 1_000_000).toFixed(2)}M`;
}

/**
 * モニター用 markdown 行に描く。 🧠 = コンテキストの重さ、 💰 = かかったコスト。
 * チャンネル未マッピングのセッションは session id 先頭 8 桁で表示。
 */
export function renderChannelCostLines(rows: ChannelCostRow[], limit = 15): string[] {
  const lines: string[] = ["### チャンネル別 コンテキスト / コスト", "🧠 コンテキスト占有 / 💰 累積コスト"];
  if (rows.length === 0) {
    lines.push("- (アクティブセッション無し)");
    return lines;
  }
  for (const r of rows.slice(0, limit)) {
    const label = r.channelId ? `<#${r.channelId}>` : `\`${r.sessionId.slice(0, 8)}\``;
    lines.push(`- ${label} 🧠 ${fmtTokensCompact(r.contextTokens)} 💰 ${fmtTokensCompact(r.costTokens)}`);
  }
  if (rows.length > limit) lines.push(`- …他 ${rows.length - limit} 件`);
  return lines;
}
