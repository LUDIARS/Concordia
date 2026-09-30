import { describe, expect, it } from "vitest";
import type { DelegationRunRow } from "../../db/delegation-repo.js";
import { summarizeSidecarObservation } from "./observation.js";
import type { SidecarInvokeEventRow, SidecarRouteDecisionRow } from "./records-repo.js";

function event(id: number, outcome: SidecarInvokeEventRow["outcome"], runId: string | null, requestKey: string | null, code: string | null = null): SidecarInvokeEventRow {
  return { id, parent_session_id: "p", request_key: requestKey, run_id: runId, outcome, code, detail: null, created_at: id };
}

describe("summarizeSidecarObservation", () => {
  it("counts sidecar children, attempts, rejections and routes without inventing a cost", () => {
    const runs = [
      { id: "r1", status: "completed", created_at: 1_000, finished_at: 4_000 },
      { id: "r2", status: "failed", created_at: 2_000, finished_at: 3_000 },
      { id: "r3", status: "running", created_at: 5_000, finished_at: null },
      { id: "other", status: "completed", created_at: 1, finished_at: 2 },
    ] as DelegationRunRow[];
    const events = [
      event(1, "allowed", "r1", "k#v1"),
      event(2, "allowed", "r2", "k#v1"),
      event(3, "launch_failed", null, "k#v1"),
      event(4, "allowed", "r3", "j#v1"),
      event(5, "rejected", null, null, "sidecar_concurrency_limit"),
    ];
    const routes = [
      { route: "sidecar", reason: "bounded_work", uncertainty: "low" },
      { route: "parent", reason: "classifier_unavailable", uncertainty: "high" },
    ] as SidecarRouteDecisionRow[];
    const summary = summarizeSidecarObservation({ parentSessionId: "p", runs, invokeEvents: events, routeDecisions: routes });
    expect(summary.children).toEqual({
      total: 3,
      by_status: { completed: 1, failed: 1, running: 1 },
      finished: 2,
      median_duration_ms: 2_000,
    });
    expect(summary.requests).toEqual([
      { request_key: "j#v1", attempts: 1, launch_failures: 0 },
      { request_key: "k#v1", attempts: 3, launch_failures: 1 },
    ]);
    expect(summary.rejections).toEqual({ sidecar_concurrency_limit: 1 });
    expect(summary.routes).toEqual({
      total: 2,
      by_route: { sidecar: 1, parent: 1 },
      by_reason: { bounded_work: 1, classifier_unavailable: 1 },
      high_uncertainty: 1,
    });
    expect(summary.cost.status).toBe("not_measured");
  });
});
