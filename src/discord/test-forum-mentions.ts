/**
 * 提出セッションを「操作していた」Discord ユーザの解決。
 * session_events の人間 inject (source: "discord:<uid>:…") を走査して重複排除する。
 * @implements spec/feature/revisor-test-forum-sync.md — Source and lifecycle
 */
import { parseInjectSource } from "../shared/inject-source.js";
import type { SessionEventRow } from "../shared/types.js";

/** 走査する event 数。 長寿セッションでも直近の操作者が拾えれば十分。 */
const EVENT_SCAN_LIMIT = 500;

export function collectSessionOperators(events: readonly SessionEventRow[]): string[] {
  const userIds = new Set<string>();
  for (const event of events) {
    if (event.kind !== "inject") continue;
    let source: unknown;
    try {
      source = (JSON.parse(event.payload) as { source?: unknown }).source;
    } catch {
      continue;
    }
    const parsed = parseInjectSource(source);
    if (parsed.platform === "discord" && parsed.userId) userIds.add(parsed.userId);
  }
  return [...userIds];
}

/**
 * 候補群の提出セッション id ごとに操作者を引く。 セッションが見つからない /
 * events が読めない場合は空配列 (メンション無しで掲載する)。
 */
export function resolveSessionMentions(
  recentEvents: (sessionId: string, limit: number) => SessionEventRow[],
  sessionIds: Iterable<string>,
): Map<string, readonly string[]> {
  const mentions = new Map<string, readonly string[]>();
  for (const sessionId of new Set(sessionIds)) {
    try {
      mentions.set(sessionId, collectSessionOperators(recentEvents(sessionId, EVENT_SCAN_LIMIT)));
    } catch {
      mentions.set(sessionId, []);
    }
  }
  return mentions;
}
