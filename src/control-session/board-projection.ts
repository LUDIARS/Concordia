/**
 * セッション行とサイドチャンネルの最新現況から、進捗ボードの 1 行を作る純関数。
 *
 * @implements spec/feature/control-session.md — 2. 進捗ボード / CC-CTL-INV-02
 */
import { readFollowupProgress } from "../control/followup-progress.js";
import { describeNudgeSkip, readNudgeSkip } from "../control/nudge-skip-record.js";
import type { SessionRow } from "../shared/types.js";
import type { ControlBoardEntry } from "./board-repo.js";

const TASK_LIMIT = 160;
const SUMMARY_LIMIT = 240;

function clip(value: string | null | undefined, limit: number): string | null {
  const text = (value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

/** 旧形式 (追跡状態の指紋) の記録から state を取り出す。新形式は記録の state を使う。 */
export function fingerprintState(fingerprint: string | null): string | null {
  if (!fingerprint) return null;
  try {
    const state = (JSON.parse(fingerprint) as Record<string, unknown>).state;
    return typeof state === "string" ? state : null;
  } catch {
    return null;
  }
}

/** stat-collect が案内するキー (recent_work / todos_summary / note) を先に読む。 */
const SUMMARY_KEYS = ["recent_work", "todos_summary", "note", "progress", "summary", "status", "task", "next"] as const;

/** stat-collect の payload (JSON 文字列) から一行の要約を作る。 */
export function summarizeSidePayload(payload: string | null | undefined): string | null {
  if (!payload) return null;
  try {
    const parsed = JSON.parse(payload) as Record<string, unknown>;
    const body = (parsed.payload && typeof parsed.payload === "object" ? parsed.payload : parsed) as Record<string, unknown>;
    const parts = SUMMARY_KEYS
      .map((key) => body[key])
      .filter((value): value is string => typeof value === "string" && value.trim() !== "");
    return clip(parts.length ? parts.join(" / ") : JSON.stringify(body), SUMMARY_LIMIT);
  } catch {
    return clip(payload, SUMMARY_LIMIT);
  }
}

export function projectBoardEntry(input: {
  session: SessionRow;
  project: string;
  sideStat: { ts: number; payload: string } | null;
  lastActivitySec: number | null;
  nowSec: number;
}): ControlBoardEntry {
  const progress = readFollowupProgress(input.session.metadata);
  return {
    session_id: input.session.id,
    project: input.project,
    branch: input.session.branch,
    followup_state: progress?.state ?? fingerprintState(progress?.fingerprint ?? null),
    fingerprint: progress?.fingerprint ?? null,
    unchanged_count: progress?.unchanged_count ?? 0,
    current_task: clip(input.session.current_task, TASK_LIMIT),
    side_summary: summarizeSidePayload(input.sideStat?.payload),
    side_reported_at: input.sideStat?.ts ?? null,
    last_activity_at: input.lastActivitySec,
    last_skip_reason: describeNudgeSkip(readNudgeSkip(input.session.metadata)),
    updated_at: input.nowSec,
  };
}
