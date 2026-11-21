/**
 * 管制チャンネルへ 1 時間に 1 回投げる進捗ボードのまとめ (純関数)。
 * 投稿の要否と本文だけを決め、投稿と最終投稿時刻の保存は runtime が行う。
 *
 * @implements spec/feature/control-session.md §7 §10
 */
import type { ControlBoardRow } from "./board-repo.js";
import type { EndedSessionRecord } from "./ended-log.js";
import { formatJstClock } from "./jst-clock.js";
import type { SessionLinkResolver } from "./session-link.js";
import { SESSION_STATUS_LABEL, SESSION_STATUS_ORDER, type SessionActivityStatus } from "../control/session-classify.js";

export const CONTROL_SUMMARY_INTERVAL_MS = 60 * 60 * 1000;
/**
 * 人が編集する設定ではなく実行時の内部状態なので、設定レジストリの名前空間 (admin. / harness.) の外に置く
 * (src/config/settings/coverage.test.ts はその名前空間のキーを設定として数える)。
 */
export const CONTROL_SUMMARY_POSTED_KEY = "control_session.summary_posted_at";
/** 分類ごとに個別に載せる上限。 */
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

/** 1 件ずつ載せる分類 (停止・応答なし・人間待ち)。 */
const LISTED_STATUSES: readonly SessionActivityStatus[] = ["stalled", "unresponsive", "human_wait"];

/** 分類別の件数を表示順で並べる (0 件の分類も出す)。 */
function countByStatus(rows: readonly ControlBoardRow[]): string {
  const parts = SESSION_STATUS_ORDER.map((status) => `${SESSION_STATUS_LABEL[status]} ${rows.filter((row) => row.status === status).length}`);
  const unclassified = rows.filter((row) => !row.status).length;
  if (unclassified) parts.push(`未分類 ${unclassified}`);
  return parts.join(" / ");
}

function rowLine(row: ControlBoardRow, nowMs: number, linkOf: SessionLinkResolver): string {
  const parts = [`- ${row.project} ${row.session_id}`];
  if (row.last_activity_at !== null) parts.push(`無活動 ${Math.max(0, Math.floor((nowMs / 1000 - row.last_activity_at) / 60))} 分`);
  parts.push(row.status_reason ?? "理由不明");
  if (row.nudge_last_at) parts.push(`直近の追加指示 ${formatJstClock(row.nudge_last_at)} JST`);
  const task = taskHead(row.current_task);
  if (task) parts.push(`タスク: ${task}`);
  // 判断が要るセッションへ飛べるリンク (§10)。山括弧で Discord の埋め込みを抑止する。
  const link = linkOf(row.session_id);
  if (link) parts.push(`<${link}>`);
  return parts.join(" / ");
}

function section(title: string, lines: readonly string[]): string[] {
  if (!lines.length) return [];
  const shown = lines.slice(0, CONTROL_SUMMARY_STALL_LIMIT);
  return [title, ...shown, ...(lines.length > shown.length ? [`…ほか ${lines.length - shown.length} 件`] : [])];
}

function taskHead(task: string | null): string | null {
  if (!task) return null;
  const first = task.split(/\r?\n/).find((l) => l.trim() !== "")?.trim() ?? "";
  if (!first) return null;
  return first.length > TASK_HEAD_CHARS ? `${first.slice(0, TASK_HEAD_CHARS)}…` : first;
}

export function renderHourlySummary(
  rows: readonly ControlBoardRow[], nowMs: number, ended: readonly EndedSessionRecord[] = [],
  linkOf: SessionLinkResolver = () => null,
): string {
  const header = `🗂️ [管制まとめ] ${formatJst(nowMs)} — 動いているセッション ${rows.length} 件`;
  const endedLines = ended.map((record) => `- ${record.project} ${record.session_id} / ${record.reason} / ${formatJstClock(record.ended_at)} JST`);
  if (rows.length === 0) {
    return noMention([header, "動いているセッションはありません。", ...section(`終了したもの: ${ended.length} 件`, endedLines)].join("\n"));
  }
  const lines = [
    header,
    `分類別: ${countByStatus(rows)}`,
    `プロジェクト別: ${countBy(rows, (row) => row.project)}`,
  ];
  for (const status of LISTED_STATUSES) {
    const matched = rows.filter((row) => row.status === status);
    lines.push(...section(`${SESSION_STATUS_LABEL[status]}: ${matched.length} 件`, matched.map((row) => rowLine(row, nowMs, linkOf))));
  }
  lines.push(...section(`終了したもの: ${ended.length} 件`, endedLines));
  return noMention(lines.join("\n"));
}
