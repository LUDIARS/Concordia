import { estimateContextTokens, type ContextEstimate } from "../cost/context-estimate.js";
import type { SessionRow } from "../shared/types.js";

const DEFAULT_WARNING_THRESHOLD = 0.75;

function readMetadata(raw: string | null): { last_compaction_at?: number } {
  if (!raw) return {};
  try { return JSON.parse(raw) as { last_compaction_at?: number }; } catch { return {}; }
}

export async function buildContextReport(session: SessionRow): Promise<string> {
  const estimate = await estimateContextTokens(session);
  if (!estimate) return "🧠 コンテキスト使用量を推定できませんでした (provider ログが未接続です)。";
  const threshold = readThreshold();
  const metadata = readMetadata(session.metadata);
  return formatContextReport(estimate, threshold, metadata.last_compaction_at ?? null);
}

export function formatContextReport(estimate: ContextEstimate, threshold: number, lastCompactionAt: number | null): string {
  const remaining = Math.max(0, estimate.windowTokens - estimate.tokens);
  const remainingPct = Math.max(0, 1 - estimate.pct);
  const thresholdTokens = Math.round(estimate.windowTokens * threshold);
  const margin = Math.max(0, thresholdTokens - estimate.tokens);
  const last = lastCompactionAt ? new Date(lastCompactionAt).toISOString() : "未実行";
  return [
    "🧠 **コンテキスト残量**",
    `占有: ${estimate.tokens.toLocaleString()} / ${estimate.windowTokens.toLocaleString()} tokens (${Math.round(estimate.pct * 100)}%)`,
    `残量: ${remaining.toLocaleString()} tokens (${Math.round(remainingPct * 100)}%)`,
    `表示基準まで: ${margin.toLocaleString()} tokens (${Math.round(threshold * 100)}% threshold)`,
    `前回コンパクション: ${last}`,
  ].join("\n");
}

function readThreshold(): number {
  const raw = Number(process.env.CONCORDIA_COMPACTION_AUTO_PCT ?? "75");
  if (!Number.isFinite(raw)) return DEFAULT_WARNING_THRESHOLD;
  const ratio = raw > 1 ? raw / 100 : raw;
  return Math.max(0, Math.min(1, ratio));
}
