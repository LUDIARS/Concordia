/**
 * 自動引き継ぎの試行記録 (session metadata `auto_handover`) の読み書き (純関数)。
 *
 * 試行前に記録し、 結果が不明・失敗でも同じセッションでは再送しない根拠にする。
 *
 * @implements spec/feature/session-auto-succession.md §2.1 (INV-1)
 */

import type { HandoverMeasure } from "./context-handover-policy.js";

export const AUTO_HANDOVER_METADATA_KEY = "auto_handover";

export interface AutoHandoverRecord {
  /** epoch 秒。 */
  attempted_at: number;
  measure: HandoverMeasure | null;
}

function isMeasure(value: unknown): value is HandoverMeasure {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.tokens === "number" && typeof record.pct === "number";
}

/** metadata オブジェクトから試行記録を読む。 欠落・壊れた値は「未試行」。 */
export function readAutoHandoverRecord(metadata: Record<string, unknown>): AutoHandoverRecord | null {
  const value = metadata[AUTO_HANDOVER_METADATA_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.attempted_at !== "number") return null;
  return { attempted_at: record.attempted_at, measure: isMeasure(record.measure) ? record.measure : null };
}

/** mergeMetadata へ渡す patch。 */
export function autoHandoverRecordPatch(record: AutoHandoverRecord): Record<string, unknown> {
  return { [AUTO_HANDOVER_METADATA_KEY]: record };
}
