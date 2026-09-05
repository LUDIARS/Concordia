/**
 * 完了報告の `acceptance_report` (自己申告) と Augur の集計を突合する — 純関数。
 *
 * 契約 id (`C-n`) は criterion の先頭トークン。 自己申告と集計で条件文の言い回しが
 * 揺れても id で対応が取れるようにしてある (受託 AI は集計 JSON をそのまま載せるのが
 * 正しい運用だが、 手で書き写す経路が残るため id 一致を主にする)。
 *
 * 「集計に無い」は covered ではないので未充足として扱う。 met=true と自己申告した項目
 * の不一致に加え、集計側にある契約を自己申告から省いた場合も未充足にする。met=false の
 * 自己申告は既存の未達受け入れ条件 → partial 経路 (src/api/delegation.ts) が拾う。
 *
 * @implements spec/feature/task-workflow.md §5 — 受け入れ条件の契約書式と完了証跡
 */

import type { AugurAcceptanceItem } from "./augur-acceptance.js";

/** 完了報告に載る 1 項目 (自己申告)。 */
export interface ReportedAcceptanceItem {
  criterion: string;
  met: boolean;
  note?: string | null;
}

/** criterion の先頭トークン = 契約 id (`C-4-1 foo(): …` → `C-4-1`)。 */
export function contractId(criterion: string): string {
  const token = criterion.trim().split(/\s+/, 1)[0] ?? "";
  return /^C-?\d+(?:-\d+)*$/.test(token) ? token : "";
}

/**
 * 自己申告 true / 集計 false (または集計に無い) の項目を返す。 返す値は criterion の
 * 原文 (人が読んで直せるように、 id へ潰さない)。
 */
export function reconcileAcceptance(
  reported: readonly ReportedAcceptanceItem[],
  aggregated: readonly AugurAcceptanceItem[],
): string[] {
  const byId = new Map<string, boolean>();
  const byText = new Map<string, boolean>();
  for (const item of aggregated) {
    const id = contractId(item.criterion);
    // 同じ id が複数回出たら「1 つでも未充足なら未充足」に倒す。
    if (id) byId.set(id, (byId.get(id) ?? true) && item.met);
    const text = item.criterion.trim();
    if (text) byText.set(text, (byText.get(text) ?? true) && item.met);
  }
  const unmetReported = reported
    .filter((item) => item.met)
    .filter((item) => {
      const id = contractId(item.criterion);
      const matched = byId.get(id) ?? byText.get(item.criterion.trim());
      return matched !== true;
    })
    .map((item) => item.criterion.trim());

  // A contract-backed run must not be able to omit acceptance_report and pass.
  // Every aggregated contract needs a corresponding report entry, including
  // reported met=false entries (the API converts those to partial separately).
  const reportedIds = new Set(reported.map((item) => contractId(item.criterion)).filter(Boolean));
  const reportedTexts = new Set(reported.map((item) => item.criterion.trim()).filter(Boolean));
  const missingReports = aggregated
    .filter((item) => {
      const id = contractId(item.criterion);
      return id ? !reportedIds.has(id) : !reportedTexts.has(item.criterion.trim());
    })
    .map((item) => item.criterion.trim());
  return [...new Set([...unmetReported, ...missingReports])];
}

/** 突合結果を completed 判定の理由文に整形する。 */
export function formatUnmetAcceptance(unmet: readonly string[]): string {
  const MAX_REASON_LENGTH = 4_000;
  const reason = unmet.map((criterion) => `unmet acceptance: ${criterion}`).join("; ");
  return reason.length <= MAX_REASON_LENGTH
    ? reason
    : `${reason.slice(0, MAX_REASON_LENGTH - 14)}… (truncated)`;
}
