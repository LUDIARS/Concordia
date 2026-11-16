/**
 * 停止したセッションを選び、管制セッションへ送る要約を作る純関数。
 * 同じ作業状態の指紋は 1 回だけ伝える。
 *
 * @implements spec/feature/control-session.md — 4. 停止したセッションへの追加指示 / CC-CTL-INV-04
 */
import { ACTIVITY_STALL_UNCHANGED_MIN, isActivityStalled } from "../control/session-activity.js";
import type { ControlBoardRow } from "./board-repo.js";

/** 自動確認で観測された動きが無い回がこの数以上続いたら停止とみなす (自動確認と共通の基準)。 */
export const CONTROL_STALL_UNCHANGED_MIN = ACTIVITY_STALL_UNCHANGED_MIN;
/** 1 通の要約に載せる上限。超えた分は次の巡回で伝える。 */
export const CONTROL_DIGEST_LIMIT = 10;
export const CONTROL_DIGEST_SENTINEL = "[管制巡回]";

export function selectStalledRows(rows: readonly ControlBoardRow[], min = CONTROL_STALL_UNCHANGED_MIN): ControlBoardRow[] {
  return rows.filter((row) => row.fingerprint !== null
    && isActivityStalled(row.unchanged_count, min)
    && row.digested_fingerprint !== row.fingerprint);
}

function line(row: ControlBoardRow): string {
  const parts = [
    `- ${row.session_id} (${row.project}${row.branch ? ` / ${row.branch}` : ""})`,
    `状態=${row.followup_state ?? "不明"}`,
    `変化なし=${row.unchanged_count} 回`,
  ];
  if (row.current_task) parts.push(`タスク: ${row.current_task}`);
  if (row.side_summary) parts.push(`現況: ${row.side_summary}`);
  return parts.join(" / ");
}

export function renderStallDigest(rows: readonly ControlBoardRow[]): string {
  return [
    `${CONTROL_DIGEST_SENTINEL} 自動確認でも動き (会話・コミット・作業ツリー・PR・委託・現況報告) が無いセッションがあります (送ってよい条件を満たすものだけ)。`,
    ...rows.map(line),
    "追加指示が要るものだけ POST /v1/control/instructions で送ってください。不要なら何もしないで構いません。",
    "詳しい状況は GET /v1/control/board で読めます。この要約に返信する必要はありません。",
  ].join("\n");
}
