/**
 * Sidecar 親子の観測の集計 (純関数)。
 *
 * 完了あたりの費用・初回受入率・手戻りを比較する材料として、子 run の件数・状態・所要時間、
 * 依頼ごとの試行回数、拒否理由、振り分け判定の内訳を返す。 価格の分からない消費を 0 に
 * しない — 費用は計測していない場合 `not_measured` と明示する。
 *
 * @implements spec/feature/astra-with-sidecar.md §費用の根拠と評価
 */

import type { DelegationRunRow } from "../../db/delegation-repo.js";
import type { SidecarInvokeEventRow, SidecarRouteDecisionRow } from "./records-repo.js";

export interface SidecarObservation {
  parent_session_id: string;
  children: {
    total: number;
    by_status: Record<string, number>;
    finished: number;
    /** 終了した子の所要時間 (ms) の中央値。 終了が無ければ null。 */
    median_duration_ms: number | null;
  };
  requests: Array<{ request_key: string; attempts: number; launch_failures: number }>;
  rejections: Record<string, number>;
  routes: {
    total: number;
    by_route: Record<string, number>;
    by_reason: Record<string, number>;
    high_uncertainty: number;
  };
  cost: { status: "not_measured"; note: string };
}

export function summarizeSidecarObservation(input: {
  parentSessionId: string;
  runs: readonly DelegationRunRow[];
  invokeEvents: readonly SidecarInvokeEventRow[];
  routeDecisions: readonly SidecarRouteDecisionRow[];
}): SidecarObservation {
  const allowedRunIds = new Set(input.invokeEvents.filter((event) => event.outcome === "allowed" && event.run_id)
    .map((event) => event.run_id!));
  const children = input.runs.filter((run) => allowedRunIds.has(run.id));
  const byStatus = countBy(children, (run) => run.status);
  const durations = children
    .filter((run) => typeof run.finished_at === "number")
    .map((run) => run.finished_at! - run.created_at)
    .filter((value) => value >= 0)
    .sort((a, b) => a - b);

  const requestMap = new Map<string, { attempts: number; launch_failures: number }>();
  for (const event of input.invokeEvents) {
    if (!event.request_key) continue;
    const entry = requestMap.get(event.request_key) ?? { attempts: 0, launch_failures: 0 };
    if (event.outcome === "allowed" || event.outcome === "launch_failed") entry.attempts += 1;
    if (event.outcome === "launch_failed") entry.launch_failures += 1;
    requestMap.set(event.request_key, entry);
  }

  return {
    parent_session_id: input.parentSessionId,
    children: {
      total: children.length,
      by_status: byStatus,
      finished: durations.length,
      median_duration_ms: median(durations),
    },
    requests: [...requestMap.entries()]
      .map(([requestKey, entry]) => ({ request_key: requestKey, ...entry }))
      .sort((a, b) => a.request_key.localeCompare(b.request_key)),
    rejections: countBy(input.invokeEvents.filter((event) => event.outcome === "rejected"), (event) => event.code ?? "unknown"),
    routes: {
      total: input.routeDecisions.length,
      by_route: countBy(input.routeDecisions, (row) => row.route),
      by_reason: countBy(input.routeDecisions, (row) => row.reason),
      high_uncertainty: input.routeDecisions.filter((row) => row.uncertainty === "high").length,
    },
    cost: {
      status: "not_measured",
      note: "provider の消費記録と response ID 単位の重複排除が未接続のため費用は集計していない (0 ではない)。",
    },
  };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    out[value] = (out[value] ?? 0) + 1;
  }
  return out;
}

function median(sorted: readonly number[]): number | null {
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
}
