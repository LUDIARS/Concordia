/**
 * 管制チャンネルへ 1 時間に 1 回投げる進捗ボードのまとめ (純関数)。
 * 投稿の要否と本文だけを決め、投稿と最終投稿時刻の保存は runtime が行う。
 *
 * @implements spec/feature/control-session.md — 7. 1 時間ごとのまとめ / CC-CTL-INV-07
 */
import type { ControlBoardRow } from "./board-repo.js";
import { CONTROL_STALL_UNCHANGED_MIN } from "./stall-digest.js";

export const CONTROL_SUMMARY_INTERVAL_MS = 60 * 60 * 1000;
/**
 * 人が編集する設定ではなく実行時の内部状態なので、設定レジストリの名前空間 (admin. / harness.) の外に置く
 * (src/config/settings/coverage.test.ts はその名前空間のキーを設定として数える)。
 */
export const CONTROL_SUMMARY_POSTED_KEY = "control_session.summary_posted_at";
/** 停止セッションを個別に載せる上限。 */
export const CONTROL_SUMMARY_STALL_LIMIT = 10;
const TASK_HEAD_CHARS = 60;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** 保存値を読む。数でなければ null (= 未投稿)。 */
export function parseSummaryPostedAt(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** 未投稿・時計が戻った・間隔が経過したときに投稿する。 */
export function isSummaryDue(lastPostedMs: number | null, nowMs: number, intervalMs = CONTROL_SUMMARY_INTERVAL_MS): boolean {
  if (lastPostedMs === null) return true;
  if (nowMs < lastPostedMs) return true;
  return nowMs - lastPostedMs >= intervalMs;
}

function formatJst(nowMs: number): string {
  const d = new Date(nowMs + JST_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} JST`;
}

/** Discord のメンションにならないよう @ を全角にする (CC-CTL-INV-07)。 */
function noMention(text: string): string {
  return text.replace(/@/g, "＠");
}

function countBy(rows: readonly ControlBoardRow[], key: (row: ControlBoardRow) => string): string {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(key(row), (counts.get(key(row)) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, n]) => `${name} ${n}`)
    .join(" / ");
}

function taskHead(task: string | null): string | null {
  if (!task) return null;
  const first = task.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
  if (!first) return null;
  return first.length > TASK_HEAD_CHARS ? `${first.slice(0, TASK_HEAD_CHARS)}…` : first;
}

function stallLine(row: ControlBoardRow): string {
  const parts = [`- ${row.project} ${row.session_id}`, `状態=${row.followup_state ?? "不明"}`, `変化なし=${row.unchanged_count} 回`];
  const task = taskHead(row.current_task);
  if (task) parts.push(`タスク: ${task}`);
  return parts.join(" / ");
}

export function renderHourlySummary(rows: readonly ControlBoardRow[], nowMs: number): string {
  const header = `🗂️ [管制まとめ] ${formatJst(nowMs)} — 動いているセッション ${rows.length} 件`;
  if (rows.length === 0) return noMention(`${header}\n動いているセッションはありません。`);
  const stalled = rows.filter((row) => row.unchanged_count >= CONTROL_STALL_UNCHANGED_MIN);
  const lines = [
    header,
    `状態別: ${countBy(rows, (row) => row.followup_state ?? "不明")}`,
    `プロジェクト別: ${countBy(rows, (row) => row.project)}`,
    `止まっている (自動確認で ${CONTROL_STALL_UNCHANGED_MIN} 回以上変化なし): ${stalled.length} 件`,
    ...stalled.slice(0, CONTROL_SUMMARY_STALL_LIMIT).map(stallLine),
  ];
  if (stalled.length > CONTROL_SUMMARY_STALL_LIMIT) lines.push(`…ほか ${stalled.length - CONTROL_SUMMARY_STALL_LIMIT} 件`);
  return noMention(lines.join("\n"));
}
