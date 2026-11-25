import type { ControlCardView, SessionProgressRow } from "./controlApi.js";

export const sessionStatus: Record<string, string> = {
  working: "作業中", awaiting_result: "結果待ち", human_wait: "人間待ち",
  stalled: "停滞", unresponsive: "応答なし", end_candidate: "終了候補",
};

export function projectCards<T extends Pick<ControlCardView, "project" | "session_id">>(
  cards: readonly T[], project: string, sessions: readonly Pick<SessionProgressRow, "session_id">[],
): T[] {
  const sessionIds = new Set(sessions.map(row => row.session_id));
  return cards.filter(card => card.project === project || (card.session_id !== null && sessionIds.has(card.session_id)));
}

/** 同じプロジェクトで観測できたステップだけを分母とする。 */
export function projectGraph(rows: SessionProgressRow[]) {
  const projects = new Map<string, SessionProgressRow[]>();
  for (const row of rows) {
    const name = row.project?.trim() || "プロジェクト未設定";
    const sessions = projects.get(name) ?? [];
    sessions.push(row);
    projects.set(name, sessions);
  }
  return [...projects].sort(([a], [b]) => a.localeCompare(b, "ja")).map(([name, sessions]) => {
    const counts = new Map<string, number>();
    let total = 0, done = 0, measured = 0;
    for (const row of sessions) {
      const status = sessionStatus[row.status ?? ""] ?? row.status ?? "未分類";
      counts.set(status, (counts.get(status) ?? 0) + 1);
      if (row.progress.steps_total > 0) {
        total += row.progress.steps_total;
        done += row.progress.steps_completed;
        measured++;
      }
    }
    return { name, sessions, counts, total, done, measured, percent: total ? Math.round(100 * done / total) : null };
  });
}
