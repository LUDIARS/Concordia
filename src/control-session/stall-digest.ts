/**
 * 停止・応答なしに分類されたセッションを選び、管制セッションへ送る要約を作る純関数。
 * 同じ停止 (分類と最終活動の組) は 1 回だけ伝える。分類は session-classify.ts が決める
 * (旧基準の自動確認「変化なし」回数は使わない。指紋が無いセッションも対象になる)。
 *
 * @implements spec/feature/control-session.md §4
 */
import type { ControlBoardRow } from "./board-repo.js";

/** 1 通の要約に載せる上限。超えた分は次の巡回で伝える。 */
export const CONTROL_DIGEST_LIMIT = 10;
export const CONTROL_DIGEST_SENTINEL = "[管制巡回]";

/** 伝えた記録の鍵。分類か最終活動が変われば別の停止として伝え直す。 */
export function digestKey(row: Pick<ControlBoardRow, "status" | "last_activity_at">): string {
  return `${row.status ?? "unclassified"}:${row.last_activity_at ?? "none"}`;
}

export function selectStalledRows(rows: readonly ControlBoardRow[]): ControlBoardRow[] {
  return rows.filter((row) => (row.status === "stalled" || row.status === "unresponsive")
    && row.digested_fingerprint !== digestKey(row));
}

function line(row: ControlBoardRow): string {
  const parts = [
    `- ${row.session_id} (${row.project}${row.branch ? ` / ${row.branch}` : ""})`,
    `分類=${row.status === "unresponsive" ? "応答なし" : "停止"}`,
    row.status_reason ?? "理由不明",
    `追加指示 ${row.nudge_count ?? 0} 回`,
  ];
  if (row.current_task) parts.push(`タスク: ${row.current_task}`);
  if (row.side_summary) parts.push(`現況: ${row.side_summary}`);
  return parts.join(" / ");
}

export function renderStallDigest(rows: readonly ControlBoardRow[]): string {
  return [
    `${CONTROL_DIGEST_SENTINEL} 待つ理由 (人間の判断・審査・委託の結果) が無いまま動きの無いセッションがあります。巡回が既定の追加指示を送っています。`,
    ...rows.map(line),
    "既定の追加指示とは別の指示が要るものだけ POST /v1/control/instructions で送ってください。不要なら何もしないで構いません。",
    "詳しい状況は GET /v1/control/board で読めます。この要約に返信する必要はありません。",
  ].join("\n");
}
