import { describe, expect, it, vi } from "vitest";
import { dailyGoalRunRouter } from "./daily-goal-run.js";
import { DailyGoalConflict } from "../daily-goal-run/domain.js";
import type { DailyGoalRunService } from "../daily-goal-run/service.js";

function setup(overrides: Partial<Record<keyof DailyGoalRunService, unknown>> = {}, opts: { enabled?: boolean; local?: boolean } = {}) {
  const service = {
    list: vi.fn(() => [{ id: "g1" }]),
    detail: vi.fn((id: string) => (id === "g1" ? { goal: { id }, checkpoints: [], timeline: [], card: null } : null)),
    reportReached: vi.fn(async () => ({ outcome: "reached" })),
    reportExhausted: vi.fn(() => ({ outcome: "go", doable: ["x"], budgetReset: true })),
    recordReport: vi.fn(),
    ...overrides,
  } as unknown as DailyGoalRunService;
  const app = dailyGoalRunRouter(service, { isEnabled: () => opts.enabled ?? true, localRequest: () => opts.local ?? true, now: () => 5 });
  const post = (path: string, body: unknown) => app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, service, post };
}

describe("daily goal HTTP", () => {
  it("lists and reads goals", async () => {
    const { app } = setup();
    expect(await (await app.request("/?date=2026-10-10")).json()).toEqual({ goals: [{ id: "g1" }] });
    expect((await app.request("/?date=bad")).status).toBe(400);
    expect((await app.request("/g1")).status).toBe(200);
    expect((await app.request("/nope")).status).toBe(404);
  });

  it("accepts reports from the bound session and forwards evidence claims", async () => {
    const { post, service } = setup();
    const res = await post("/g1/reached", { session_id: "s1", evidence: [{ item: "A", refs: ["pr:o#1:merged"] }] });
    expect(await res.json()).toEqual({ outcome: "reached" });
    expect(service.reportReached).toHaveBeenCalledWith("g1", "s1", [{ item: "A", refs: ["pr:o#1:merged"] }], 5);
    const exhausted = await post("/g1/exhausted", { session_id: "s1", remaining: [{ item: "Q", class: "human_judgment", question_id: 3 }, { item: "x", class: "doable" }], report: "残りあり" });
    expect(await exhausted.json()).toMatchObject({ outcome: "go" });
    expect(service.reportExhausted).toHaveBeenCalledWith("g1", "s1", [{ item: "Q", class: "human_judgment", questionId: 3 }, { item: "x", class: "doable" }], 5);
    expect(service.recordReport).toHaveBeenCalledWith("g1", "s1", "残りあり");
    expect((await post("/g1/report", { session_id: "s1", report: "進捗" })).status).toBe(200);
  });

  it("maps a foreign session to 403 and validates bodies", async () => {
    const { post } = setup({ reportExhausted: vi.fn(() => { throw new DailyGoalConflict("not bound", "forbidden"); }) });
    expect((await post("/g1/exhausted", { session_id: "other", remaining: [] })).status).toBe(403);
    expect((await post("/g1/reached", { evidence: [] })).status).toBe(400);
  });

  it("has no route that confirms or stops a goal", async () => {
    const { post } = setup();
    expect((await post("/", { goal: "x" })).status).toBe(404);
    expect((await post("/g1/stop", {})).status).toBe(404);
  });

  it("returns 409 when the workflow is disabled and 403 off loopback", async () => {
    expect((await setup({}, { enabled: false }).app.request("/")).status).toBe(409);
    expect((await setup({}, { local: false }).app.request("/")).status).toBe(403);
  });
});
