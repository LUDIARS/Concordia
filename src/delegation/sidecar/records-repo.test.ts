import { beforeEach, describe, expect, it } from "vitest";
import { makeTestDb } from "../../../tests/helpers/db.js";
import { SidecarRecordsRepo } from "./records-repo.js";

let repo: SidecarRecordsRepo;

beforeEach(() => {
  repo = new SidecarRecordsRepo(makeTestDb());
});

describe("SidecarRecordsRepo", () => {
  it("records route decisions with the structured input only", () => {
    const row = repo.recordRouteDecision({
      parentSessionId: "parent",
      taskReference: "actio:t",
      requestVersion: 1,
      decision: { route: "sidecar", reason: "bounded_work", uncertainty: "low", source: "deterministic", budgetMinutes: 20, classifierModel: null },
      routeInput: { kind: "ui_tweak", size: "small", acceptanceDefined: true, scopeDefined: true, sensitive: false, openQuestions: false },
      now: 10,
    });
    expect(row).toMatchObject({ parent_session_id: "parent", route: "sidecar", budget_minutes: 20 });
    expect(JSON.parse(row.input_json)).toMatchObject({ kind: "ui_tweak" });
    expect(repo.listRouteDecisions("parent").map((item) => item.id)).toEqual([row.id]);
    expect(repo.listRouteDecisions("other")).toEqual([]);
  });

  it("records allowed, rejected and failed launches newest first", () => {
    repo.recordInvokeEvent({ parentSessionId: "p", requestKey: "k#v1", runId: "r1", outcome: "allowed", code: null, detail: null, now: 1 });
    repo.recordInvokeEvent({ parentSessionId: "p", requestKey: null, runId: null, outcome: "rejected", code: "sidecar_concurrency_limit", detail: "x".repeat(3000), now: 2 });
    const events = repo.listInvokeEvents("p");
    expect(events.map((event) => event.outcome)).toEqual(["rejected", "allowed"]);
    expect(events[0]!.detail).toHaveLength(2000);
  });
});
