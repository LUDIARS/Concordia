/**
 * Sidecar の返却 (完了・失敗報告) の点検と、親へ渡す要約の組み立て。
 *
 * 親は差分と証拠を見て採否を決める。 同じ実装を丸ごと再実行しないため、返却には
 * 変更要約・成果参照・実施/未実施の検証・残件・消費・失敗理由を揃えさせる。
 * 許可が足りずに止まった失敗は、能力不足と区別して親へ示す。
 *
 * @implements spec/feature/astra-with-sidecar.md §モデル選択と委任契約
 */

import { SIDECAR_RETURN_FIELDS } from "./packet.js";

export interface SidecarReturn {
  summary?: string;
  commits?: string[];
  verification_done?: string[];
  verification_skipped?: string[];
  remaining?: string[];
  consumption?: string;
  failure_reason?: string;
  /** 失敗の分類。 permission = 許可が認識できず止まった (能力不足ではない)。 */
  failure_kind?: "permission" | "scope" | "unresolved" | "quality" | "budget" | "other";
}

export type SidecarReturnReview = {
  missing: string[];
  failureKind: SidecarReturn["failure_kind"] | null;
  /** 親の通知へ足す行。 */
  lines: string[];
};

/**
 * 報告の状態に応じて必要な返却項目を点検する。
 * failure_reason は失敗時だけ必須、それ以外の項目は常に必須 (空配列は「無し」を明示した扱い)。
 */
export function reviewSidecarReturn(status: "completed" | "partial" | "failed", value: SidecarReturn | null | undefined): SidecarReturnReview {
  const payload = value ?? {};
  const missing = SIDECAR_RETURN_FIELDS.filter((field) => {
    if (field === "failure_reason") return status === "failed" && !payload.failure_reason?.trim();
    const item = payload[field];
    if (item === undefined || item === null) return true;
    return typeof item === "string" && !item.trim();
  });
  const failureKind = payload.failure_kind ?? null;
  const lines: string[] = [];
  if (payload.summary?.trim()) lines.push(`sidecar summary: ${payload.summary.trim()}`);
  if (payload.commits?.length) lines.push(`sidecar commits: ${payload.commits.join(", ")}`);
  if (payload.verification_done?.length) lines.push(`verified: ${payload.verification_done.join(", ")}`);
  if (payload.verification_skipped?.length) lines.push(`not verified: ${payload.verification_skipped.join(", ")}`);
  if (payload.remaining?.length) lines.push(`sidecar remaining: ${payload.remaining.join(", ")}`);
  if (payload.consumption?.trim()) lines.push(`consumption: ${payload.consumption.trim()}`);
  if (payload.failure_reason?.trim()) lines.push(`failure: ${payload.failure_reason.trim()}`);
  if (failureKind === "permission") {
    lines.push("failure kind: permission — the sidecar stopped because it could not confirm authorization; this is not a capability failure");
  } else if (failureKind) {
    lines.push(`failure kind: ${failureKind}`);
  }
  if (missing.length) {
    lines.push(`sidecar return incomplete: missing ${missing.join(", ")} — review the diff before adopting it`);
  }
  return { missing, failureKind, lines };
}
