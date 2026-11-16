/**
 * セッションの「前回から動いたか / 止まっているか」の基準 (2026-11-16 neco 指示
 * 「自動確認の更新判定も管制と同じようにやって」)。自動確認と管制の両方がこの純関数を使い、
 * 変化あり / なし・止まっているの判定を一致させる。
 *
 * 指紋は Cc が追跡している状態 (state・Actio タスク。ほぼ unknown で空) ではなく、観測された実際の動きから作る:
 *   - 会話: 前回の自動確認以降の人間の入力。自動確認が末尾に見えないほど会話が進んでいれば最終活動時刻。
 *     自動確認への返答だけ (`[変化なし]` や状態の読み直し) は動きに数えない。
 *   - git: HEAD と作業ツリー (status --porcelain) の内容。
 *   - PR・委託の状態。
 *   - サイドチャンネル現況 (stat-collect) の報告時刻。
 * 観測できなかった項目は null のまま指紋に入れる (取得できた回とできない回の差も変化として扱う)。
 *
 * @implements spec/feature/autonomous-work-continuation.md §2
 */
import { createHash } from "node:crypto";

/** 自動確認で動きの無い回がこの数以上続いたら止まっているとみなす (管制の停止判定と共通)。 */
export const ACTIVITY_STALL_UNCHANGED_MIN = 2;

export interface SessionActivityObservation {
  /** conversationActivityMark の結果。 */
  conversation: string | null;
  head: string | null;
  /** 作業ツリーの未コミット変更 (status --porcelain の内容)。変更なしは空文字。 */
  worktree: string | null;
  prs: readonly string[];
  delegations: readonly string[];
  /** サイドチャンネル現況の最終報告時刻 (epoch-sec)。 */
  sideReportedAt: number | null;
}

function digest(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 16);
}

/** 並び順に依存しない観測の指紋。 */
export function activityFingerprint(observation: SessionActivityObservation): string {
  return JSON.stringify({
    conversation: observation.conversation,
    head: observation.head,
    worktree: observation.worktree === null ? null : digest(observation.worktree),
    prs: [...observation.prs].sort(),
    delegations: [...observation.delegations].sort(),
    side: observation.sideReportedAt,
  });
}

interface TailEvent { role: "user" | "assistant" | "tool_result" | undefined; text: string }

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function eventText(event: Record<string, unknown>): string {
  const payload = asRecord(event.payload);
  const message = asRecord(event.message) ?? asRecord(payload?.message);
  const content = event.content ?? message?.content ?? payload?.content ?? payload?.text;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : typeof asRecord(part)?.text === "string" ? String(asRecord(part)!.text) : ""))
    .join("\n");
}

function hasToolResult(event: Record<string, unknown>): boolean {
  const message = asRecord(event.message);
  return Array.isArray(message?.content)
    && (message!.content as unknown[]).some((part) => asRecord(part)?.type === "tool_result");
}

function eventRole(event: Record<string, unknown>): TailEvent["role"] {
  const payload = asRecord(event.payload);
  const message = asRecord(event.message) ?? asRecord(payload?.message);
  if (event.type === "tool_result" || payload?.type === "function_call_output" || hasToolResult(event)) return "tool_result";
  const role = event.role ?? payload?.role ?? message?.role ?? event.type;
  if (role === "user" || role === "assistant") return role;
  if (event.type === "response_item") return "assistant";
  return undefined;
}

function parseTail(tail: string): TailEvent[] {
  const events: TailEvent[] = [];
  for (const line of tail.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = asRecord(JSON.parse(line));
      if (event) events.push({ role: eventRole(event), text: eventText(event) });
    } catch {
      // 途中で切れた行は読まない。
    }
  }
  return events;
}

/**
 * 会話の動きの印。末尾に自動確認 (sentinel で始まる user 発言) があれば、その後の人間の入力だけを数える
 * (自動確認への返答は動きではない)。末尾に自動確認が無ければ、確認を押し流すほど会話が進んだので最終活動時刻を使う。
 */
export function conversationActivityMark(
  tail: string | null, lastActivityMs: number | null, nudgeSentinel: string,
): string | null {
  const events = tail ? parseTail(tail) : [];
  let lastNudge = -1;
  events.forEach((event, index) => {
    if (event.role === "user" && event.text.trimStart().startsWith(nudgeSentinel)) lastNudge = index;
  });
  if (lastNudge < 0) return lastActivityMs === null ? null : `activity:${lastActivityMs}`;
  const human = events.slice(lastNudge + 1)
    .filter((event) => event.role === "user" && event.text.trim() !== "")
    .map((event) => event.text);
  return human.length ? `human:${digest(human.join("\n"))}` : "quiet";
}

export interface ActivityProgress {
  fingerprint: string;
  unchanged_count: number;
  last_checked_at: number;
  last_changed_at: number;
}

/** 前回の記録と比べた次の記録。記録が無ければ変化ありとする。 */
export function classifyActivity(
  previous: ActivityProgress | null, fingerprint: string, nowMs: number,
): ActivityProgress {
  if (previous && previous.fingerprint === fingerprint) {
    return { ...previous, unchanged_count: previous.unchanged_count + 1, last_checked_at: nowMs };
  }
  return { fingerprint, unchanged_count: 0, last_checked_at: nowMs, last_changed_at: nowMs };
}

/** 動きの無い回が続いて止まっているか。 */
export function isActivityStalled(unchangedCount: number, min = ACTIVITY_STALL_UNCHANGED_MIN): boolean {
  return unchangedCount >= min;
}
